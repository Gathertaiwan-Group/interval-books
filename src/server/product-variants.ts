/**
 * 商品頁「規格切換」的讀取（service role）。規則與資料格式見 src/lib/product-variants.ts。
 *
 * 為什麼用 service role：分組欄位 series／規格 issue_number 在 inv.products，anon 連
 * inv schema 的 USAGE 都沒有。這裡只回**已上架（listed_status='active'）而且進銷存
 * 啟用中**的兄弟品項的 public.products id／slug 與規格字串，沒有價格、成本、庫存。
 *
 * 讀不到就回 []（商品頁照常，只是沒有切換鈕）——但一定 console.warn，不靜默。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { VariantSource } from "@/lib/product-variants";

/** 一組最多讀幾件。超過的組不是「規格」，是整個品牌；切換鈕也排不下。 */
export const MAX_VARIANTS = 60;

function warn(message: string): void {
  console.warn(`[shop] variants unavailable — ${message}`);
}

export async function readProductVariants(productId: string): Promise<VariantSource[]> {
  const db = supabaseAdmin();
  const { data: mine, error: mineError } = await db
    .from("inv_admin_products")
    .select("series")
    .eq("listed_product_id", productId)
    .maybeSingle();
  if (mineError) {
    warn(mineError.message);
    return [];
  }
  const series = typeof mine?.series === "string" ? mine.series.trim() : "";
  if (!series) return [];

  const { data, error } = await db
    .from("inv_admin_products")
    .select("listed_product_id, listed_slug, issue_number, series, created_at")
    .eq("series", series)
    .eq("is_active", true)
    .eq("listed_status", "active")
    .not("listed_product_id", "is", null)
    .order("created_at", { ascending: true })
    .order("inv_product_id", { ascending: true })
    .limit(MAX_VARIANTS);
  if (error) {
    warn(error.message);
    return [];
  }
  const rows = (data ?? []) as Record<string, unknown>[];
  const out: VariantSource[] = [];
  for (const r of rows) {
    // eq("series") 在資料庫是完全相等；trim 過的值也要一致（防前後空白的兩件被併在一起）。
    if (typeof r.series !== "string" || r.series.trim() !== series) continue;
    if (typeof r.listed_product_id !== "string" || typeof r.listed_slug !== "string") continue;
    out.push({
      productId: r.listed_product_id,
      slug: r.listed_slug,
      spec: typeof r.issue_number === "string" ? r.issue_number : null,
    });
  }
  return out;
}
