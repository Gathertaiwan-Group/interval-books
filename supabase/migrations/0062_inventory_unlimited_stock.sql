-- 0062_inventory_unlimited_stock.sql —— 進銷存品項「不限庫存」旗標（2026-11-19）
--
-- 業主的寄賣品（例：參虎「吃不停 爆紅薏仁」21 個品項）是「不限數量」：廠商隨叫隨補，
-- 店裡不需要也不應該追蹤件數。之前系統沒有這種設定，只能塞一筆 999 的名目進貨，
-- 副作用是進貨金額灌水、盤點出現差異。這一支加一個真正的旗標。
--
-- §1 inv.products.unlimited_stock boolean not null default false
--    CHECK：只有 product_type = 'consignment' 且不是子品項（base_product_id is null）
--    才能開。子品項的庫存掛在母品項上，旗標也要開在母品項（resolve_stock_target 的目標）。
--
-- §2 開啟時的行為（判斷一律看「庫存目標列」，即 coalesce(base_product_id, id)）：
--    · reserve_inventory_stock()：照樣寫保留列（commit 靠保留列決定要不要寫 inv.sales），
--      但不比可售量 → 網站下單不會因庫存不足被擋。
--    · commit_inventory_reservations()：不寫 online_commit 賣超告警。
--    · inv.update_stock_on_sale()（櫃檯單品、套餐、網路入帳都走它）：不擋、不寫
--      pos_override 告警。stock_quantity 照扣（可以變負數）——這樣刪除銷售時
--      rollback_fifo_cost() 加回去的那一側完全不必分支，帳是對稱的。
--    · pos_checkout()：第一遍的可售量檢查略過不限庫存品項。
--    · inv.allocate_fifo_cost()：先照舊吃進貨批次；批次不夠的件數改用目標品項的
--      cost_price 計價（一般品項維持原行為：不夠的部分記 0）。所以銷貨成本、毛利、
--      報表都是品項成本欄，不是 0。
--    · inv_record_stock_count()：不限庫存品項略過（回傳 unlimited_skipped 件數），
--      不產生盤盈／盤損單。在庫異動（報損等）照常允許。
--    · inv_save_product()：payload 帶 unlimited_stock 才改（沒帶＝不變；新增＝false），
--      並先用看得懂的錯誤擋掉非寄賣／子品項。
--    · View：product_availability 對不限庫存目標回 10（與「不追蹤庫存」的商品相同，
--      網站顯示「尚有庫存」不顯示數字；欄位形狀不變）；inv_listing_candidates 允許
--      庫存 0 的不限庫存品項上架；inv_admin_products／inv_listed_products／
--      inv_pos_products／inv_admin_combo_set_items 在最後面加 unlimited_stock 欄；
--      inv_admin_combo_sets 的 max_sets 不把不限庫存品項算進最小值（全部都不限＝100，
--      即 inv_combo_checkout 單次上限），並在最後面加 unlimited_items 欄。
--
-- 函式簽名與回傳型別都不變，所以 create or replace 保留既有權限；view 只在最後面加欄，
-- create or replace view 合法，並明寫 security_invoker=false（replace 會重設 reloptions）。
-- 最後重申一次權限。非不限庫存品項的每一條路徑都與 0061 之前逐字相同。冪等。
begin;

-- §1 ------------------------------------------------------------------------
alter table inv.products
  add column if not exists unlimited_stock boolean not null default false;

alter table inv.products drop constraint if exists products_unlimited_stock_consignment_only;
alter table inv.products
  add constraint products_unlimited_stock_consignment_only
  check (not unlimited_stock or (product_type = 'consignment' and base_product_id is null));

comment on column inv.products.unlimited_stock is
  '不限庫存（0062）：只限寄賣品、非子品項。開啟時下單／櫃檯／套餐不因庫存不足擋下、不寫賣超告警、不進低庫存與盤點；銷貨成本在進貨批次不足時改用 cost_price。';

-- §2 函式 -------------------------------------------------------------------
-- ---------------------------------------------------------------- reserve_inventory_stock
CREATE OR REPLACE FUNCTION public.reserve_inventory_stock(p_order_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row      record;
  v_reserved integer := 0;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_ITEMS';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) e
     where coalesce((e ->> 'quantity')::integer, 0) <= 0
  ) then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- ---- 第一步，永遠是這一步：依 id 排序鎖住所有目標列 --------------------
  -- 排序是防死鎖（兩張訂單含相同兩個品項但順序相反）；FOR UPDATE 是防超賣
  -- （下面那段「讀加總 → 判斷 → 寫入」是 read-modify-write，沒有鎖就會雙雙通過）。
  perform 1
    from inv.products ip
   where ip.id in (
           select t.target_id
             from jsonb_array_elements(p_items) e
             join public.product_inventory_links l
               on l.product_id = (e ->> 'product_id')
             cross join lateral inv.resolve_stock_target(l.inv_product_id) t
         )
   order by ip.id
     for update;

  -- ---- 判斷與寫入 --------------------------------------------------------
  for v_row in
    with need as (
      select t.target_id,
             sum((e ->> 'quantity')::integer * l.units_per_sale * t.multiplier)::integer as qty
        from jsonb_array_elements(p_items) e
        join public.product_inventory_links l
          on l.product_id = (e ->> 'product_id')
        cross join lateral inv.resolve_stock_target(l.inv_product_id) t
       group by t.target_id
    )
    select n.target_id,
           n.qty,
           ip.stock_quantity
             - coalesce((select sum(r.quantity)::integer
                           from public.stock_reservations r
                          where r.inv_product_id = n.target_id), 0) as available,
           ip.unlimited_stock
      from need n
      join inv.products ip on ip.id = n.target_id
     order by n.target_id
  loop
    -- 0062：不限庫存（寄賣）品項照樣寫保留列（commit 靠它決定要不要寫 inv.sales），
    -- 只是不比可售量。
    if not v_row.unlimited_stock and v_row.available < v_row.qty then
      raise exception 'INSUFFICIENT_STOCK:%', v_row.target_id
        using errcode = 'check_violation';
    end if;

    -- 同一張訂單重複呼叫會撞 unique(order_id, inv_product_id) 而 23505。
    -- 那是刻意的：重複呼叫代表呼叫端有 bug（訂單 id 是每次結帳新生的），
    -- 靜默累加會讓同一張訂單押住兩倍的貨。
    insert into public.stock_reservations (order_id, inv_product_id, quantity)
    values (p_order_id, v_row.target_id, v_row.qty);

    v_reserved := v_reserved + 1;
  end loop;

  return v_reserved;
end;
$function$;

-- ---------------------------------------------------------------- commit_inventory_reservations
CREATE OR REPLACE FUNCTION public.commit_inventory_reservations(p_order_id uuid, p_staff_user_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_before   jsonb;
  v_claimed  jsonb;
  v_line     record;
  v_target   record;
  v_stock    integer;
  v_short    integer;
  v_oversold integer := 0;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 第一步，永遠是這一步：依 id 排序鎖住所有目標列 --------------------
  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = p_order_id
         )
   order by ip.id
     for update;

  -- ---- 扣之前的庫存快照（算 shortfall 用，必須在寫 sales 之前拍） --------
  select jsonb_object_agg(ip.id::text, ip.stock_quantity)
    into v_before
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = p_order_id
         );

  -- ---- 冪等 claim：能刪到才算數 ------------------------------------------
  with claimed as (
    delete from public.stock_reservations r
     where r.order_id = p_order_id
    returning r.inv_product_id, r.quantity
  )
  select jsonb_object_agg(c.inv_product_id::text, c.quantity)
    into v_claimed
    from claimed c;

  if v_claimed is null then
    -- 沒有保留列可刪：不是這張訂單沒有實體商品，就是 webhook 重送。
    -- 兩種情況都不該再寫一次 inv.sales。
    return 0;
  end if;

  -- ---- 寫 inv.sales，讓既有 trigger 去扣真正的庫存 -----------------------
  -- ⚠️ 這裡刻意送**原始的** inv 品項 id 與**原始的**數量（只乘 units_per_sale，
  --    不乘 pack_size）。inv.update_stock_on_sale() 會自己再解析一次 base_product_id
  --    與 pack_size —— 我們送已解析的值進去，它會再乘一次，變成扣 pack_size² 倍。
  --    保留 ledger 記解析後的、sales 記解析前的，兩者不是不一致，是各自對應到
  --    各自的讀者。
  for v_line in
    select l.inv_product_id                      as src_product_id,
           (oi.quantity * l.units_per_sale)      as sale_qty,
           oi.unit_price                         as unit_price,
           ip.user_id                            as owner_id,
           ip.name                               as item_name
      from public.order_items oi
      join public.product_inventory_links l on l.product_id = oi.product_id
      join inv.products ip on ip.id = l.inv_product_id
     where oi.order_id = p_order_id
     order by l.inv_product_id
  loop
    -- user_id 是 NOT NULL。網路訂單沒有店員，所以退回「這個品項的擁有者」——
    -- 那是進銷存自己對「這批貨是誰的」的答案，FK 一定成立，而且對報表來說歸屬正確。
    insert into inv.sales (
      user_id, product_id, quantity, unit_price, amount,
      item_name, sale_date, channel, web_order_id, notes
    )
    values (
      coalesce(p_staff_user_id, v_line.owner_id),
      v_line.src_product_id,
      v_line.sale_qty,
      v_line.unit_price,
      v_line.unit_price * v_line.sale_qty,
      v_line.item_name,
      current_date,
      'online',
      p_order_id,
      '網路訂單自動入帳'
    );
  end loop;

  -- ---- 賣超告警 ----------------------------------------------------------
  -- greatest(v_stock, 0)：扣之前就已經是負的話，這次扣的全部都沒有貨在背後。
  for v_target in
    select key::uuid as tid, value::integer as qty from jsonb_each_text(v_claimed)
  loop
    v_stock := (v_before ->> v_target.tid::text)::integer;
    v_short := greatest(0, v_target.qty - greatest(coalesce(v_stock, 0), 0));
    -- 0062：不限庫存品項沒有「賣超」這件事，不寫告警。
    if v_short > 0
       and not coalesce((select ip.unlimited_stock from inv.products ip where ip.id = v_target.tid), false) then
      insert into public.stock_oversold_alerts (order_id, inv_product_id, shortfall, source)
      values (p_order_id, v_target.tid, v_short, 'online_commit');
      v_oversold := v_oversold + 1;
    end if;
  end loop;

  return v_oversold;
end;
$function$;

-- ---------------------------------------------------------------- update_stock_on_sale
CREATE OR REPLACE FUNCTION inv.update_stock_on_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'inv', 'public'
AS $function$
DECLARE
  v_product_type text;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
  v_stock integer;
  v_reserved integer;
  v_available integer;
  v_unlimited boolean;
BEGIN
  -- 二手書：沒有商品列，也就沒有庫存可扣。這一句是真正生效的那個判斷。
  IF NEW.product_id IS NULL OR NEW.is_secondhand = true THEN
    RETURN NEW;
  END IF;

  SELECT product_type, base_product_id, pack_size
  INTO v_product_type, v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = NEW.product_id;

  -- 0009／0011 這裡本來還有一個 `v_product_type = 'secondhand'` 的分支。它從
  -- 來源系統出生那天就進不去（CHECK 只允許 outright/consignment/rental），
  -- 0018 刪掉。商品列不見了還是要早退 —— 那是 FK 的 ON DELETE SET NULL 造出來
  -- 的孤兒列，扣不到庫存。
  IF v_product_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_base_product_id IS NOT NULL THEN
    v_deduct_product_id := v_base_product_id;
    v_deduct_quantity := NEW.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_deduct_product_id := NEW.product_id;
    v_deduct_quantity := NEW.quantity;
  END IF;

  -- ---- 先鎖目標列，再算可售量（同一條規矩） ------------------------------
  -- 套餐走 inv_combo_checkout() 時這一列已經被鎖住了（那支先依 id 排序鎖完
  -- 全部組成品項）。同一個交易再鎖一次是 no-op，不會自我死鎖。
  SELECT stock_quantity, unlimited_stock INTO v_stock, v_unlimited
    FROM inv.products
   WHERE id = v_deduct_product_id
     FOR UPDATE;

  SELECT COALESCE(SUM(r.quantity), 0)::integer INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.inv_product_id = v_deduct_product_id;

  v_available := COALESCE(v_stock, 0) - v_reserved;

  -- 0062：不限庫存（寄賣）品項不擋、不寫賣超告警；庫存照扣（可以變負數），
  -- 讓刪除銷售時 rollback_fifo_cost() 加回去的那一側不必另外分支。
  IF COALESCE(v_unlimited, false) THEN
    NULL;
  ELSIF COALESCE(NEW.channel, 'pos') = 'pos'
     AND COALESCE(NEW.override_reservation, false) = false THEN
    IF v_available < v_deduct_quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_deduct_product_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF COALESCE(NEW.override_reservation, false) = true
        AND v_available < v_deduct_quantity THEN
    -- 逃生門留痕。order_id 是 NULL：櫃檯的強制放行沒有對應的網路訂單。
    INSERT INTO public.stock_oversold_alerts
      (order_id, inv_product_id, shortfall, source, sale_id)
    VALUES
      (NULL, v_deduct_product_id, v_deduct_quantity - v_available, 'pos_override', NEW.id);
  END IF;

  UPDATE inv.products
  SET stock_quantity = stock_quantity - v_deduct_quantity
  WHERE id = v_deduct_product_id;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- allocate_fifo_cost
CREATE OR REPLACE FUNCTION inv.allocate_fifo_cost(p_product_id uuid, p_user_id uuid, p_sale_quantity integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'inv', 'public'
AS $function$
DECLARE
  v_remaining integer;
  v_total_cost numeric := 0;
  v_batch RECORD;
  v_take integer;
  v_base_product_id uuid;
  v_pack_size integer;
  v_actual_product_id uuid;
  v_actual_quantity integer;
  v_unlimited boolean;
  v_target_cost numeric;
BEGIN
  -- Check if product has a base product
  SELECT base_product_id, pack_size 
  INTO v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = p_product_id;
  
  IF v_base_product_id IS NOT NULL THEN
    v_actual_product_id := v_base_product_id;
    v_actual_quantity := p_sale_quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_actual_product_id := p_product_id;
    v_actual_quantity := p_sale_quantity;
  END IF;
  
  v_remaining := v_actual_quantity;
  
  FOR v_batch IN 
    SELECT id, unit_cost, remaining_quantity
    FROM inv.purchases
    WHERE product_id = v_actual_product_id
      AND remaining_quantity > 0
    ORDER BY purchase_date ASC, created_at ASC
  LOOP
    IF v_remaining <= 0 THEN
      EXIT;
    END IF;
    
    v_take := LEAST(v_remaining, v_batch.remaining_quantity);
    v_total_cost := v_total_cost + (v_take * COALESCE(v_batch.unit_cost, 0));
    v_remaining := v_remaining - v_take;
    
    UPDATE inv.purchases
    SET remaining_quantity = remaining_quantity - v_take
    WHERE id = v_batch.id;
  END LOOP;
  
  -- 0062：不限庫存（寄賣）品項沒有足夠的進貨層可以分攤。批次吃完之後剩下的
  -- 件數用品項自己的成本欄（目標品項的 cost_price，單位與 v_remaining 相同）計價，
  -- 而不是像一般品項那樣記 0（一般品項那樣記 0 代表「賣超、成本待補」）。
  IF v_remaining > 0 THEN
    SELECT unlimited_stock, cost_price INTO v_unlimited, v_target_cost
      FROM inv.products WHERE id = v_actual_product_id;
    IF COALESCE(v_unlimited, false) THEN
      v_total_cost := v_total_cost + v_remaining * COALESCE(v_target_cost, 0);
      v_remaining := 0;
    END IF;
  END IF;

  IF p_sale_quantity > 0 THEN
    RETURN v_total_cost / p_sale_quantity;
  ELSE
    RETURN 0;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------- pos_checkout
CREATE OR REPLACE FUNCTION public.pos_checkout(p_user_id uuid, p_items jsonb, p_payment_method_id uuid DEFAULT NULL::uuid, p_sale_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_override_reservation boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'inv'
AS $function$
DECLARE
  v_item        jsonb;
  v_product     record;
  v_target      record;
  v_sale_id     uuid;
  v_sale_ids    uuid[] := '{}';
  v_total_amt   numeric := 0;
  v_total_cost  numeric := 0;
  v_qty         integer;
  v_price       numeric;
  v_cost        numeric;
  v_available   integer;
  v_need        integer;
  v_unlimited   boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'POS_NO_OPERATOR: 結帳必須記錄操作人員';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'POS_EMPTY_CART: 購物車是空的';
  END IF;

  -- ---- 第一遍：驗每一件，並把要扣的目標列依 uuid 排序鎖起來 ---------------
  FOR v_target IN
    SELECT t.target_id, sum(t.need)::integer AS need
      FROM (
        SELECT r.target_id,
               r.multiplier * (i->>'quantity')::integer AS need
          FROM jsonb_array_elements(p_items) AS i
          CROSS JOIN LATERAL inv.resolve_stock_target((i->>'inv_product_id')::uuid) AS r
      ) t
     GROUP BY t.target_id
     ORDER BY t.target_id            -- ← 全域一致的取鎖順序，見上面
  LOOP
    SELECT p.stock_quantity
             - coalesce((SELECT sum(s.quantity)::integer
                           FROM public.stock_reservations s
                          WHERE s.inv_product_id = p.id), 0),
           p.unlimited_stock
      INTO v_available, v_unlimited
      FROM inv.products p
     WHERE p.id = v_target.target_id
       FOR UPDATE;

    v_need := v_target.need;

    -- 0062：不限庫存（寄賣）品項不比可售量。
    IF NOT coalesce(v_unlimited, false)
       AND NOT p_override_reservation AND coalesce(v_available, 0) < v_need THEN
      -- 帶著品名丟出去。'INSUFFICIENT_STOCK:<uuid>' 對店員沒有意義，而這句話
      -- 是他在櫃檯唯一會看到的東西。
      RAISE EXCEPTION 'POS_INSUFFICIENT_STOCK: 「%」可售 % 件，這一車需要 % 件',
        (SELECT name FROM inv.products WHERE id = v_target.target_id),
        greatest(coalesce(v_available, 0), 0), v_need
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- ---- 第二遍：逐件寫 inv.sales，讓既有的兩個 trigger 做事 ----------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty   := (v_item->>'quantity')::integer;
    v_price := (v_item->>'unit_price')::numeric;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'POS_BAD_QUANTITY: 數量必須大於 0';
    END IF;
    -- 來源系統的 parseFloat('') 會讓 NaN 直接寫進 unit_price。這裡擋掉。
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'POS_BAD_PRICE: 單價不能是空的或負數';
    END IF;

    SELECT p.id, p.name, p.product_type, p.is_active, p.approval_status
      INTO v_product
      FROM inv.products p
     WHERE p.id = (v_item->>'inv_product_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'POS_UNKNOWN_PRODUCT: 找不到商品 %', v_item->>'inv_product_id';
    END IF;

    -- 來源系統的 approvedProducts 是死碼（算出來沒人用），所以未審核、已停用的
    -- 商品掃得出來也賣得掉。這裡把那三個條件擋在資料庫，前端漏擋也沒關係。
    IF NOT v_product.is_active THEN
      RAISE EXCEPTION 'POS_PRODUCT_INACTIVE: 「%」已停用，不能販售', v_product.name;
    END IF;
    IF v_product.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'POS_PRODUCT_UNAPPROVED: 「%」還沒通過審核，不能販售', v_product.name;
    END IF;
    IF v_product.product_type = 'rental' THEN
      RAISE EXCEPTION 'POS_PRODUCT_RENTAL: 「%」是租借品，不能販售', v_product.name;
    END IF;

    INSERT INTO inv.sales (
      user_id, product_id, sale_date, quantity, unit_price, amount,
      payment_method_id, notes, channel, override_reservation
    ) VALUES (
      p_user_id, v_product.id, p_sale_date, v_qty, v_price, v_qty * v_price,
      p_payment_method_id, p_notes, 'pos', coalesce(p_override_reservation, false)
    )
    RETURNING id, cost_price INTO v_sale_id, v_cost;

    v_sale_ids   := v_sale_ids || v_sale_id;
    v_total_amt  := v_total_amt + v_qty * v_price;
    v_total_cost := v_total_cost + coalesce(v_cost, 0) * v_qty;
  END LOOP;

  RETURN jsonb_build_object(
    'sale_ids',     to_jsonb(v_sale_ids),
    'total_amount', v_total_amt,
    'total_cost',   v_total_cost,
    -- 逃生門走過的話，trigger 已經在這個交易裡寫好告警了。撈回來讓 UI 當場
    -- 告訴店員「你剛剛賣超了，這件事被記下來了」，而不是等他哪天打開告警頁。
    'oversold', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'inv_product_id', a.inv_product_id,
               'product_name',   (SELECT name FROM inv.products WHERE id = a.inv_product_id),
               'shortfall',      a.shortfall))
        FROM public.stock_oversold_alerts a
       WHERE a.sale_id = ANY (v_sale_ids)
    ), '[]'::jsonb)
  );
END;
$function$;

-- ---------------------------------------------------------------- inv_record_stock_count
CREATE OR REPLACE FUNCTION public.inv_record_stock_count(p_user_id uuid, p_rows jsonb, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'inv'
AS $function$
DECLARE
  v_row      jsonb;
  v_product  uuid;
  v_actual   integer;
  v_stock    integer;
  v_cost     numeric;
  v_diff     integer;
  v_status   text;
  v_created  integer := 0;
  v_skipped  integer := 0;
  v_shrink   integer := 0;
  v_surplus  integer := 0;
  v_reason   text;
  v_notes    text;
  v_date     date;
  v_ids      uuid[] := '{}';
  v_id       uuid;
  v_unlimited boolean;
  v_unlimited_skipped integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'COUNT_EMPTY: 沒有要盤點的商品';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'COUNT_TOO_MANY: 一次最多盤 500 件，請分批';
  END IF;

  v_reason := nullif(btrim(coalesce(p_options ->> 'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'COUNT_NO_REASON: 請選擇盤點差異的原因';
  END IF;

  v_notes := nullif(btrim(coalesce(p_options ->> 'notes', '')), '');
  v_date  := coalesce((p_options ->> 'adjustment_date')::date, CURRENT_DATE);

  -- 同一批的 status 一次算完，不要在迴圈裡每列查一次設定。
  v_status := inv.stock_adjustment_initial_status();

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_product := (v_row ->> 'product_id')::uuid;
    v_actual  := (v_row ->> 'actual_quantity')::integer;

    IF v_product IS NULL THEN
      RAISE EXCEPTION 'COUNT_NO_PRODUCT: 有一列沒有指定商品';
    END IF;
    IF v_actual IS NULL OR v_actual < 0 THEN
      RAISE EXCEPTION 'COUNT_BAD_QUANTITY: 實際盤點數量不可為負數';
    END IF;

    SELECT stock_quantity, cost_price, unlimited_stock INTO v_stock, v_cost, v_unlimited
      FROM inv.products WHERE id = v_product;
    IF v_stock IS NULL THEN
      RAISE EXCEPTION 'COUNT_PRODUCT_NOT_FOUND: 找不到其中一件商品'
        USING ERRCODE = 'no_data_found';
    END IF;

    -- 0062：不限庫存（寄賣）品項不盤點——帳上數字沒有意義，盤出差異只會產生假的
    -- 盤盈／盤損單。略過並回報件數，不當成錯誤擋掉整批。
    IF v_unlimited THEN
      v_unlimited_skipped := v_unlimited_skipped + 1;
      CONTINUE;
    END IF;

    v_diff := v_actual - v_stock;   -- ← 差異在這裡算，不是在瀏覽器

    IF v_diff = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO inv.stock_adjustments (
      user_id, product_id, adjustment_date, category, quantity,
      unit_cost, total_cost, status, reason, notes, stock_before
    ) VALUES (
      p_user_id, v_product, v_date,
      'ADJ',                       -- 盤點固定是 ADJ，與來源一致
      v_diff,
      CASE WHEN v_diff > 0 THEN coalesce(v_cost, 0) ELSE NULL END,
      CASE WHEN v_diff > 0 THEN coalesce(v_cost, 0) * v_diff ELSE NULL END,
      v_status,
      v_reason,
      v_notes,
      v_stock
    )
    RETURNING id INTO v_id;

    v_ids   := v_ids || v_id;
    v_created := v_created + 1;
    IF v_diff < 0 THEN v_shrink := v_shrink + 1; ELSE v_surplus := v_surplus + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'created',        v_created,
    'skipped',        v_skipped,
    'unlimited_skipped', v_unlimited_skipped,
    'shrinkage',      v_shrink,
    'surplus',        v_surplus,
    'status',         v_status,
    'needs_approval', v_status = 'pending_approval',
    'ids',            to_jsonb(v_ids)
  );
END;
$function$;

-- ---------------------------------------------------------------- inv_save_product
CREATE OR REPLACE FUNCTION public.inv_save_product(p_user_id uuid, p_id uuid, p_payload jsonb, p_purchase jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'inv'
AS $function$
DECLARE
  v_id                  uuid;
  v_name                text;
  v_selling             numeric;
  v_cost                numeric;
  v_price_pending       boolean := false;
  v_purchase_created    boolean := false;
  v_old                 record;
  v_price_needs_approval boolean;
  v_unlimited           boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_name := nullif(btrim(coalesce(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NO_NAME: 請輸入商品名稱';
  END IF;

  -- 來源前端 parseFloat('')→NaN 直接寫進 DB 的老問題。這裡把空字串當成「沒填」。
  v_selling := coalesce((p_payload->>'selling_price')::numeric, 0);
  v_cost    := (p_payload->>'cost_price')::numeric;

  IF v_selling < 0 THEN
    RAISE EXCEPTION 'PRODUCT_BAD_PRICE: 售價不可為負數';
  END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN
    RAISE EXCEPTION 'PRODUCT_BAD_COST: 成本不可為負數';
  END IF;

  -- 母品項不能指到自己（自我參照會讓 resolve_stock_target 無限遞迴）。
  IF p_id IS NOT NULL AND (p_payload->>'base_product_id')::uuid = p_id THEN
    RAISE EXCEPTION 'PRODUCT_SELF_BASE: 母品項不能是自己';
  END IF;

  -- 0062：不限庫存。payload 沒帶這個鍵＝不改（新增時＝false）。只允許寄賣品、
  -- 而且不能是子品項（庫存掛在母品項上，旗標也要開在母品項）。資料庫另有 CHECK
  -- 守著，這裡先給一句看得懂的話。
  v_unlimited := (p_payload->>'unlimited_stock')::boolean;
  IF coalesce(v_unlimited, (SELECT unlimited_stock FROM inv.products WHERE id = p_id), false) THEN
    IF coalesce(p_payload->>'product_type', (SELECT product_type FROM inv.products WHERE id = p_id), 'outright') <> 'consignment' THEN
      RAISE EXCEPTION 'PRODUCT_UNLIMITED_CONSIGNMENT_ONLY: 只有寄賣品可以設定不限庫存';
    END IF;
    IF (p_payload->>'base_product_id') IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_UNLIMITED_NO_BASE: 子品項不能設定不限庫存，請改在母品項設定';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    -- ── 新增 ───────────────────────────────────────────────────────────────
    INSERT INTO inv.products (
      user_id, name, issue_number, barcode, category_id, product_type,
      series, publisher, selling_price, cost_price, stock_quantity,
      low_stock_alert, notes, vendor_id, pack_size, base_product_id,
      image_key, is_active, approval_status, unlimited_stock
    ) VALUES (
      p_user_id,
      v_name,
      nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
      nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
      (p_payload->>'category_id')::uuid,
      coalesce(p_payload->>'product_type', 'outright'),
      nullif(btrim(coalesce(p_payload->>'series', '')), ''),
      nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
      v_selling,
      -- 沒有明講成本就用一起建的那筆進貨的單價。來源就是這樣做的（新增表單上
      -- 沒有成本欄位，成本是從「同時建立進貨記錄」那一區帶過來的）。
      coalesce(v_cost, nullif(p_purchase->>'cost_price', '')::numeric, 0),
      0,                                   -- ← 庫存一律從 0 開始，靠進貨加上去
      coalesce((p_payload->>'low_stock_alert')::integer, 5),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      (p_payload->>'vendor_id')::uuid,
      greatest(coalesce((p_payload->>'pack_size')::integer, 1), 1),
      (p_payload->>'base_product_id')::uuid,
      nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
      coalesce((p_payload->>'is_active')::boolean, true),
      inv.initial_approval_status('products'),  -- ← 不是從 payload 拿
      coalesce(v_unlimited, false)
    )
    RETURNING id INTO v_id;

    -- 一起建進貨（庫存由 inv.purchases 的 trigger 加上去，這裡不自己動 stock）
    IF p_purchase IS NOT NULL AND coalesce((p_purchase->>'quantity')::integer, 0) > 0 THEN
      INSERT INTO inv.purchases (
        user_id, product_id, quantity, unit_cost, vendor, purchase_date,
        notes, approval_status
      ) VALUES (
        p_user_id,
        v_id,
        (p_purchase->>'quantity')::integer,
        nullif(p_purchase->>'cost_price', '')::numeric,
        nullif(btrim(coalesce(p_purchase->>'vendor', '')), ''),
        coalesce((p_purchase->>'purchase_date')::date, current_date),
        '新增商品時建立',
        inv.initial_approval_status('purchases')
      );
      v_purchase_created := true;
    END IF;

  ELSE
    -- ── 更新 ───────────────────────────────────────────────────────────────
    SELECT id, cost_price, selling_price, approval_status
      INTO v_old
      FROM inv.products
     WHERE id = p_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
    END IF;

    v_id := p_id;
    v_price_needs_approval :=
      (inv.initial_approval_status('price_changes') = 'pending')
      AND (v_selling IS DISTINCT FROM v_old.selling_price
           OR (v_cost IS NOT NULL AND v_cost IS DISTINCT FROM v_old.cost_price));

    UPDATE inv.products
       SET name            = v_name,
           issue_number    = nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
           barcode         = nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
           category_id     = (p_payload->>'category_id')::uuid,
           product_type    = coalesce(p_payload->>'product_type', product_type),
           series          = nullif(btrim(coalesce(p_payload->>'series', '')), ''),
           publisher       = nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
           low_stock_alert = coalesce((p_payload->>'low_stock_alert')::integer, 5),
           notes           = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
           vendor_id       = (p_payload->>'vendor_id')::uuid,
           pack_size       = greatest(coalesce((p_payload->>'pack_size')::integer, 1), 1),
           base_product_id = (p_payload->>'base_product_id')::uuid,
           image_key       = nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
           unlimited_stock = coalesce(v_unlimited, unlimited_stock),
           -- 價格：要審核就進待審欄位，不要審核就直接生效
           selling_price   = CASE WHEN v_price_needs_approval THEN selling_price ELSE v_selling END,
           cost_price      = CASE WHEN v_price_needs_approval THEN cost_price
                                  ELSE coalesce(v_cost, cost_price) END,
           pending_selling_price = CASE WHEN v_price_needs_approval THEN v_selling ELSE pending_selling_price END,
           pending_cost_price    = CASE WHEN v_price_needs_approval THEN coalesce(v_cost, cost_price) ELSE pending_cost_price END,
           price_change_status        = CASE WHEN v_price_needs_approval THEN 'pending' ELSE price_change_status END,
           price_change_requested_by  = CASE WHEN v_price_needs_approval THEN p_user_id ELSE price_change_requested_by END,
           price_change_requested_at  = CASE WHEN v_price_needs_approval THEN now() ELSE price_change_requested_at END
     WHERE id = p_id;

    v_price_pending := coalesce(v_price_needs_approval, false);
  END IF;

  RETURN jsonb_build_object(
    'id',                v_id,
    'created',           p_id IS NULL,
    'purchase_created',  v_purchase_created,
    'price_change_pending', v_price_pending
  );
END;
$function$;

-- §2 view -------------------------------------------------------------------
create or replace view public.product_availability with (security_invoker = false) as
 SELECT p.id AS product_id,
    (v.units > 0) AS in_stock,
    LEAST(v.units, 10) AS available_capped
   FROM ((((products p
     LEFT JOIN product_inventory_links l ON ((l.product_id = p.id)))
     LEFT JOIN inv.products src ON ((src.id = l.inv_product_id)))
     LEFT JOIN inv.products tgt ON ((tgt.id = COALESCE(src.base_product_id, src.id))))
     CROSS JOIN LATERAL ( SELECT
                CASE
                    -- 0062：不限庫存目標＝跟「不追蹤庫存」的商品一樣回上限 10。
                    WHEN (l.product_id IS NOT NULL AND COALESCE(tgt.unlimited_stock, false)) THEN 10
                    WHEN (l.product_id IS NOT NULL) THEN GREATEST(0, ((COALESCE(tgt.stock_quantity, 0) - COALESCE(( SELECT (sum(r.quantity))::integer AS sum
                       FROM stock_reservations r
                      WHERE (r.inv_product_id = tgt.id)), 0)) / GREATEST((l.units_per_sale *
                    CASE
                        WHEN (src.base_product_id IS NOT NULL) THEN COALESCE(src.pack_size, 1)
                        ELSE 1
                    END), 1)))
                    WHEN (p.product_type = ANY (ARRAY['event'::text, 'journey'::text])) THEN COALESCE(( SELECT max(GREATEST(0, (s.capacity - s.seats_taken))) AS max
                       FROM event_sessions s
                      WHERE ((s.product_id = p.id) AND (s.status = 'open'::text))), 0)
                    WHEN (p.stock IS NOT NULL) THEN GREATEST(0, p.stock)
                    ELSE 10
                END AS units) v)
  WHERE (p.status = 'active'::text);

create or replace view public.inv_listed_products with (security_invoker = false) as
 SELECT p.id AS product_id,
    p.slug,
    p.title,
    p.price,
    p.status,
    l.inv_product_id,
    src.name AS inv_name,
    l.units_per_sale,
    tgt.stock_quantity,
    COALESCE(res.qty, 0) AS reserved,
    GREATEST(0, (tgt.stock_quantity - COALESCE(res.qty, 0))) AS available,
    tgt.unlimited_stock
   FROM ((((product_inventory_links l
     JOIN products p ON ((p.id = l.product_id)))
     JOIN inv.products src ON ((src.id = l.inv_product_id)))
     JOIN inv.products tgt ON ((tgt.id = COALESCE(src.base_product_id, src.id))))
     LEFT JOIN LATERAL ( SELECT (sum(r.quantity))::integer AS qty
           FROM stock_reservations r
          WHERE (r.inv_product_id = tgt.id)) res ON (true));

create or replace view public.inv_admin_products with (security_invoker = false) as
 SELECT p.id AS inv_product_id,
    p.name,
    p.issue_number,
    p.barcode,
    p.series,
    p.publisher,
    p.notes,
    p.image_key,
    p.product_type,
    p.selling_price,
    p.cost_price,
    p.stock_quantity,
    p.low_stock_alert,
    p.pack_size,
    p.is_active,
    p.category_id,
    c.name AS category_name,
    c.icon AS category_icon,
    p.vendor_id,
    v.name AS vendor_name,
    v.short_name AS vendor_short_name,
    p.base_product_id,
    bp.name AS base_product_name,
    p.approval_status,
    p.approved_at,
    approver.name AS approved_by_name,
    p.pending_cost_price,
    p.pending_selling_price,
    p.price_change_status,
    p.price_change_requested_at,
    requester.name AS price_change_requested_by_name,
    p.user_id,
    creator.name AS creator_name,
    p.created_at,
    p.updated_at,
    COALESCE(res.qty, 0) AS reserved,
    GREATEST(0, (p.stock_quantity - COALESCE(res.qty, 0))) AS available,
    link.product_id AS listed_product_id,
    listed.slug AS listed_slug,
    listed.status AS listed_status,
    p.unlimited_stock
   FROM (((((((((inv.products p
     LEFT JOIN inv.categories c ON ((c.id = p.category_id)))
     LEFT JOIN inv.vendors v ON ((v.id = p.vendor_id)))
     LEFT JOIN inv.products bp ON ((bp.id = p.base_product_id)))
     LEFT JOIN inv.profiles creator ON ((creator.user_id = p.user_id)))
     LEFT JOIN inv.profiles approver ON ((approver.user_id = p.approved_by)))
     LEFT JOIN inv.profiles requester ON ((requester.user_id = p.price_change_requested_by)))
     LEFT JOIN LATERAL ( SELECT (sum(s.quantity))::integer AS qty
           FROM stock_reservations s
          WHERE (s.inv_product_id = p.id)) res ON (true))
     LEFT JOIN product_inventory_links link ON ((link.inv_product_id = p.id)))
     LEFT JOIN products listed ON ((listed.id = link.product_id)));

create or replace view public.inv_pos_products with (security_invoker = false) as
 SELECT p.id AS inv_product_id,
    p.name,
    p.barcode,
    p.issue_number,
    p.series,
    p.product_type,
    p.selling_price,
    p.base_product_id,
    r.target_id AS stock_target_id,
    tgt.name AS stock_target_name,
    r.multiplier AS units_per_item,
    tgt.stock_quantity,
    COALESCE(res.qty, 0) AS reserved,
    GREATEST(0, ((tgt.stock_quantity - COALESCE(res.qty, 0)) / r.multiplier)) AS available,
    tgt.unlimited_stock
   FROM (((inv.products p
     CROSS JOIN LATERAL inv.resolve_stock_target(p.id) r(target_id, multiplier))
     JOIN inv.products tgt ON ((tgt.id = r.target_id)))
     LEFT JOIN LATERAL ( SELECT (sum(s.quantity))::integer AS qty
           FROM stock_reservations s
          WHERE (s.inv_product_id = r.target_id)) res ON (true))
  WHERE (p.is_active AND (p.approval_status = 'approved'::text) AND (p.product_type <> 'rental'::text));

create or replace view public.inv_listing_candidates with (security_invoker = false) as
 SELECT id AS inv_product_id,
    name,
    selling_price,
    stock_quantity,
    pack_size,
    barcode,
    unlimited_stock
   FROM inv.products p
  WHERE (is_active AND (approval_status = 'approved'::text)
         AND ((stock_quantity > 0) OR unlimited_stock)          -- 0062：不限庫存可在 0 時上架
         AND (NOT (EXISTS ( SELECT 1
           FROM product_inventory_links l
          WHERE (l.inv_product_id = p.id)))));

create or replace view public.inv_admin_combo_set_items with (security_invoker = false) as
 SELECT i.id AS item_id,
    i.combo_set_id,
    i.product_id,
    i.quantity,
    p.name AS product_name,
    p.issue_number,
    p.series,
    p.product_type,
    COALESCE(p.selling_price, (0)::numeric) AS selling_price,
    p.is_active AS product_active,
    p.base_product_id,
    GREATEST(COALESCE(p.pack_size, 1), 1) AS pack_size,
    COALESCE(base.stock_quantity, p.stock_quantity) AS stock_quantity,
    COALESCE(base.unlimited_stock, p.unlimited_stock) AS unlimited_stock
   FROM ((inv.combo_set_items i
     JOIN inv.products p ON ((p.id = i.product_id)))
     LEFT JOIN inv.products base ON ((base.id = p.base_product_id)));

create or replace view public.inv_admin_combo_sets with (security_invoker = false) as
 SELECT cs.id AS combo_set_id,
    cs.name,
    cs.selling_price,
    cs.is_active,
    cs.notes,
    cs.approval_status,
    cs.approved_at,
    approver.name AS approved_by_name,
    cs.user_id,
    creator.name AS creator_name,
    cs.created_at,
    cs.updated_at,
    COALESCE(items.item_count, 0) AS item_count,
    COALESCE(items.total_list_price, (0)::numeric) AS total_list_price,
        CASE
            WHEN (COALESCE(items.item_count, 0) = 0) THEN NULL::text
            WHEN (COALESCE(items.zero_priced, 0) > 0) THEN 'quantity'::text
            ELSE 'list_price'::text
        END AS allocation_basis,
    COALESCE(items.zero_priced, 0) AS zero_priced_items,
    -- 0062：不限庫存品項不參與最小值；全部都不限＝100（inv_combo_checkout 單次上限）。
    CASE
        WHEN (COALESCE(items.item_count, 0) = 0) THEN NULL::integer
        ELSE COALESCE(items.max_sets, 100)
    END AS max_sets,
    COALESCE(sold.sale_groups, 0) AS sold_sets,
    COALESCE(sold.revenue, (0)::numeric) AS sold_revenue,
    COALESCE(items.unlimited_items, 0) AS unlimited_items
   FROM ((((inv.combo_sets cs
     LEFT JOIN inv.profiles creator ON ((creator.user_id = cs.user_id)))
     LEFT JOIN inv.profiles approver ON ((approver.user_id = cs.approved_by)))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS item_count,
            sum((COALESCE(p.selling_price, (0)::numeric) * (i.quantity)::numeric)) AS total_list_price,
            (count(*) FILTER (WHERE (COALESCE(p.selling_price, (0)::numeric) <= (0)::numeric)))::integer AS zero_priced,
            (min(floor(((GREATEST(COALESCE(base.stock_quantity, p.stock_quantity), 0))::numeric / ((i.quantity *
                CASE
                    WHEN (p.base_product_id IS NULL) THEN 1
                    ELSE GREATEST(COALESCE(p.pack_size, 1), 1)
                END))::numeric))) FILTER (WHERE NOT COALESCE(base.unlimited_stock, p.unlimited_stock, false)))::integer AS max_sets,
            (count(*) FILTER (WHERE COALESCE(base.unlimited_stock, p.unlimited_stock, false)))::integer AS unlimited_items
           FROM ((inv.combo_set_items i
             JOIN inv.products p ON ((p.id = i.product_id)))
             LEFT JOIN inv.products base ON ((base.id = p.base_product_id)))
          WHERE (i.combo_set_id = cs.id)) items ON (true))
     LEFT JOIN LATERAL ( SELECT (count(DISTINCT s.combo_sale_group))::integer AS sale_groups,
            sum(s.amount) AS revenue
           FROM inv.sales s
          WHERE (s.combo_set_id = cs.id)) sold ON (true));

-- §3 權限重申 ---------------------------------------------------------------
revoke all on public.inv_listed_products, public.inv_admin_products, public.inv_pos_products,
              public.inv_listing_candidates, public.inv_admin_combo_set_items,
              public.inv_admin_combo_sets
  from public, anon, authenticated;
grant select on public.inv_listed_products, public.inv_admin_products, public.inv_pos_products,
                public.inv_listing_candidates, public.inv_admin_combo_set_items,
                public.inv_admin_combo_sets
  to service_role;
grant select on public.product_availability to anon, authenticated, service_role;

revoke execute on function public.reserve_inventory_stock(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.commit_inventory_reservations(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) from public, anon, authenticated;
revoke execute on function public.inv_record_stock_count(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.inv_save_product(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function inv.update_stock_on_sale() from public, anon, authenticated;
revoke execute on function inv.allocate_fifo_cost(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_inventory_stock(uuid, jsonb) to service_role;
grant execute on function public.commit_inventory_reservations(uuid, uuid) to service_role;
grant execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) to service_role;
grant execute on function public.inv_record_stock_count(uuid, jsonb, jsonb) to service_role;
grant execute on function public.inv_save_product(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function inv.update_stock_on_sale() to service_role;
grant execute on function inv.allocate_fifo_cost(uuid, uuid, integer) to service_role;

commit;
