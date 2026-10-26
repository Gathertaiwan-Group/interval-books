/**
 * 資料列 → 表單值（2026-10-25 從 _shell.products.tsx 搬出來）。
 *
 * 清單上的快速動作（上下架、改價：先讀最新一列、只改一欄、整列寫回）與三個編輯內頁
 * 用的是同一份轉換，所以放在這裡共用 —— 兩邊各寫一份，遲早會有一邊漏帶一欄，整列寫回
 * 時就把那一欄清掉。
 */
import type {
  CuratedItemFormValues,
  ProductFormValues,
  PublicationFormValues,
} from "@/lib/admin/schemas";
import type { listProducts } from "@/lib/admin/fns/products";
import type { listCuratedItems } from "@/lib/admin/fns/curated";
import type { Publication } from "@/components/admin/products/PublicationForms";

export type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];
export type CuratedItemRow = Awaited<ReturnType<typeof listCuratedItems>>[number];

export function toFormValues(row: ProductRow): ProductFormValues {
  return {
    id: row.id,
    slug: row.slug,
    product_type: row.product_type,
    source_type: row.source_type,
    source_id: row.source_id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    price: row.price,
    compare_at_price: row.compare_at_price,
    stock: row.stock,
    image_key: row.image_key,
    requires_shipping: row.requires_shipping,
    status: row.status,
    sort_order: row.sort_order,
  };
}

export function toPublicationValues(p: Publication): PublicationFormValues {
  // 原樣帶回（null 保持 null），開關只改 is_published 一欄。
  return {
    id: p.id,
    title: p.title,
    publisher: p.publisher,
    intro: p.intro,
    region: p.region,
    issues: p.issues,
    external_url: p.external_url,
    cover_image_key: p.cover_image_key,
    is_published: p.is_published,
    sort_order: p.sort_order,
  };
}

export function toCuratedValues(row: CuratedItemRow): CuratedItemFormValues {
  return {
    id: row.id,
    theme_id: row.theme_id,
    name: row.name,
    note: row.note,
    is_published: row.is_published,
    sort_order: row.sort_order,
    // 一定要帶上：商品頁的上下架開關（_shell.products.tsx）拿這一份整筆回寫，少了這一欄
    // 不會解除連結（undefined＝不動），但帶上才讓「表單看到的」與「存回去的」是同一份。
    product_id: row.product_id ?? null,
  };
}
