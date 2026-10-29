-- 0044_registration_removal_plan_units_audit.sql
--
-- 後台「報名名單 → 移除報名」的兩個洞，加一筆已經多算的票種名額校正。
--
-- ── 為什麼有這一支 ───────────────────────────────────────────────────────────
-- `admin_delete_registration()`（0035 §5，9a40bbf，9/4 上線）比票種功能（0036，ba6b04c）
-- 早。它只退場次的 seats_taken，完全不知道 event_session_plans 存在——0036 檔頭 §6
-- 把這件事寫成「範圍之外的已知落差」，之後一直沒補。結果：每在後台移除一位買了票種的
-- 參加者，那個票種的 units_taken 就永久多算一份，前台看起來比實際更滿。
-- 正式庫已經踩到一次：《海的聲音》「入場（含下午茶）」（81fc86e3…）units_taken = 4，
-- 實際有效報名 3 列（IB-202600001200 那一位在後台被移除，位子退了、票種沒退）。
--
-- 另外這支函式只用 `raise log` 記「誰刪的」，Supabase 的 Postgres log 保留期很短、而且
-- 只能到 Dashboard 翻，事後查不到。
--
-- ── §1  admin_delete_registration()：一併退票種名額 ───────────────────────────
-- 簽章與 RETURNS TABLE 形狀逐字不變（deleted boolean, reason text, freed integer），
-- 所以用 create or replace 就好，不需要 drop（drop 會連 grant 一起掉）。
-- security definer、set search_path = ''、grant 都與 0035 相同；§3 照 0035 §6 原樣重申一次。
--
-- 比照 release_session_seat()（0036 §5）：
--   · 票種從 order_items.plan_id 讀（event_registrations 自己沒有 plan_id 欄位）；
--     order_items 是 insert-only，讀它不需要鎖。
--   · 加鎖順序：場次先、票種後，都用 for no key update——全站固定順序（0036 檔頭 §2），
--     與 reserve_plan_units()／release_session_seat()／expire_unpaid_orders() 一致，不會成環。
--   · 下限保護：greatest(0, … - n)。
--   · 退的量：release_session_seat() 一次刪整個 order_item，所以退 quantity 個單位。這裡
--     只刪一列（一個位子），退的單位數 = 「刪之前這個 order_item 還佔幾個單位」減「刪之後
--     還佔幾個單位」，一個單位佔 seats_per_unit 個位子、無條件進位：
--         ceil(n_before / spu) - ceil(n_after / spu)
--     seats_per_unit = 1（正式庫目前全部的票種都是 1）時恆等於 1。seats_per_unit > 1
--     （雙人房）時，移除兩位中的第一位不退、第二位才退 1——那一個單位要到它的位子全空
--     才算空出來。這同時回答了 0036 §6 擱著的「拆單移除其中一位，票種名額該不該還」。
--
-- 順手修的一個小洞：0035 版本先 select、再 delete、再無條件 seats_taken - 1。兩個管理員
-- 同時移除同一列時，第二個的 delete 刪到 0 列，卻照樣扣了一個位子。這一版改成
-- DELETE … RETURNING：沒有真的刪到就回 registration_not_found，什麼都不扣、不記錄。
--
-- ── §2  稽核表 registration_removal_log ───────────────────────────────────────
-- 既有的稽核表都不合用：pii_access_log 記的是「誰看了明文名單」（0021，CHECK 限定動作），
-- mcp_audit_log 記的是 MCP 工具呼叫（0039）。所以新開一張，一次移除一列，由
-- admin_delete_registration() 在同一個交易裡寫入——刪了就一定有紀錄，沒刪就一定沒有。
--   · actor_id：p_actor_id（後台 server fn 傳的是登入管理員的 user id，見
--     src/lib/admin/fns/event-registrations.ts）；沒傳時退回 auth.uid()。不加外鍵，
--     帳號被刪了紀錄也要留著。
--   · registration_id／order_id／order_item_id／session_id／plan_id：被刪那一列當下的值。
--     **都不加外鍵**——報名列本來就刪掉了；訂單日後被 admin_delete_order() 刪掉時，
--     稽核紀錄也不能擋它或被 cascade 掉。
--   · name_initial：參加者姓名去頭尾空白後的第一個字（中文姓名即姓氏）。刻意不存全名、
--     Email、電話——這張表不是名單的備份。
--   · 原本的函式沒有「移除原因」參數，這一支不改簽章，所以沒有這個欄位。
--   · seats_freed／units_freed：這次實際退了幾個位子、幾個票種單位，事後對帳用。
-- 權限：RLS 開、零 policy；anon／authenticated 全收回；service_role 只有 select
-- （寫入只經 security definer 函式，以函式擁有者身分寫）。
--
-- ── §4  一次性校正：只動 81fc86e3-2be5-4c62-a724-35399be3e052 這一個票種 ─────────
-- 用「重算＝實際報名數」的方式，不寫死數字：對這個票種的每一個 order_item，數它現在
-- 還有幾列 event_registrations，換算成單位（與 §1 同一個 ceil(n / spu)），加總。
-- 套用前已用 SELECT 確認：units_taken = 4、重算 = 3（order_item 1590／1594／1595 各 1）。
-- 在別的資料庫（測試庫）上這個 id 不存在，整句是 no-op。鎖順序同 §1：場次先、票種後。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 先套正式庫再推碼。程式碼這一期沒有改呼叫端（RPC 參數與回傳形狀都沒變），所以順序
-- 反過來也不會壞，但照 CLAUDE.md 的規矩走。

begin;

-- ---------------------------------------------------------------------------
-- §2  稽核表（先建，§1 的函式本體會寫它）
-- ---------------------------------------------------------------------------
create table if not exists public.registration_removal_log (
  id              bigint generated always as identity primary key,
  removed_at      timestamptz not null default now(),
  actor_id        uuid,
  registration_id uuid not null,
  order_id        uuid,
  order_item_id   bigint,
  session_id      uuid,
  plan_id         uuid,
  name_initial    text,
  seats_freed     integer not null default 0,
  units_freed     integer not null default 0
);

create index if not exists registration_removal_log_removed_at_idx
  on public.registration_removal_log (removed_at desc);
create index if not exists registration_removal_log_session_idx
  on public.registration_removal_log (session_id);

alter table public.registration_removal_log enable row level security;

revoke all on table public.registration_removal_log from anon, authenticated;
revoke all on table public.registration_removal_log from service_role;
grant select on table public.registration_removal_log to service_role;

-- ---------------------------------------------------------------------------
-- §1  admin_delete_registration —— 一併退票種名額＋寫稽核
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_registration(
  p_registration_id uuid,
  p_actor_id        uuid
)
returns table (
  deleted boolean,
  reason  text,
  freed   integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session    uuid;
  v_item       bigint;
  v_plan_id    uuid;
  v_spu        integer;
  v_gone_id    uuid;
  v_order      uuid;
  v_initial    text;
  v_n_after    integer;
  v_units      integer := 0;
begin
  if p_registration_id is null then
    raise exception 'NULL_REGISTRATION_ID';
  end if;

  select r.session_id, r.order_item_id into v_session, v_item
    from public.event_registrations r
   where r.id = p_registration_id;

  if v_session is null then
    return query select false, 'registration_not_found', 0;
    return;
  end if;

  -- 0044：這位參加者買的是不是一個票種。order_items 是 insert-only，讀它不需要鎖。
  select oi.plan_id into v_plan_id
    from public.order_items oi
   where oi.id = v_item;

  -- 場次先鎖，票種後鎖——與 release_session_seat() 同一個固定順序。
  perform 1 from public.event_sessions s where s.id = v_session for no key update;
  if v_plan_id is not null then
    select p.seats_per_unit into v_spu
      from public.event_session_plans p
     where p.id = v_plan_id
       for no key update;
  end if;

  -- DELETE … RETURNING：真的刪到才扣。併發的第二次移除拿到 0 列，什麼都不動。
  delete from public.event_registrations r
   where r.id = p_registration_id
  returning r.id, r.order_id, left(btrim(r.name), 1)
       into v_gone_id, v_order, v_initial;

  if v_gone_id is null then
    return query select false, 'registration_not_found', 0;
    return;
  end if;

  update public.event_sessions s
     set seats_taken = greatest(0, s.seats_taken - 1)
   where s.id = v_session;

  if v_plan_id is not null then
    select count(*)::integer into v_n_after
      from public.event_registrations r
     where r.order_item_id = v_item;

    v_spu := greatest(coalesce(v_spu, 1), 1);
    v_units := ceil((v_n_after + 1)::numeric / v_spu)::integer
             - ceil(v_n_after::numeric / v_spu)::integer;

    if v_units > 0 then
      update public.event_session_plans p
         set units_taken = greatest(0, p.units_taken - v_units)
       where p.id = v_plan_id;
    end if;
  end if;

  insert into public.registration_removal_log (
    actor_id, registration_id, order_id, order_item_id, session_id, plan_id,
    name_initial, seats_freed, units_freed
  ) values (
    coalesce(p_actor_id, auth.uid()), p_registration_id, v_order, v_item, v_session, v_plan_id,
    nullif(v_initial, ''), 1, v_units
  );

  return query select true, 'deleted', 1;
end;
$$;

comment on function public.admin_delete_registration(uuid, uuid) is
  '移除單筆報名：退 1 個位子，有票種時一併退票種單位（ceil 換算，spu=1 時恆為 1），並寫一列 registration_removal_log（0044）。簽章與回傳形狀同 0035。reason ∈ deleted | registration_not_found。';

-- ---------------------------------------------------------------------------
-- §3  權限 —— 與 0035 §6 相同，原樣重申
-- ---------------------------------------------------------------------------
revoke execute on function public.admin_delete_registration(uuid, uuid) from public;
revoke execute on function public.admin_delete_registration(uuid, uuid) from anon, authenticated;
grant  execute on function public.admin_delete_registration(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- §4  一次性校正：81fc86e3 票種的 units_taken 重算＝實際報名數
-- ---------------------------------------------------------------------------
do $$
declare
  v_plan    constant uuid := '81fc86e3-2be5-4c62-a724-35399be3e052';
  v_session uuid;
  v_spu     integer;
  v_actual  integer;
begin
  select p.session_id into v_session from public.event_session_plans p where p.id = v_plan;
  if v_session is null then
    return;
  end if;

  perform 1 from public.event_sessions s where s.id = v_session for no key update;
  select p.seats_per_unit into v_spu
    from public.event_session_plans p where p.id = v_plan for no key update;
  v_spu := greatest(coalesce(v_spu, 1), 1);

  select coalesce(sum(ceil(x.n::numeric / v_spu)), 0)::integer into v_actual
    from (
      select count(r.id) as n
        from public.order_items oi
        join public.event_registrations r on r.order_item_id = oi.id
       where oi.plan_id = v_plan
       group by oi.id
    ) x;

  update public.event_session_plans p
     set units_taken = v_actual
   where p.id = v_plan
     and p.units_taken is distinct from v_actual;
end $$;

commit;
