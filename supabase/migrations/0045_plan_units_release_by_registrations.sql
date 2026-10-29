-- 0045_plan_units_release_by_registrations.sql
--
-- 0044 的後續修正：票種名額不能再照 order_items.quantity 整份退。
--
-- ── 為什麼有這一支 ───────────────────────────────────────────────────────────
-- 0044 讓 admin_delete_registration() 單筆移除時就先退票種的 units_taken。但另外兩條
-- 「事後回收」的路徑仍照 0036 的寫法，用 order_items.quantity 當退的量：
--   · release_session_seat()（admin_delete_order() 逐 order_item 呼叫它）
--   · expire_unpaid_orders() 第 4d 步（sum(oi.quantity)）
-- 0036 §4／§5 當時說「這條路徑上方案保留與座位保留必定同時成立」——0044 之後這句不再
-- 成立：管理員可以先從名單移除其中幾位（票種已退），訂單之後才被刪或逾期取消，再照
-- quantity 退一次就是**重複退**，units_taken 被低估，前台可能超賣。
--   情境 A：轉帳單買 1 張票種票 → 名單移除這位（-1）→ 3 天後逾期取消又 -1。
--   情境 B：quantity=2、spu=1 → 移除 1 位（-1）→ 刪整張未付款單又照 quantity -2。
-- 套用前已確認正式庫沒有符合這兩種情境的訂單（潛在問題，不需要資料校正）。
--
-- ── 修法：照「這次實際刪掉的報名列數」換算 ─────────────────────────────────
-- 與 0044 同一條公式 ceil(刪前人數/spu) - ceil(刪後人數/spu)。這兩條路徑都是把一個
-- order_item 的報名**全部**刪光（刪後人數 = 0），所以就是 ceil(實際刪掉列數 / spu)：
--   · 沒人被移除過：刪掉 quantity × spu 列 → 退 quantity，與 0036 行為完全相同。
--   · 先移除過幾位：那幾位的單位 0044 已經退了，這裡只退剩下的人佔的單位。
--   · 全部都被移除過：刪掉 0 列 → 退 0。
-- 0036 §3 的窄窗口（reserve_plan_units 成功、reserve_session_seat 失敗）不受影響：那條
-- 路徑由 createOrder() 直接呼叫 release_plan_units(p_units)，本來就不經過這兩支；而且
-- 那時這個 order_item 沒有任何報名列，這兩支算出來也是 0，不會偷別人的名額。
--
-- 鎖順序維持全站固定的「場次先、票種後」，都是 for no key update。
-- expire_unpaid_orders() 的 4c／4d 合成一句：先鎖場次（原 4c 那句逐字保留）、再鎖票種
-- （原 4d 那句搬到 delete 之前），然後在同一句 SQL 裡 DELETE…RETURNING 報名、扣場次、
-- 依刪掉的列數扣票種——票種的退量必須在刪之前／當下數，刪完就數不到了。
-- 其餘步驟（認領、商品庫存、products.seats_taken、進銷存保留、取消訂單、付款嘗試、
-- 回傳）逐字沿用 0036。products.seats_taken 被 0020 的 CHECK
-- products_capacity_moved_to_sessions 綁成 0，第 4 步是必然的 no-op，單筆移除也從來
-- 不扣它，所以沒有雙退問題，原樣保留。
--
-- ── 簽章、形狀、權限 ─────────────────────────────────────────────────────────
-- 兩支的簽章與回傳形狀逐字不變（release_session_seat(bigint) returns integer；
-- expire_unpaid_orders 的 RETURNS TABLE 四欄同 0006／0011／0020／0034／0036），所以用
-- create or replace，不 drop——drop 會斷掉每 5 分鐘那支 pg_cron job。security definer、
-- search_path = public 照舊；grant 照 0036 原樣重申（只 service_role）。
--
-- ── 順手：registration_removal_log 的 identity sequence ─────────────────────
-- 0044 建表時 sequence 從 public schema 的 default ACL 繼承了 anon／authenticated 的
-- rwU（USAGE/SELECT/UPDATE）。表本身已經收回，sequence 也收回，免得 anon 能 setval
-- 把流水號弄亂。寫入只經 security definer（擁有者身分），不需要任何角色有 sequence 權限。
-- 這裡只動這一個 sequence，不改 schema 的 default privileges（同庫還有別的站）。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 先套正式庫再推碼。程式碼沒有改呼叫端。

begin;

-- ---------------------------------------------------------------------------
-- 1. release_session_seat —— 票種照實際刪掉的報名列數退
-- ---------------------------------------------------------------------------
create or replace function public.release_session_seat(p_order_item_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  uuid;
  v_freed    integer := 0;
  v_plan_id  uuid;
  v_spu      integer;
begin
  if p_order_item_id is null then
    return 0;
  end if;

  select r.session_id into v_session
    from public.event_registrations r
   where r.order_item_id = p_order_item_id
   limit 1;

  if v_session is null then
    return 0;
  end if;

  select oi.plan_id into v_plan_id
    from public.order_items oi
   where oi.id = p_order_item_id;

  -- 場次先鎖，票種後鎖——全站固定順序。
  perform 1 from public.event_sessions s where s.id = v_session for no key update;
  if v_plan_id is not null then
    select p.seats_per_unit into v_spu
      from public.event_session_plans p
     where p.id = v_plan_id
       for no key update;
  end if;

  with gone as (
    delete from public.event_registrations r
     where r.order_item_id = p_order_item_id
    returning 1
  )
  select count(*)::integer into v_freed from gone;

  if v_freed > 0 then
    update public.event_sessions s
       set seats_taken = greatest(0, s.seats_taken - v_freed)
     where s.id = v_session;

    -- 0045：退 ceil(實際刪掉列數 / spu)，不是 order_items.quantity。
    if v_plan_id is not null then
      update public.event_session_plans p
         set units_taken = greatest(
               0,
               p.units_taken - ceil(v_freed::numeric / greatest(coalesce(v_spu, 1), 1))::integer
             )
       where p.id = v_plan_id;
    end if;
  end if;

  return v_freed;
exception
  when others then
    return 0;
end;
$$;

comment on function public.release_session_seat(bigint) is
  '回收一個 order_item 佔住的位子與參加者，票種單位照實際刪掉的列數 ceil(n/spu) 退（0045，不再用 quantity）。DELETE…RETURNING 當冪等 claim，第二次回 0。絕不 throw。';

-- ---------------------------------------------------------------------------
-- 2. expire_unpaid_orders —— 4c／4d 合併：票種照實際刪掉的報名列數退
-- ---------------------------------------------------------------------------
create or replace function public.expire_unpaid_orders(
  p_older_than interval default '30 minutes',
  p_limit      integer  default 200
)
returns table (
  expired_id       uuid,
  expired_order_no text,
  restored_stock   integer,
  restored_seats   integer
)
language plpgsql
security definer
set search_path = public
as $$
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
$$;

comment on function public.expire_unpaid_orders(interval, integer) is
  '回收逾時未付款訂單（0006 起；0034 匯款至少 3 天；0036 票種）。0045：票種單位照每個 order_item 實際刪掉的報名列數 ceil(n/spu) 退，不再用 quantity。RETURNS TABLE 形狀不變。';

-- ---------------------------------------------------------------------------
-- 3. 權限 —— 照 0036 原樣重申
-- ---------------------------------------------------------------------------
revoke execute on function public.release_session_seat(bigint) from public;
revoke execute on function public.release_session_seat(bigint) from anon, authenticated;
grant  execute on function public.release_session_seat(bigint) to service_role;
revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. registration_removal_log 的 identity sequence 收回 anon／authenticated
-- ---------------------------------------------------------------------------
revoke all on sequence public.registration_removal_log_id_seq from anon, authenticated;

commit;
