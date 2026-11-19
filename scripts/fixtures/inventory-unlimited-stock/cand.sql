\pset tuples_only on
\pset format unaligned
begin;
\i fixtures.sql
delete from public.product_inventory_links where product_id in ('t-u','t-n');
select 'cand_before', count(*) from public.inv_listing_candidates where name in ('U 寄賣','N 一般寄賣');
update inv.products set unlimited_stock=true where name='U 寄賣';
select 'cand_after', name, stock_quantity, unlimited_stock from public.inv_listing_candidates where name in ('U 寄賣','N 一般寄賣');
rollback;
