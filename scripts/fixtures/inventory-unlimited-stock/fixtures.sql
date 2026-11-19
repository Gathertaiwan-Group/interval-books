-- 共用 fixture（每次在交易裡跑、最後 rollback）
create or replace function pg_temp.expect_err(p_sql text, p_pat text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO_ERROR';
exception when others then
  if sqlerrm like p_pat then return 'OK:' || split_part(sqlerrm, ':', 1); end if;
  return 'WRONG:' || sqlerrm;
end $$;
insert into auth.users(id, email) values ('00000000-0000-0000-0000-0000000000a1', 't@example.test');
insert into inv.profiles(user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'tester');
-- N：一般寄賣（庫存 0）／O：買斷（進貨 2 @30）／U：寄賣（之後開不限，庫存 0，成本 50）
insert into inv.products(id, user_id, name, product_type, cost_price, selling_price, approval_status, low_stock_alert)
values ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000a1', 'N 一般寄賣', 'consignment', 20, 100, 'approved', 5),
       ('00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-0000000000a1', 'O 買斷', 'outright', 30, 120, 'approved', 5),
       ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000a1', 'U 寄賣', 'consignment', 50, 200, 'approved', 5);
insert into inv.purchases(user_id, product_id, quantity, unit_cost, approval_status, purchase_date)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000f', 2, 30, 'approved', '2026-11-01');
insert into public.products(id, slug, product_type, title, summary, description, price, status)
values ('t-n', 't-n', 'goods', '{"zh":"N","en":"N","ja":"N"}', '{"zh":"N","en":"N","ja":"N"}', '{"zh":"N","en":"N","ja":"N"}', 100, 'active'),
       ('t-o', 't-o', 'goods', '{"zh":"O","en":"O","ja":"O"}', '{"zh":"O","en":"O","ja":"O"}', '{"zh":"O","en":"O","ja":"O"}', 120, 'active'),
       ('t-u', 't-u', 'goods', '{"zh":"U","en":"U","ja":"U"}', '{"zh":"U","en":"U","ja":"U"}', '{"zh":"U","en":"U","ja":"U"}', 200, 'active');
insert into public.product_inventory_links(product_id, inv_product_id, units_per_sale)
values ('t-n', '00000000-0000-0000-0000-00000000000e', 1), ('t-o', '00000000-0000-0000-0000-00000000000f', 1), ('t-u', '00000000-0000-0000-0000-00000000000d', 1);
