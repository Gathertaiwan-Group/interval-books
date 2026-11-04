-- 0059_roster_ticket_price.sql —— 現場付款的繳費提醒改寫「這位參加者自己的票價」（審查 2026-11-05）
--
-- 0058 讓報名成功信／行前提醒信寫「尚未付款，請於當天現場繳費 NT$x」，x 用的是 order_total
-- （整張訂單的總額）。多人訂單裡每一位參加者都收到「請繳 NT$整張單」——三個人的單，三封信
-- 加起來看起來像要繳三倍。改成：
--   · 每封信寫這位參加者自己的票價 ticket_price；
--   · 同一張單有多人（或多個場次）時，再補一句「本訂單共 N 位、合計 NT$total」；
--   · 行前提醒只算**該場次**：session_order_participants／session_order_amount。
--
-- ── ticket_price 怎麼算 ─────────────────────────────────────────────────────
-- 一位參加者對應一個 order_item（event_registrations.order_item_id）。order_items.unit_price
-- 是「一個單位」的價格；有票種方案時一個單位可能佔多個座位（event_session_plans.seats_per_unit，
-- 0036，例如雙人票），所以每位的票價 = unit_price ÷ seats_per_unit（沒有方案視同 1），四捨五入
-- 到整數元。沒有方案的單：就是 unit_price 本身。
--
-- 只在最後面加四欄（create or replace view 只能往後加；0058 的十八欄名稱、順序、型別、on_roster
-- 的定義一個字不動）。權限照舊：只給 service_role。security_invoker = false 照舊。冪等。
--
-- 順帶更正：0057 檔頭寫的 src/lib/admin/fns/orders.ts 是錯的——markOnsiteOrderPaidStaff 在
-- src/lib/admin/fns/onsite-collect.ts。0057 已套用、規約不准改既有 migration，所以更正寫在這裡。
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
  o.total          as order_total,
  round(oi.unit_price::numeric / greatest(coalesce(esp.seats_per_unit, 1), 1))::integer
                   as ticket_price,
  (count(*) over (partition by r.order_id))::integer as order_participants,
  (count(*) over (partition by r.order_id, r.session_id))::integer as session_order_participants,
  (sum(round(oi.unit_price::numeric / greatest(coalesce(esp.seats_per_unit, 1), 1)))
     over (partition by r.order_id, r.session_id))::integer as session_order_amount
from public.event_registrations r
join public.orders o on o.id = r.order_id
left join public.order_items oi on oi.id = r.order_item_id
left join public.event_session_plans esp on esp.id = oi.plan_id;

comment on column public.admin_event_roster.ticket_price is
  '0059：這位參加者自己的票價（所屬 order_item 的 unit_price ÷ 票種 seats_per_unit，四捨五入）。現場付款繳費提醒用。';
comment on column public.admin_event_roster.order_participants is
  '0059：同一張訂單的參加者人數（所有場次）。';
comment on column public.admin_event_roster.session_order_participants is
  '0059：同一張訂單在這個場次的參加者人數。行前提醒用。';
comment on column public.admin_event_roster.session_order_amount is
  '0059：同一張訂單在這個場次的票價合計。行前提醒用。';

revoke all    on public.admin_event_roster from anon, authenticated;
grant  select on public.admin_event_roster to service_role;

commit;
