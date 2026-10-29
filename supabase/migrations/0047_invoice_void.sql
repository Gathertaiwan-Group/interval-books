-- 0047_invoice_void.sql —— 後台「作廢發票」（業主 2026-10-29）
--
-- ── 在補哪個洞 ──────────────────────────────────────────────────────────────
-- src/server/amego.ts 早就有 voidInvoice()（Amego /json/f0501），但沒有任何呼叫端，後台
-- 也沒有作廢入口；測試單 IB-202600001200 的發票 FN59177150 只能請技術人員處理。
-- 業主選擇做成訂單內頁的一顆按鈕，之後其他發票也用它作廢。
--
-- ── 為什麼要 DDL ────────────────────────────────────────────────────────────
-- 作廢要留下「原因、時間、操作者」。既有的紀錄表都套不上：
--   · order_post_payment_log 的 step CHECK 只允許 invoice/logistics/notify，而且
--     unique(order_id, step) 是開立流程的佔位鎖，混進作廢會干擾 claim。
--   · mcp_audit_log 的 actor_role CHECK 只允許 'mcp'。
--   · registration_removal_log 是報名專用的欄位形狀。
-- 所以直接在發票那一列加三個 nullable 欄位（與 status='voided' 同一列、同一次 update
-- 寫入，不會出現「狀態是作廢、卻找不到是誰作廢的」）。
--
-- ── 併發 ────────────────────────────────────────────────────────────────────
-- 照 src/server/repos/invoices.ts 檔頭的規矩：鎖在資料庫，不在 PostgREST 的兩個請求之間。
--   claim_invoice_void()   for update 鎖住那一列，確認仍是 issued、號碼相符、沒有別人
--                          正在作廢，才把 locked_at 設成 now()。第二個同時按下的請求在
--                          row lock 上排隊，輪到它時看到 locked_at 已設 → 'locked'。
--   finish_invoice_void()  Amego 成功後才呼叫；條件式 update（status='issued' 且號碼相符）。
--   release_invoice_void() Amego 失敗／不確定時清掉 locked_at，DB 其餘欄位一個都不動。
--                          只清「自己那一把」：claim 回傳的 lock_token（= 設下的 locked_at）
--                          必須相符，過期被別人接手之後，舊請求的 finally 不會放掉新請求的鎖。
--
-- locked_at 本來是開立流程的欄位，但開立那一側只在 status='issuing' 時讀它（0007 的
-- claim、reclaim、backlog 三處都是 `status = 'issuing' and locked_at …`），issued 的列
-- 上這個欄位一直是 null，借來當作廢鎖不會被開立流程誤讀。
--
-- 過期（p_stale_after，預設 3 分鐘）的鎖可以被接手：程序在呼叫 Amego 途中被砍掉時，
-- 不能讓這張發票永遠作廢不了。接手後重送作廢，若上一次其實成功了，Amego 會回
-- 3050131（等待作廢），程式碼把它當成功處理（src/lib/invoice-void.ts）。

begin;

alter table public.invoices
  add column if not exists voided_at   timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by   uuid;

-- Amego 的 CancelReason 上限 20 字；空字串不算原因。
alter table public.invoices
  drop constraint if exists invoices_void_reason_len;
alter table public.invoices
  add constraint invoices_void_reason_len
  check (void_reason is null or char_length(btrim(void_reason)) between 1 and 20);

-- 回傳形狀或參數改過就不能 create or replace（RETURNS TABLE 雷），先 drop 讓這支可重跑。
drop function if exists public.claim_invoice_void(uuid, text, interval);
drop function if exists public.finish_invoice_void(uuid, text, text, uuid);
drop function if exists public.release_invoice_void(uuid);
drop function if exists public.release_invoice_void(uuid, timestamptz);

-- ---------------------------------------------------------------------------
-- claim_invoice_void：取得「我可以去打 Amego 作廢」的許可
-- ---------------------------------------------------------------------------
create function public.claim_invoice_void(
  p_order_id       uuid,
  p_invoice_number text,
  p_stale_after    interval default interval '3 minutes'
)
returns table (
  claimed        boolean,
  reason         text,
  invoice_id     uuid,
  order_no       text,
  invoice_number text,
  issued_at      timestamptz,
  total          integer,
  status         text,
  lock_token     timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_no text;
  v_total    integer;
  v_inv      public.invoices%rowtype;
  v_token    timestamptz := clock_timestamp();
begin
  select o.order_no, o.total into v_order_no, v_total
    from public.orders o
   where o.id = p_order_id;
  if not found then
    return query select false, 'order_not_found'::text, null::uuid, null::text, null::text,
                        null::timestamptz, null::integer, null::text, null::timestamptz;
    return;
  end if;

  select * into v_inv
    from public.invoices i
   where i.order_id = p_order_id
   for update;
  if not found then
    return query select false, 'invoice_not_found'::text, null::uuid, v_order_no, null::text,
                        null::timestamptz, v_total, null::text, null::timestamptz;
    return;
  end if;

  if v_inv.status = 'voided' then
    return query select false, 'already_voided'::text, v_inv.id, v_order_no, v_inv.invoice_number,
                        v_inv.issued_at, v_total, v_inv.status, null::timestamptz;
    return;
  end if;

  if v_inv.status <> 'issued' or v_inv.invoice_number is null or v_inv.invoice_number = '' then
    return query select false, 'not_issued'::text, v_inv.id, v_order_no, v_inv.invoice_number,
                        v_inv.issued_at, v_total, v_inv.status, null::timestamptz;
    return;
  end if;

  if v_inv.invoice_number is distinct from p_invoice_number then
    return query select false, 'number_mismatch'::text, v_inv.id, v_order_no, v_inv.invoice_number,
                        v_inv.issued_at, v_total, v_inv.status, null::timestamptz;
    return;
  end if;

  if v_inv.locked_at is not null and v_inv.locked_at > now() - p_stale_after then
    return query select false, 'locked'::text, v_inv.id, v_order_no, v_inv.invoice_number,
                        v_inv.issued_at, v_total, v_inv.status, null::timestamptz;
    return;
  end if;

  update public.invoices i
     set locked_at = v_token
   where i.id = v_inv.id;

  return query select true, 'claimed'::text, v_inv.id, v_order_no, v_inv.invoice_number,
                      v_inv.issued_at, v_total, v_inv.status, v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_invoice_void：Amego 已確認作廢之後才呼叫
-- 回 'voided'（這一次寫入）、'already_voided'（同一個號碼早就是作廢，重送而已）、
-- 'not_issued'（狀態或號碼對不上，沒有寫入）。
-- ---------------------------------------------------------------------------
create function public.finish_invoice_void(
  p_invoice_id     uuid,
  p_invoice_number text,
  p_reason         text,
  p_actor_id       uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_number text;
begin
  update public.invoices i
     set status        = 'voided',
         voided_at     = now(),
         void_reason   = btrim(p_reason),
         voided_by     = p_actor_id,
         locked_at     = null,
         error_message = null
   where i.id = p_invoice_id
     and i.status = 'issued'
     and i.invoice_number = p_invoice_number;
  if found then
    return 'voided';
  end if;

  select i.status, i.invoice_number into v_status, v_number
    from public.invoices i
   where i.id = p_invoice_id;
  if v_status = 'voided' and v_number = p_invoice_number then
    return 'already_voided';
  end if;
  return 'not_issued';
end;
$$;

-- ---------------------------------------------------------------------------
-- release_invoice_void：Amego 失敗或結果不確定時放掉鎖，其餘欄位不動
-- ---------------------------------------------------------------------------
create function public.release_invoice_void(p_invoice_id uuid, p_lock_token timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.invoices i
     set locked_at = null
   where i.id = p_invoice_id
     and i.status = 'issued'
     and i.locked_at = p_lock_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 權限：與 0007 相同，只有 service_role 能呼叫
-- ---------------------------------------------------------------------------
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.claim_invoice_void(uuid, text, interval)',
    'public.finish_invoice_void(uuid, text, text, uuid)',
    'public.release_invoice_void(uuid, timestamptz)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;
