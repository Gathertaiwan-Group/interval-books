-- 0063_vendor_views_unlimited_stock.sql —— 廠商入口／廠商詳情對「不限庫存」的顯示（2026-11-19）
--
-- 0062 讓不限庫存（寄賣不限量）的品項賣出時 stock_quantity 照扣、可以變負數（帳才對稱）。
-- 但有兩個廠商面的讀取路徑 0062 沒有跟著改，驗收時抓到：
--
-- §1 public.inv_vendor_products(uuid)（0019 §7.6，廠商入口「我的商品」）
--    直接回 stock_quantity，廠商看到的是負數。回傳表**尾端**加 unlimited_stock boolean，
--    前端據此顯示「不限量」。其餘欄位、順序、過濾條件（vendor_my_id 推導）、
--    SECURITY DEFINER、search_path 與 0019 逐字相同。
--    ⚠️ RETURNS TABLE 改形狀不能 create or replace（42P13），所以 drop 再 create，
--    然後照 0019 的 $grants$ 重新收權限：revoke public／anon／authenticated，只給 service_role。
--    函式體是 plpgsql，沒有任何 view／函式在 catalog 上依賴它，drop 不會連帶刪東西。
--
-- §2 public.inv_admin_vendor_list（0019 §3，後台廠商列表／詳情）
--    stock_units 原本把該廠商所有品項的 stock_quantity 加總，不限庫存品項的負數會把
--    「庫存件數」拉低甚至變負。改成只加總非不限庫存品項（欄名、型別、位置不變），
--    尾端加 unlimited_product_count（該廠商不限庫存品項數），詳情頁用它註明「另有 N 件不限量」。
--    其餘欄位逐字照抄正式庫 pg_get_viewdef 的定義（與 0019 相同）。
--    create or replace view 只在尾端加欄合法；明寫 security_invoker = false（與 0019 相同，
--    replace 會重設 reloptions）。權限照 0019：revoke anon／authenticated、只給 service_role。
--
-- 沒有碰任何表或其他函式；一般（非不限庫存）品項的 stock_units 數字不變。冪等。
begin;

-- §1 ------------------------------------------------------------------------
drop function if exists public.inv_vendor_products(uuid);

create function public.inv_vendor_products(p_user_id uuid)
returns table (
  inv_product_id   uuid,
  name             text,
  issue_number     text,
  series           text,
  publisher        text,
  barcode          text,
  notes            text,
  image_key        text,
  product_type     text,
  selling_price    numeric,
  stock_quantity   integer,
  pack_size        integer,
  is_active        boolean,
  approval_status  text,
  approved_at      timestamptz,
  submitted_via    text,
  created_at       timestamptz,
  updated_at       timestamptz,
  sold_quantity    integer,
  listed_slug      text,
  listed_status    text,
  unlimited_stock  boolean
)
language plpgsql
stable
security definer
set search_path = public, inv
as $$
DECLARE v_vendor_id uuid;
BEGIN
  v_vendor_id := public.vendor_my_id(p_user_id);

  RETURN QUERY
  SELECT p.id, p.name, p.issue_number, p.series, p.publisher, p.barcode, p.notes,
         p.image_key, p.product_type, p.selling_price, p.stock_quantity, p.pack_size,
         p.is_active, p.approval_status, p.approved_at, p.submitted_via,
         p.created_at, p.updated_at,
         coalesce(s.sold, 0)::integer,
         listed.slug, listed.status,
         p.unlimited_stock
    FROM inv.products p
    LEFT JOIN LATERAL (
      SELECT sum(sa.quantity)::integer AS sold
        FROM inv.sales sa WHERE sa.product_id = p.id
    ) s ON true
    LEFT JOIN public.product_inventory_links link ON link.inv_product_id = p.id
    LEFT JOIN public.products listed ON listed.id = link.product_id
   WHERE p.vendor_id = v_vendor_id
   ORDER BY p.created_at DESC, p.id;
END;
$$;

revoke execute on function public.inv_vendor_products(uuid) from public;
revoke execute on function public.inv_vendor_products(uuid) from anon, authenticated;
grant  execute on function public.inv_vendor_products(uuid) to service_role;

-- §2 ------------------------------------------------------------------------
create or replace view public.inv_admin_vendor_list
with (security_invoker = false) as
select
  v.id                            as vendor_id,
  v.vendor_code                   as vendor_code,
  v.name                          as name,
  v.short_name                    as short_name,
  v.name_en                       as name_en,
  v.entity_type                   as entity_type,
  v.category_id                   as category_id,
  vc.name                         as category_name,
  v.is_consignment                as is_consignment,
  v.is_preferred                  as is_preferred,
  v.status                        as status,
  v.approval_status               as approval_status,
  v.approved_at                   as approved_at,
  approver.name                   as approved_by_name,
  v.phone                         as phone,
  v.email                         as email,
  inv.mask_tail(v.tax_id, 2)      as tax_id_masked,
  inv.mask_tail(v.id_number, 2, 1) as id_number_masked,
  (nullif(btrim(coalesce(v.tax_id, '')), '') is not null)    as has_tax_id,
  (nullif(btrim(coalesce(v.id_number, '')), '') is not null) as has_id_number,
  (nullif(btrim(coalesce(v.foreign_id, '')), '') is not null
   or nullif(btrim(coalesce(v.residence_permit_number, '')), '') is not null) as has_foreign_id,
  v.commission_rate               as commission_rate,
  v.payment_terms                 as payment_terms,
  v.created_at                    as created_at,
  v.updated_at                    as updated_at,
  coalesce(agg.product_count, 0)        as product_count,
  coalesce(agg.active_product_count, 0) as active_product_count,
  coalesce(agg.stock_units, 0)          as stock_units,
  coalesce(pur.purchase_count, 0)       as purchase_count,
  coalesce(bank.bank_account_count, 0)  as bank_account_count,
  coalesce(att.attachment_count, 0)     as attachment_count,
  att.contract_end_date                 as contract_end_date,
  coalesce(vu.portal_account_count, 0)  as portal_account_count,
  coalesce(agg.unlimited_product_count, 0) as unlimited_product_count
from inv.vendors v
left join inv.vendor_categories vc on vc.id = v.category_id
left join inv.profiles approver     on approver.user_id = v.approved_by
left join lateral (
  select count(*)::integer                                          as product_count,
         count(*) filter (where p.is_active)::integer               as active_product_count,
         coalesce(sum(p.stock_quantity) filter (where not p.unlimited_stock), 0)::integer
                                                                    as stock_units,
         count(*) filter (where p.unlimited_stock)::integer         as unlimited_product_count
    from inv.products p
   where p.vendor_id = v.id
) agg on true
left join lateral (
  select count(*)::integer as purchase_count
    from inv.purchases pu
   where pu.vendor_id = v.id
) pur on true
left join lateral (
  select count(*)::integer as bank_account_count
    from inv.vendor_bank_accounts b
   where b.vendor_id = v.id
) bank on true
left join lateral (
  select count(*)::integer as attachment_count,
         max(a.contract_end_date) filter (where a.attachment_type = 'contract' and a.is_current)
           as contract_end_date
    from inv.vendor_attachments a
   where a.vendor_id = v.id
) att on true
left join lateral (
  select count(*)::integer as portal_account_count
    from public.vendor_users u
   where u.vendor_id = v.id and u.is_active
) vu on true;

revoke all on public.inv_admin_vendor_list from public, anon, authenticated;
grant select on public.inv_admin_vendor_list to service_role;

commit;
