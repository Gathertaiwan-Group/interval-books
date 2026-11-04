-- 0056_onsite_payment.sql —— 活動報名結帳的第三種付款方式「現場付款」（業主 2026-11-04）
--
-- 業主：客人先在網站上報名佔位，活動當天在店裡現場繳費（例：/events/20261220 布苔球手作課，
-- 海報上寫「報名請洽店員」）。只給「整車都是活動票券」的結帳；商品與策旅不提供（判準在
-- src/lib/checkout.ts onsiteEligible()，伺服器在 createOrder() 用定價後的品項再判一次）。
--
-- §1 orders.payment_method 的 CHECK 加 'onsite'。
--    值域取自 0034（正式庫目前的定義）：null 或 card/atm/cvs_cod/test_paid/free/transfer。
--    drop if exists + add：重跑安全（冪等）。PG 加 CHECK 會掃一次全表驗證既有列——既有列
--    全部落在舊值域裡，新值域是它的超集，所以不會失敗；orders 是小表，鎖的時間可忽略。
--
-- §2 expire_unpaid_orders() 跳過 payment_method = 'onsite'。
--    現場付款的錢在活動當天才進來，2 小時／3 天的逾時取消會在客人到場之前就把他的位子收走、
--    把報名刪掉——而客人手上拿的是一封「請於活動當天至現場繳費」的確認信。
--    未付款的現場付款單會一直占名額，直到店員在後台「標記已收款」（admin_mark_order_paid，
--    0034，一個字沒動——它本來就保留 payment_method、只看 status/payment_status）或「刪除
--    訂單」（admin_delete_order，0035，照舊退名額）。活動結束後仍未付款的單**沒有任何自動處理**
--    （站上沒有「場次結束後回收未付款訂單」的既有邏輯），留給店家人工處理。
--    函式本體取自 0050（正式庫現行版本），只在候選條件加一行；簽章與 RETURNS TABLE 形狀不變
--    （create or replace），security definer／search_path 不變，重申只 grant service_role。
--
-- 發票：不用動。invoice_backlog()（0028）只看 payment_status = 'paid' and total > 0，不看
-- payment_method——現場付款單在「標記已收款」之前不是 paid，所以不會開發票；標記之後就進 backlog。
--
-- ⚠️ 程式碼不可以早於這支上線：新程式會 insert payment_method = 'onsite'，舊 CHECK 會擋成 23514。
--    先在正式庫套這支，再部署程式。
begin;

-- §1 ------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null
         or payment_method in ('card', 'atm', 'cvs_cod', 'test_paid', 'free', 'transfer', 'onsite'));

comment on column public.orders.payment_method is
  'card＝金流刷卡；atm／cvs_cod＝金流代收；test_paid＝測試；free＝0 元結清（0028）；transfer＝匯款到店家固定帳戶、人工對帳（0034）；onsite＝活動當天現場付款、店員在後台標記已收款（0056）；NULL＝舊的「由店家聯繫付款」。';

-- §2 ------------------------------------------------------------------------
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
         -- 0056：現場付款的未付款訂單不自動取消——錢本來就是活動當天才收（理由見 0056 檔頭 §2）。
         -- is distinct from：payment_method 是 NULL（舊的「由店家聯繫付款」）時照舊回收。
         and o.payment_method is distinct from 'onsite'
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

comment on function public.expire_unpaid_orders(interval, integer) is
  '未付款超過 p_older_than 的訂單：還庫存、還場次名額、刪參加者、取消訂單、關掉未完成的付款嘗試。匯款訂單（transfer）門檻 greatest(p_older_than, 3 days)（0034）；後台電話報名（source = admin_phone，0050）與現場付款（payment_method = onsite，0056）不自動取消。RETURNS TABLE 的形狀自 0006 起逐字未變。';

commit;
