-- 一般品項（N、O）行為快照：migration 前後輸出必須逐字相同
\pset tuples_only on
\pset format unaligned
begin;
\i fixtures.sql
select 'avail', product_id, in_stock, available_capped from public.product_availability where product_id in ('t-n','t-o') order by 1,2;
select 'cand', name, stock_quantity from public.inv_listing_candidates where name in ('N 一般寄賣','O 買斷') order by 2;
select 'reserveN', pg_temp.expect_err($$select public.reserve_inventory_stock('00000000-0000-0000-0000-0000000000b1', '[{"product_id":"t-n","quantity":1}]')$$, 'INSUFFICIENT_STOCK%');
select 'posN', pg_temp.expect_err($$select public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000e","quantity":1,"unit_price":100}]')$$, 'POS_INSUFFICIENT_STOCK%');
select 'posO2', (public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000f","quantity":2,"unit_price":120}]'))->>'total_cost';
select 'posO1more', pg_temp.expect_err($$select public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000f","quantity":1,"unit_price":120}]')$$, 'POS_INSUFFICIENT_STOCK%');
select 'posO_override', (public.pos_checkout('00000000-0000-0000-0000-0000000000a1', '[{"inv_product_id":"00000000-0000-0000-0000-00000000000f","quantity":1,"unit_price":120}]', null, current_date, null, true))->'oversold'->0->>'shortfall';
select 'stockO', stock_quantity from inv.products where name='O 買斷';
select 'costO', quantity, cost_price from inv.sales where product_id='00000000-0000-0000-0000-00000000000f' order by created_at, quantity desc;
-- 網路：O 補貨 3 再保留 2、commit
insert into inv.purchases(user_id, product_id, quantity, unit_cost, approval_status, purchase_date) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000f', 3, 35, 'approved', '2026-11-02');
insert into public.orders(id, customer_name, customer_email, customer_phone, subtotal, total) values ('00000000-0000-0000-0000-0000000000b2', 'x', 'x@example.test', '0900', 240, 240);
insert into public.order_items(order_id, product_id, name, unit_price, quantity, subtotal, product_type) values ('00000000-0000-0000-0000-0000000000b2', 't-o', '{"zh":"O","en":"O","ja":"O"}', 120, 2, 240, 'goods');
select 'reserveO', public.reserve_inventory_stock('00000000-0000-0000-0000-0000000000b2', '[{"product_id":"t-o","quantity":2}]');
select 'commitO', public.commit_inventory_reservations('00000000-0000-0000-0000-0000000000b2');
select 'alerts', source, shortfall from public.stock_oversold_alerts order by 2,3;
-- 盤點 N、O
select 'count', (public.inv_record_stock_count('00000000-0000-0000-0000-0000000000a1', '[{"product_id":"00000000-0000-0000-0000-00000000000e","actual_quantity":0},{"product_id":"00000000-0000-0000-0000-00000000000f","actual_quantity":5}]', '{"reason":"count_error"}')) - 'ids' - 'unlimited_skipped';
-- 套餐 N（庫存 0）→ 擋
insert into inv.combo_sets(id, name, user_id, selling_price, approval_status, is_active) values ('00000000-0000-0000-0000-0000000000c1', 'cN', '00000000-0000-0000-0000-0000000000a1', 100, 'approved', true);
insert into inv.combo_set_items(combo_set_id, product_id, quantity) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000e', 1);
select 'comboN', pg_temp.expect_err($$select public.inv_combo_checkout('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 1, current_date)$$, 'INSUFFICIENT_STOCK%');
select 'comboview', item_count, max_sets from public.inv_admin_combo_sets where combo_set_id='00000000-0000-0000-0000-0000000000c1';
-- 存檔：一般商品
select 'save', (public.inv_save_product('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000e', '{"name":"N 一般寄賣","product_type":"consignment","selling_price":100}')) ->> 'created';
rollback;
