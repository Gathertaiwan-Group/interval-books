-- 0058_roster_includes_onsite_unpaid.sql —— 現場付款、還沒付錢的人也在簽到表上（業主 2026-11-04）
--
-- 業主：現場付款（payment_method = 'onsite'，0056）的客人在活動當天才付錢，但他們**一定會來**——
-- 簽到名單、CSV 匯出都要有他們（標「未收款（現場付款）」），報名成功信與行前提醒信也要寄
-- （信裡加一句「尚未付款，請於當天現場繳費 NT$x」）。其他付款方式的未付款者照舊不包含。
--
-- ── 為什麼改 view，不是在三個地方各自加條件 ───────────────────────────────
-- 「誰在簽到表上」只定義在 admin_event_roster.on_roster（0021 §3）：名單頁、CSV、提醒信
-- （loadPaidRoster）與報名成功信（enqueue_registration_emails 的 join）全部讀它。改這一個
-- 地方，四個出口一起變；各自加條件就會出現「有人收到提醒卻不在簽到表上」。
--
-- on_roster 新定義：
--     o.payment_status = 'paid'                                   （與 0021 逐字相同）
--  or (o.payment_method = 'onsite' and o.status = 'pending')       （0058：現場付款、未取消）
-- 已取消的現場付款單（status = 'cancelled'）不在名單上。onsite 已付清的走第一條。
--
-- 另外在**最後面**加兩欄（create or replace view 只能往後加，既有欄位名稱、順序、型別不動）：
--   onsite_unpaid   這一列是「現場付款、還沒付錢」——名單與 CSV 標「未收款（現場付款）」、
--                   信裡印繳費提醒都看它。
--   order_total     所屬訂單的總額——信裡的「NT$x」。
--
-- 權限：與 0021 相同，只給 service_role（重申）。security_invoker = false 照舊。
begin;

create or replace view public.admin_event_roster
with (security_invoker = false) as
select
  r.id            as registration_id,
  r.session_id    as session_id,
  r.order_id      as order_id,
  r.order_item_id as order_item_id,
  r.seat_no       as seat_no,
  r.name          as name,
  inv.mask_email(r.email) as email_masked,
  inv.mask_tail(r.phone, 4) as phone_masked,
  (nullif(btrim(coalesce(r.email, '')), '') is not null) as has_email,
  (nullif(btrim(coalesce(r.phone, '')), '') is not null) as has_phone,
  r.notice_ack_at as notice_ack_at,
  r.created_at    as created_at,
  o.order_no       as order_no,
  o.payment_status as payment_status,
  o.paid_at        as paid_at,
  (o.payment_status = 'paid'
   or (o.payment_method = 'onsite' and o.status = 'pending')) as on_roster,
  (o.payment_method = 'onsite' and o.status = 'pending'
   and o.payment_status <> 'paid') as onsite_unpaid,
  o.total          as order_total
from public.event_registrations r
join public.orders o on o.id = r.order_id;

comment on column public.admin_event_roster.on_roster is
  '這一列算不算在簽到表上：訂單已付款，或現場付款（onsite）且未取消（0058）。畫面、CSV、提醒信、報名成功信共用這一個定義。';
comment on column public.admin_event_roster.onsite_unpaid is
  '0058：現場付款、還沒付錢、也沒取消。名單與 CSV 標「未收款（現場付款）」，信裡印繳費提醒。';
comment on column public.admin_event_roster.order_total is
  '0058：所屬訂單的總額（信裡「請於當天現場繳費 NT$x」的 x）。';

revoke all    on public.admin_event_roster from anon, authenticated;
grant  select on public.admin_event_roster to service_role;

commit;
