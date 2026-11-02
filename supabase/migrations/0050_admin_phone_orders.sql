-- 0050_admin_phone_orders.sql —— 後台「新增電話報名」
--
-- 業主（2026-11-02）：「有些活動客人會打電話進來直接匯款跟完成報名，但網站上會沒有紀錄。」
-- 後台要能把這類報名補成正式的訂單＋報名紀錄：占名額（照舊經 reserve_session_seat）、
-- 進名單、計入營收、收到款後自動開發票（照舊經 admin_mark_order_paid → invoice_backlog）。
--
-- §1 orders 加六欄，全部有 default 或 nullable —— 部署前的舊程式 insert 不帶這幾欄也照常。
--    source            'web'（預設，前台結帳）／'admin_phone'（後台電話報名）
--    created_by        建立這張單的管理員（auth.users.id，只由 server fn 從 session 寫入）
--    admin_note        內部備註（只在後台與店家通知信顯示，不給客人看）
--    price_override_reason  手動改價的原因（改價才有；改價金額本身存在 orders.discount）
--    notify_customer   要不要寄任何信給客人。預設 true；只有電話報名可以是 false（CHECK）。
--    remittance_paid_on  電話報名「已收到匯款」時填的匯款日期
--
-- §2 enqueue_order_email／enqueue_registration_emails 加 `o.notify_customer` 條件：
--    客人的付款成功信、匯款資訊信、出貨信、每位參加者的報名成功信與活動前提醒信，全部只
--    有這兩個入口。在資料庫這一層擋，notify backlog 重跑、提醒信排程都繞不過去。
--    店家通知信（enqueue_admin_order_email）不受影響。函式本體取自正式庫 pg_get_functiondef，
--    只加上述條件；簽章與回傳形狀不變（create or replace），security definer／search_path 不變。
--
-- §3 expire_unpaid_orders() 跳過 source = 'admin_phone'：電話報名的客人匯款可能比網路下單慢，
--    而這張單是店員親手建的、知道客人是誰——3 天自動取消會在客人匯款途中把他的位子收走。
--    未付款的電話報名單會一直占名額，直到店家「標記已收款」或在訂單內頁「刪除訂單」
--    （admin_delete_order，0035，照舊退名額）。函式本體取自正式庫，只加一行條件。
--
-- 權限：orders 沿用表層級（只有 service_role）；三支函式重申只 grant service_role。
begin;

alter table public.orders
  add column if not exists source text not null default 'web',
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists admin_note text,
  add column if not exists price_override_reason text,
  add column if not exists notify_customer boolean not null default true,
  add column if not exists remittance_paid_on date;

alter table public.orders
  drop constraint if exists orders_source_check,
  add constraint orders_source_check check (source in ('web', 'admin_phone')),
  drop constraint if exists orders_admin_note_len,
  add constraint orders_admin_note_len check (admin_note is null or char_length(admin_note) <= 1000),
  drop constraint if exists orders_price_override_reason_len,
  add constraint orders_price_override_reason_len check (
    price_override_reason is null or char_length(btrim(price_override_reason)) between 1 and 200
  ),
  drop constraint if exists orders_notify_customer_web,
  add constraint orders_notify_customer_web check (notify_customer or source = 'admin_phone');

create index if not exists orders_admin_phone_idx
  on public.orders (created_at desc)
  where source = 'admin_phone';

comment on column public.orders.source is
  '0050：訂單來源。web＝前台結帳；admin_phone＝後台「新增電話報名」。';
comment on column public.orders.created_by is
  '0050：後台電話報名時建立這張單的管理員（auth.users.id）。前台訂單為 NULL。';
comment on column public.orders.admin_note is
  '0050：內部備註，只在後台與店家通知信顯示。';
comment on column public.orders.price_override_reason is
  '0050：電話報名手動改價的原因。改價差額記在 orders.discount（發票上是一列「折扣」）。';
comment on column public.orders.notify_customer is
  '0050：false＝這張訂單不寄任何信給客人（enqueue_order_email／enqueue_registration_emails 會擋）。只有 admin_phone 可以是 false。';
comment on column public.orders.remittance_paid_on is
  '0050：電話報名「已收到匯款」時店家填的匯款日期。';

-- §2 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_order_email(p_order_id uuid, p_dedupe_key text, p_subject text, p_body_text text, p_body_html text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ok boolean;
begin
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' then
    raise exception 'EMPTY_DEDUPE_KEY';
  end if;

  insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
  select p_dedupe_key, o.customer_email, p_subject,
         coalesce(p_body_text, ''), coalesce(p_body_html, '')
    from public.orders o
   where o.id = p_order_id
     and nullif(btrim(coalesce(o.customer_email, '')), '') is not null
     -- 0050：後台電話報名時沒勾「寄報名成功信給客人」→ 這張訂單一封客人信都不排。
     and o.notify_customer
  on conflict (dedupe_key) do nothing
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_registration_emails(p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'ITEMS_NOT_ARRAY';
  end if;

  with inserted as (
    insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
    select i.dedupe_key, r.email, i.subject,
           coalesce(i.body_text, ''), coalesce(i.body_html, '')
      from jsonb_to_recordset(p_items) as i(
             registration_id uuid,
             dedupe_key      text,
             subject         text,
             body_text       text,
             body_html       text
           )
      join public.admin_event_roster v on v.registration_id = i.registration_id
      join public.event_registrations r on r.id = i.registration_id
      -- 0050：同上，報名成功信與活動前提醒信都經過這裡。
      join public.orders o on o.id = r.order_id
     where v.on_roster
       and o.notify_customer
       and nullif(btrim(coalesce(r.email, '')), '') is not null
       and nullif(btrim(coalesce(i.dedupe_key, '')), '') is not null
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;

  return coalesce(v_count, 0);
end;
$function$;

-- §3 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_unpaid_orders(p_older_than interval DEFAULT '00:30:00'::interval, p_limit integer DEFAULT 200)
 RETURNS TABLE(expired_id uuid, expired_order_no text, restored_stock integer, restored_seats integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'INVALID_LIMIT:%', p_limit;
  end if;
  if p_older_than is null or p_older_than < interval '0' then
    raise exception 'INVALID_INTERVAL:%', p_older_than;
  end if;

  -- ---- 1. claim the candidates ------------------------------------------
  -- 0034：匯款訂單至少留 3 天，門檻取 greatest(p_older_than, 3 天)——這一支
  -- 逐字沿用，一個字不改。
  select array_agg(c.id)
    into v_ids
    from (
      select o.id
        from public.orders o
       where o.status = 'pending'
         and o.payment_status <> 'paid'
         and o.paid_at is null
         -- 0050：後台電話報名的未付款訂單不自動取消（理由見檔頭 §3）。
         and o.source <> 'admin_phone'
         and o.created_at < now() - (case when o.payment_method = 'transfer'
                                          then greatest(p_older_than, interval '3 days')
                                          else p_older_than end)
       order by o.created_at
       limit p_limit
         for update skip locked
    ) c;

  if v_ids is null or cardinality(v_ids) = 0 then
    return;
  end if;

  -- ---- 2. lock the products, in id order --------------------------------
  perform 1
    from public.products p
   where p.id in (
           select oi.product_id
             from public.order_items oi
            where oi.order_id = any(v_ids)
              and oi.product_id is not null
         )
   order by p.id
     for update;

  -- ---- 3. give the goods back -------------------------------------------
  update public.products p
     set stock = p.stock + agg.qty
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('goods', 'book')
       group by oi.product_id
    ) agg
   where p.id = agg.pid
     and p.stock is not null;

  -- ---- 4. give the seats back -------------------------------------------
  -- 0020 之後這一句是必然的 no-op（products.seats_taken 被 CHECK 綁成 0），
  -- 逐字保留。
  update public.products p
     set seats_taken = greatest(0, p.seats_taken - agg.qty)
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('event', 'journey')
       group by oi.product_id
    ) agg
   where p.id = agg.pid;

  -- ---- 4b. 放掉進銷存的保留（0011）---------------------------------------
  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = any(v_ids)
         )
   order by ip.id
     for update;

  delete from public.stock_reservations r
   where r.order_id = any(v_ids);

  -- ---- 4c. 放掉場次名額與參加者＋4d. 票種名額（0045 合併）------------------
  -- 先鎖場次（0020 那句逐字保留），再鎖票種（0036 那句搬到 delete 之前）——場次先、
  -- 票種後。然後同一句 SQL：刪報名、扣場次、依每個 order_item 實際刪掉的列數扣票種
  -- ceil(n / spu)。不再用 sum(order_items.quantity)：管理員先移除過的人，0044 已經退過了。
  perform 1
    from public.event_sessions s
   where s.id in (
           select r.session_id
             from public.event_registrations r
            where r.order_id = any(v_ids)
         )
   order by s.id
     for no key update;

  perform 1
    from public.event_session_plans p
   where p.id in (
           select oi.plan_id
             from public.order_items oi
            where oi.order_id = any(v_ids)
              and oi.plan_id is not null
         )
   order by p.id
     for no key update;

  with freed as (
    delete from public.event_registrations r
     where r.order_id = any(v_ids)
    returning r.session_id, r.order_item_id
  ), seat_agg as (
    select session_id, count(*)::integer as n from freed group by session_id
  ), seats_upd as (
    update public.event_sessions s
       set seats_taken = greatest(0, s.seats_taken - seat_agg.n)
      from seat_agg
     where s.id = seat_agg.session_id
    returning 1
  ), item_agg as (
    select order_item_id, count(*)::integer as n from freed group by order_item_id
  ), plan_agg as (
    select oi.plan_id as pid,
           sum(ceil(item_agg.n::numeric / greatest(esp.seats_per_unit, 1)))::integer as units
      from item_agg
      join public.order_items oi on oi.id = item_agg.order_item_id
      join public.event_session_plans esp on esp.id = oi.plan_id
     group by oi.plan_id
  )
  update public.event_session_plans p
     set units_taken = greatest(0, p.units_taken - plan_agg.units)
    from plan_agg
   where p.id = plan_agg.pid;

  -- ---- 5. cancel the orders ---------------------------------------------
  update public.orders o
     set status         = 'cancelled',
         payment_status = case
                            when o.payment_status = 'pending' then 'failed'
                            else o.payment_status
                          end,
         cancelled_at   = now(),
         failed_reason  = 'unpaid_timeout'
   where o.id = any(v_ids)
     and o.status = 'pending'
     and o.payment_status <> 'paid'
     and o.paid_at is null;

  -- ---- 6. close out the payment attempts ---------------------------------
  update public.payments pay
     set status = 'failed'
   where pay.order_id = any(v_ids)
     and pay.status = 'pending';

  -- ---- 7. report what happened -------------------------------------------
  return query
    select o.id,
           o.order_no,
           coalesce((
             select sum(oi.quantity)::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
              where oi.order_id = o.id
                and oi.product_type in ('goods', 'book')
                and pr.stock is not null
           ), 0),
           -- 0036：座位數是 quantity × seats_per_unit，不是 quantity 本身
           -- （沒有方案的行 left join 不到，coalesce 落回 1，逐字沿用舊行為）。
           -- restored_seats 這個名字說的是位子，不是單位，漏乘會低報雙人房
           -- 這類方案實際還了幾個位子——雖然目前沒有任何呼叫端讀這個回傳值，
           -- 但它是這支函式對外唯一的「還了多少」證詞，值必須是對的。
           coalesce((
             select sum(oi.quantity * coalesce(esp.seats_per_unit, 1))::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
               left join public.event_session_plans esp on esp.id = oi.plan_id
              where oi.order_id = o.id
                and oi.product_type in ('event', 'journey')
           ), 0)
      from public.orders o
     where o.id = any(v_ids)
       and o.status = 'cancelled'
     order by o.order_no;
end;
$function$;

revoke all on function public.expire_unpaid_orders(interval, integer) from public, anon, authenticated;
grant execute on function public.expire_unpaid_orders(interval, integer) to service_role;
revoke all on function public.enqueue_order_email(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_order_email(uuid, text, text, text, text) to service_role;
revoke all on function public.enqueue_registration_emails(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_registration_emails(jsonb) to service_role;

commit;
