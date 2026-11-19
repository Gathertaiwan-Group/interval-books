/**
 * 上架 —— 把進銷存的一個品項變成店面型錄上的一件商品。
 *
 * ── 這一層存在的理由 ────────────────────────────────────────────────────
 * inv 這個 schema 不在 PostgREST 的 db_schema 裡（0009 的頭一段解釋了為什麼：
 * inv.vendors 有身分證字號與銀行帳戶）。所以連 service_role 的 supabase-js
 * client 都**打不到** inv.* —— 不是權限問題，是那些表根本沒有被掛出來。
 *
 * 於是進銷存的讀寫只有一條路：service_role 呼叫 SECURITY DEFINER 的函式，或者
 * 走一個 public 底下的 view。這個檔案用後者裡最小的那一種：0011 建的
 * public.inv_listing_candidates，只暴露上架這件事需要的六個欄位。
 *
 * ── 兩邊的資料形狀不一樣，而分界線就在這裡 ──────────────────────────────
 * 進銷存的 name 是**單語 text**，價格是 numeric。型錄的 title/summary/description
 * 是**三語 jsonb**，價格是整數元。這不是可以自動轉換的差異 —— 沒有人能從
 * 「紅烏龍茶餅」自動生出可以放在英文站上的商品名。
 *
 * 所以上架必然是一個「人要坐下來補資料」的動作，而不是一個同步任務。這也正是
 * 為什麼 LocalizedField 只出現在上架頁：它就是庫存與型錄的分界線。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

/** 進銷存端可上架的品項（尚未上架的）。 */
export type InventoryCandidate = {
  inv_product_id: string;
  name: string;
  selling_price: number;
  stock_quantity: number;
  pack_size: number;
  barcode: string | null;
  /** 0062：不限庫存（寄賣不限量）——庫存 0 也在候選清單裡。 */
  unlimited_stock: boolean;
};

/** 已經上架的商品，型錄端與庫存端的數字並排。 */
export type ListedInventoryProduct = {
  product_id: string;
  slug: string;
  title: Localized;
  price: number;
  status: string;
  inv_product_id: string;
  inv_name: string;
  units_per_sale: number;
  stock_quantity: number;
  reserved: number;
  available: number;
  /** 0062：庫存目標是不限庫存。開著時 available 沒有意義，畫面顯示「不限量」。 */
  unlimited_stock: boolean;
};

export type ListingInput = {
  inv_product_id: string;
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  price: number;
  units_per_sale: number;
  product_type: "goods" | "book";
  status: "draft" | "active";
  /**
   * 選填。上架頁自己不填（那一頁沒有圖片欄位），但地方刊物那一頁有現成的封面 ——
   * 讓它一併帶進來，才不會出現「展覽頁看得到封面、商品頁是預設圖」這種落差。
   */
  image_key?: string | null;
};

/**
 * 還沒上架、而且真的賣得動的品項。
 *
 * 三個條件（is_active / approval_status='approved' / stock_quantity>0）是進銷存
 * 自己對「這個品項現在可以賣」的定義，照抄過來而不是重新發明一套。
 */
export async function listInventoryCandidates(): Promise<InventoryCandidate[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_listing_candidates")
    .select(
      "inv_product_id, name, selling_price, stock_quantity, pack_size, barcode, unlimited_stock",
    )
    .order("name", { ascending: true })
    .limit(2000);

  if (error) throw new Error(`[repo/inventory-listing] 候選清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as InventoryCandidate[];
}

/** 已上架清單。可售量是 view 算好的，這裡不重算。 */
export async function listListedInventoryProducts(): Promise<ListedInventoryProduct[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_listed_products")
    .select(
      "product_id, slug, title, price, status, inv_product_id, inv_name, units_per_sale, stock_quantity, reserved, available, unlimited_stock",
    )
    .order("slug", { ascending: true });

  if (error) throw new Error(`[repo/inventory-listing] 已上架清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as ListedInventoryProduct[];
}

/**
 * 建立型錄商品並連上進銷存品項。
 *
 * ⚠️ stock 一定寫 NULL。0011 的 products_linked_stock_guard trigger 會擋下任何
 * 非 NULL 的值 —— 有連結的商品若同時有型錄庫存，畫面上就有兩個數字，而且會有兩條
 * 路徑各自去扣它。這裡寫 NULL 不是為了讓 trigger 高興，是因為那個數字**不存在**：
 * 這件商品的庫存只有一份，在 inv.products。
 *
 * 沒有交易可用（PostgREST 一次一句），所以順序排成「先建可刪的、後建不可刪的」：
 * products 建失敗就什麼都沒發生；link 建失敗就把剛才那筆 products 刪掉。
 */
export async function createInventoryListing(input: ListingInput): Promise<{ product_id: string }> {
  const db = supabaseAdmin();
  const id = randomUUID();

  const { error: productError } = await db.from("products").insert({
    id,
    slug: input.slug,
    product_type: input.product_type,
    title: input.title,
    summary: input.summary,
    description: input.description,
    price: input.price,
    stock: null, // ← 見上面
    capacity: null,
    image_key: input.image_key ?? null,
    requires_shipping: true,
    status: input.status,
    sort_order: 0,
  });

  if (productError) {
    if (productError.code === "23505") {
      throw new Error(
        `[repo/inventory-listing] 上架失敗：網址代稱「${input.slug}」已被使用，請換一個。`,
      );
    }
    throw new Error(`[repo/inventory-listing] 上架失敗：${productError.message}`);
  }

  const { error: linkError } = await db.from("product_inventory_links").insert({
    product_id: id,
    inv_product_id: input.inv_product_id,
    units_per_sale: input.units_per_sale,
  });

  if (linkError) {
    // 回捲：沒有連結的型錄商品是一件「庫存永遠算不出來」的商品，留著比刪掉糟。
    await db.from("products").delete().eq("id", id);
    if (linkError.code === "23505") {
      throw new Error("[repo/inventory-listing] 上架失敗：這個進銷存品項已經上架過了。");
    }
    throw new Error(`[repo/inventory-listing] 上架失敗（連結）：${linkError.message}`);
  }

  return { product_id: id };
}

/**
 * 下架：刪掉型錄商品，連結由 `on delete cascade` 跟著走。
 *
 * 進銷存那一側**完全不動** —— 庫存、銷售紀錄、成本都還在。下架的意思只是
 * 「不在網站上賣了」，不是「這批貨不存在了」。
 */
export async function removeInventoryListing(productId: string): Promise<void> {
  const { error } = await supabaseAdmin().from("products").delete().eq("id", productId);
  if (error) throw new Error(`[repo/inventory-listing] 下架失敗：${error.message}`);
}
