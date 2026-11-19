\pset tuples_only on
\pset format unaligned
begin;
\i fixtures.sql
-- 旗標限制
select 'chk_outright', pg_temp.expect_err($$update inv.products set unlimited_stock = true where name='O 買斷'$$, '%products_unlimited_stock_consignment_only%');
select 'save_outright', pg_temp.expect_err($$select public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000f', '{"name":"O 買斷","product_type":"outright","unlimited_stock":true}')$$, 'PRODUCT_UNLIMITED_CONSIGNMENT_ONLY%');
select 'save_child', pg_temp.expect_err($$select public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000e', '{"name":"N","product_type":"consignment","unlimited_stock":true,"base_product_id":"00000000-0000-0000-0000-00000000000d"}')$$, 'PRODUCT_UNLIMITED_NO_BASE%');
select 'save_new_outright', pg_temp.expect_err($$select public.inv_save_product('00000000-0000-0000-0000-0000000000a1', null, '{"name":"X","unlimited_stock":true}')$$, 'PRODUCT_UNLIMITED_CONSIGNMENT_ONLY%');
select 'save_on', (public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000d', '{"name":"U 寄賣","product_type":"consignment","selling_price":200,"unlimited_stock":true}'))->>'id';
select 'flag', unlimited_stock from inv.products where name='U 寄賣';
-- 沒帶旗標的存檔＝不改
select 'save_keep', (public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000d', '{"name":"U 寄賣","product_type":"consignment","selling_price":200}'))->>'id' is not null, (select unlimited_stock from inv.products where name='U 寄賣');
-- 開著旗標改成買斷 → 擋
select 'save_type_change', pg_temp.expect_err($$select public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000d', '{"name":"U 寄賣","product_type":"outright"}')$$, 'PRODUCT_UNLIMITED_CONSIGNMENT_ONLY%');
-- 網站
select 'avail', product_id, in_stock, available_capped from public.product_availability where product_id='t-u';
select 'cand', name, stock_quantity, unlimited_stock from public.inv_listing_candidates where name='U 寄賣';
select 'admin', unlimited_stock, stock_quantity from public.inv_admin_products where name='U 寄賣';
insert into public.orders(id, customer_name, customer_email, customer_phone, subtotal, total) values ('00000000-0000-0000-0000-0000000000b3', 'x', 'x@example.test', '0900', 1000, 1000);
insert into public.order_items(order_id, product_id, name, unit_price, quantity, subtotal, product_type) values ('00000000-0000-0000-0000-0000000000b3', 't-u', '{"zh":"U","en":"U","ja":"U"}', 200, 5, 1000, 'goods');
select 'reserveU', public.reserve_inventory_stock('00000000-0000-0000-0000-0000000000b3', '[{"product_id":"t-u","quantity":5}]');
select 'listed', reserved, unlimited_stock from public.inv_listed_products where product_id='t-u';
select 'commitU', public.commit_inventory_reservations('00000000-0000-0000-0000-0000000000b3');
select 'webcost', quantity, round(cost_price,2), channel from inv.sales where web_order_id='00000000-0000-0000-0000-0000000000b3';
-- 櫃檯
select 'posU', (public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000d","quantity":3,"unit_price":200}]'))->>'total_cost';
select 'pos_view', available, unlimited_stock from public.inv_pos_products where name='U 寄賣';
-- 有真進貨時先吃批次：進 2 @40，再賣 3 → (80+50)/3
insert into inv.purchases(user_id, product_id, quantity, unit_cost, approval_status, purchase_date) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000d', 2, 40, 'approved', '2026-11-03');
select 'mixcost', (public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000d","quantity":3,"unit_price":200}]'))->>'total_cost';
-- 套餐（U + O；O 還有 0 件 → 照樣擋；只有 U → 過）
insert into inv.combo_sets(id, name, user_id, selling_price, approval_status, is_active) values ('00000000-0000-0000-0000-0000000000c2', 'cU', '00000000-0000-0000-0000-0000000000a1', 300, 'approved', true);
insert into inv.combo_set_items(combo_set_id, product_id, quantity) values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000d', 2);
select 'comboview', item_count, max_sets, unlimited_items from public.inv_admin_combo_sets where combo_set_id='00000000-0000-0000-0000-0000000000c2';
select 'comboU', (public.inv_combo_checkout('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 4, current_date))->>'total_cost';
insert into inv.combo_set_items(combo_set_id, product_id, quantity) values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000e', 1);
select 'comboview2', item_count, max_sets, unlimited_items from public.inv_admin_combo_sets where combo_set_id='00000000-0000-0000-0000-0000000000c2';
select 'comboUN', pg_temp.expect_err($$select public.inv_combo_checkout('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 1, current_date)$$, 'INSUFFICIENT_STOCK%');
select 'combo_items', product_name, unlimited_stock from public.inv_admin_combo_set_items where combo_set_id='00000000-0000-0000-0000-0000000000c2' order by 2;
-- 告警
select 'alerts_total', count(*) from public.stock_oversold_alerts;
select 'stockU', stock_quantity from inv.products where name='U 寄賣';
-- 盤點
select 'count', (public.inv_record_stock_count('00000000-0000-0000-0000-0000000000a1', '[{"product_id":"00000000-0000-0000-0000-00000000000d","actual_quantity":0}]', '{"reason":"count_error"}')) - 'ids';
-- 刪一筆櫃檯銷售 → 庫存加回
delete from inv.sales where id = (select id from inv.sales where product_id='00000000-0000-0000-0000-00000000000d' and channel='pos' and combo_set_id is null order by created_at limit 1);
select 'stockU_after_delete', stock_quantity from inv.products where name='U 寄賣';
-- 關掉旗標 → 回到一般行為
update inv.products set unlimited_stock=false where name='U 寄賣';
select 'off_pos', pg_temp.expect_err($$select public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000d","quantity":1,"unit_price":200}]')$$, 'POS_INSUFFICIENT_STOCK%');
rollback;
