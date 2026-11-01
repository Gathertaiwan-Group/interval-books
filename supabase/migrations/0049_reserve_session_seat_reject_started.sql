-- 0049_reserve_session_seat_reject_started.sql
--
-- 場次已經開始（或結束）就不收新訂單 —— 資料庫這一道（縱深防禦）。
--
-- ── 為什麼有這一支 ───────────────────────────────────────────────────────────
-- 活動頁在活動結束後拿掉了報名入口（EventEndedNotice），但結帳流程本身不檢查場次
-- 時間：手動組出 /checkout?product=…&session=… 就能下單、付款、佔名額。第一道擋在
-- src/server/repos/orders.ts 的 priceLines()（伺服器時間，isSessionClosedForBooking），
-- 這一支是握著場次列鎖的第二道，跟「名額」同一個分工（priceLines 先便宜地擋、
-- reserve_session_seat 第 ⑤ 步才算數）。
--
-- ── 規則 ─────────────────────────────────────────────────────────────────────
-- 新增第 ④b 步：event_sessions.starts_at <= now() → raise 'SESSION_STARTED:<id>'。
-- 以「場次開始」為界，不是 ends_at、也不是活動頁用的「隔天才算結束」（那是給列表
-- 用的日粒度規則，理由寫在 isSessionClosedForBooking() 的檔頭）。now() 是 DB 時間。
--
-- ── 誰會被這一步擋到 ─────────────────────────────────────────────────────────
-- reserve_session_seat() 的呼叫端只有一個：createOrder()（建立**新**訂單的 step 5）。
-- 付款回呼（PayUni／黑貓）、補付款 reissuePayment()、匯款確認、後台改狀態、
-- settle_free_order()、expire_unpaid_orders()、release_session_seat()、
-- admin_delete_registration()（0044）都不呼叫它 —— 已經成立的訂單在場次開始之後
-- 付款確認照常成功。正式庫裡 prosrc 提到這個名字的另外兩支（reserve_plan_units、
-- admin_upsert_event_with_session）只在註解裡提到，沒有呼叫。
--
-- ── 與 0036／0044／0045 的交互 ───────────────────────────────────────────────
-- · 0036 §3 的窄窗口：createOrder() 先打 reserve_plan_units() 再打這一支。這一步
--   raise 時，createOrder() 照既有路徑呼叫 release_plan_units(p_units) 把剛保留的
--   票種單位退回（與 NO_SEATS_LEFT 同一條路），這一支本身在 raise 之前沒有寫任何
--   東西（④b 在 ⑥ 佔位、⑦ 寫參加者之前），交易整個回滾。
-- · 0044／0045 改的是 admin_delete_registration、release_session_seat、
--   expire_unpaid_orders 的「退」，這一支是「佔」，沒有共用狀態；鎖順序（場次先、
--   票種後，for no key update）不變。
--
-- ── 簽章、形狀、權限 ─────────────────────────────────────────────────────────
-- 簽章與回傳形狀逐字不變（5 個參數，returns integer），所以用 create or replace，
-- 不 drop。函式本體是從正式庫 pg_get_functiondef() 取出（= 0020 版本），只加了
-- v_starts_at 變數、select 多讀 starts_at、第 ④b 步。security definer、
-- search_path = public 照舊；grant 照 0020 原樣重申（只 service_role）。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 先套正式庫再推碼。舊程式碼遇到 SESSION_STARTED 會落到 order_failed（訂單照樣不成立），
-- 所以先套 migration 是安全的。

begin;

create or replace function public.reserve_session_seat(
  p_order_id       uuid,
  p_order_item_id  bigint,
  p_session_id     uuid,
  p_quantity       integer,
  p_participants   jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_capacity        integer;
  v_taken           integer;
  v_status          text;
  v_starts_at       timestamptz;
  v_session_product text;
  v_item_product    text;
  v_item_order      uuid;
  v_inserted        integer;
begin
  -- ---- ① 數量與參加者筆數必須相等 ---------------------------------------
  -- 放在最前面而不是最後面：它一個字都還沒寫，所以「數量對不上」這件事永遠不會
  -- 留下半套資料。自檢有一條專門驗這個（seats_taken 完全不變、registrations 0 列）。
  if p_order_id is null or p_order_item_id is null or p_session_id is null then
    raise exception 'MISSING_ARGUMENT' using errcode = 'check_violation';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY:%', p_quantity using errcode = 'check_violation';
  end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'PARTICIPANTS_NOT_ARRAY' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_participants) <> p_quantity then
    raise exception 'PARTICIPANT_COUNT_MISMATCH:% vs %',
      jsonb_array_length(p_participants), p_quantity
      using errcode = 'check_violation';
  end if;

  -- ---- ② 鎖場次 ----------------------------------------------------------
  -- 「讀 seats_taken → 判斷夠不夠 → 寫回」是典型的 read-modify-write，兩個併發
  -- 請求都讀到「還有 1 個」就會雙雙通過。行鎖讓第二個請求必須等第一個 commit
  -- 之後才讀得到 seats_taken，於是它讀到的是新的事實。同 0004 的
  -- atomic_deduct_stock / reserve_product_seat。
  --
  -- 先把**這張訂單會碰到的所有場次**依 id 排序鎖起來，再鎖目標那一列。見檔頭 §2
  -- 的兩個 ⚠️：排序是為了不要求呼叫端記得排序，for no key update 是為了不要與
  -- order_items 外鍵取的 FOR KEY SHARE 互相升級成死鎖。
  perform 1
    from public.event_sessions s
   where s.id in (
           select oi.session_id
             from public.order_items oi
            where oi.order_id = p_order_id
              and oi.session_id is not null
         )
   order by s.id
     for no key update;

  select s.capacity, s.seats_taken, s.status, s.product_id, s.starts_at
    into v_capacity, v_taken, v_status, v_session_product, v_starts_at
    from public.event_sessions s
   where s.id = p_session_id
     for no key update;
  if not found then
    raise exception 'SESSION_NOT_FOUND:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ③ 這個位子真的屬於這張訂單、這件商品 ------------------------------
  -- ⚠️ 不可省。session_id 是**瀏覽器送上來的**，所以「付 A 商品的錢、訂 B 場次的
  --    位子」在加了這個欄位之後才變成可能。這一步就是那個新攻擊面的門。
  select oi.product_id, oi.order_id
    into v_item_product, v_item_order
    from public.order_items oi
   where oi.id = p_order_item_id;
  if not found then
    raise exception 'ORDER_ITEM_NOT_FOUND:%', p_order_item_id using errcode = 'check_violation';
  end if;
  if v_item_order is distinct from p_order_id then
    raise exception 'ORDER_ITEM_ORDER_MISMATCH:%', p_order_item_id using errcode = 'check_violation';
  end if;
  if v_item_product is distinct from v_session_product then
    raise exception 'SESSION_PRODUCT_MISMATCH:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ④ 場次要開著 ------------------------------------------------------
  if v_status <> 'open' then
    raise exception 'SESSION_NOT_OPEN:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ④b 場次還沒開始（0049）--------------------------------------------
  -- 場次開始的那一刻起不收新訂單。now() 是資料庫的時間（交易開始時刻），不是任何
  -- 呼叫端傳來的值。規則與 src/lib/event-status.ts 的 isSessionClosedForBooking()
  -- 逐字對應：starts_at <= now 就拒絕。starts_at 是 NOT NULL，is distinct from 只是
  -- 防呆（null 時一樣拒絕，fail closed）。
  -- 錯誤字串 SESSION_STARTED 由 orders.ts 對成 CheckoutError("session_ended")。
  if v_starts_at is null or v_starts_at <= now() then
    raise exception 'SESSION_STARTED:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ⑤ 超額 -----------------------------------------------------------
  -- 沿用 0004 就在用的字串 NO_SEATS_LEFT，所以 src/lib/checkout.ts 的錯誤碼
  -- （no_seats_left）與那三語文案一個字都不用動。
  if v_taken + p_quantity > v_capacity then
    raise exception 'NO_SEATS_LEFT:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ⑥ 佔位 -----------------------------------------------------------
  -- 相對更新（+= q）而不是寫回讀到的值：後者就是超賣。行鎖已經拿在手上，所以
  -- 這一句與 ⑤ 之間沒有別人插得進來。
  update public.event_sessions
     set seats_taken = seats_taken + p_quantity
   where id = p_session_id;

  -- ---- ⑦ 寫參加者 --------------------------------------------------------
  -- with ordinality 給的就是 seat_no：客人在表單上填的順序 = 名單上的順序。
  -- 空字串一律轉 null，讓「沒填」與「填了空白」在名單頁上長得一樣。
  insert into public.event_registrations
    (session_id, order_id, order_item_id, seat_no, name, email, phone, notice_ack_at)
  select p_session_id,
         p_order_id,
         p_order_item_id,
         e.ord::integer,
         btrim(coalesce(e.value ->> 'name', '')),
         nullif(btrim(coalesce(e.value ->> 'email', '')), ''),
         nullif(btrim(coalesce(e.value ->> 'phone', '')), ''),
         case when coalesce(e.value ->> 'noticeAck', '') in ('true', 't', '1')
              then now() else null end
    from jsonb_array_elements(p_participants) with ordinality as e(value, ord);

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$function$;

comment on function public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb) is
  '佔位與寫參加者的同一句 SQL。固定順序，第 ③ 步擋「付 A 商品的錢、訂 B 場次的位子」，第 ④b 步（0049）擋已經開始的場次。回傳寫入的 registrations 列數。';

revoke execute on function public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb) from public;
revoke execute on function public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb) from anon, authenticated;
grant  execute on function public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb) to service_role;

commit;
