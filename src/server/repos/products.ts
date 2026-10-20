/**
 * Data layer for public.products — used exclusively by admin server
 * functions. Same conventions as src/server/repos/news.ts: every Supabase
 * error is thrown, never swallowed (this is a back office, not the public
 * site — silently returning null/empty on a DB error would be
 * indistinguishable from "there is no data", and an admin could believe a
 * write succeeded when it never reached the database). Rows are returned
 * exactly as Supabase returns them — snake_case columns, no camelCase
 * renaming — so what you see here matches
 * supabase/migrations/0004_commerce_products.sql column-for-column.
 *
 * products.slug carries its own unique index, separate from the `id` upsert
 * conflict target below, so a duplicate slug still raises Postgres error
 * 23505 even on an otherwise-normal upsert. upsertProduct() catches that
 * specific code and rethrows a message naming the offending slug, same
 * pattern as src/server/repos/exhibitions.ts#upsertExhibition.
 *
 * ⚠️ capacity 與 seats_taken **都不再是可寫欄位**（0020）。
 *
 * seats_taken 從來就不是：它由持有列鎖的 RPC 維護，表單寫回一個幾分鐘前讀到的
 * 計數器就會與那支 RPC 對撞。0020 讓 capacity 加入同一類 —— 名額搬到
 * public.event_sessions，而 `products_capacity_moved_to_sessions` 這條 CHECK 要求
 * `capacity is null and seats_taken = 0`，所以寫任何非 null 的 capacity 進來只會
 * 換到一個 23514。名額改由 src/server/repos/event-sessions.ts 按場次維護。
 *
 * 兩欄都還留在 COLUMNS 裡。理由與 0020 §1 不 drop 欄位是同一個：程式碼先上線、
 * migration 後套用，中間那段時間欄位還帶著舊值，而一個查不到欄位的 select 會讓
 * PostgREST 回 400、整頁掛掉。留著讀到的是 null，那是失敗時比較安全的那一邊。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, slug, product_type, source_type, source_id, title, summary, description, price, compare_at_price, stock, capacity, seats_taken, image_key, requires_shipping, status, sort_order, created_at, updated_at";

export type ProductType = "goods" | "book" | "event" | "journey";
export type ProductSourceType = "event" | "journey" | "curated_item";
export type ProductStatus = "draft" | "active" | "archived";

export type ProductRow = {
  id: string;
  slug: string;
  product_type: ProductType;
  /** Optional link back to the CMS row this product is sold from — not a FK. */
  source_type: ProductSourceType | null;
  source_id: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** TWD, whole dollars — never cents (see migration comment). */
  price: number;
  compare_at_price: number | null;
  /** NULL = not stock-managed. Only ever changed via atomic_deduct_stock(). */
  stock: number | null;
  /** Bookings only (event/journey). NULL for goods/book. */
  capacity: number | null;
  /** Read-only. Maintained exclusively by reserve_product_seat() — never write this. */
  seats_taken: number;
  image_key: string | null;
  requires_shipping: boolean;
  status: ProductStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * Shape accepted by upsertProduct. `id` omitted (or empty) means "create".
 * `seats_taken` is intentionally not part of this type — see file header.
 */
export type ProductUpsertInput = {
  id?: string;
  slug: string;
  product_type: ProductType;
  source_type?: ProductSourceType | null;
  source_id?: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  price: number;
  compare_at_price?: number | null;
  stock?: number | null;
  image_key?: string | null;
  requires_shipping: boolean;
  status: ProductStatus;
  sort_order: number;
};

export async function listProducts(): Promise<ProductRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/products] list 失敗：${error.message}`);
  return (data ?? []) as ProductRow[];
}

export async function getProductById(id: string): Promise<ProductRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/products] getById 失敗：${error.message}`);
  return (data as ProductRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. products.id has no DB default (it is
 * a plain `text primary key`, not an identity column — see
 * supabase/migrations/0004_commerce_products.sql:32-33, same shape as
 * news.id), so id generation has to happen here rather than being left to
 * Postgres.
 *
 * The write payload deliberately omits both seats_taken and capacity — see the
 * file header — so a concurrent reserve_session_seat() call can never be
 * clobbered by an admin saving this form, and so the form cannot try to write a
 * number the database now refuses.
 */
export async function upsertProduct(input: ProductUpsertInput): Promise<ProductRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("products")
    .upsert(
      {
        id,
        slug: input.slug,
        product_type: input.product_type,
        source_type: input.source_type ?? null,
        source_id: input.source_id ?? null,
        title: input.title,
        summary: input.summary,
        description: input.description,
        price: input.price,
        compare_at_price: input.compare_at_price ?? null,
        stock: input.stock ?? null,
        // capacity 刻意不在這裡。見檔頭 —— 寫進來只會換到一個 23514。
        image_key: input.image_key ?? null,
        requires_shipping: input.requires_shipping,
        status: input.status,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `[repo/products] upsert 失敗：網址代稱「${input.slug}」已被使用，請換一個不重複的代稱。`,
      );
    }
    if (error.code === "23514") {
      // 0020 之後這一支最可能觸發的是 products_capacity_moved_to_sessions ——
      // 也就是有人（舊 bundle、腳本、dashboard）還在往 capacity 寫值。訊息原文
      // 帶出去，因為約束名稱本身就說明了問題在哪。
      throw new Error(
        `[repo/products] upsert 失敗：欄位組合不符合資料庫限制（名額請到「活動報名」按場次設定，不要寫進商品）。${error.message}`,
      );
    }
    throw new Error(`[repo/products] upsert 失敗：${error.message}`);
  }
  return data as ProductRow;
}

/**
 * 只改「門面」欄位的更新：title / summary / description / image_key / price /
 * compare_at_price / status。給 MCP（src/server/mcp/tools.ts）用。
 *
 * ⚠️ 刻意不是 upsertProduct()：那一支是 upsert，會把 stock、slug、product_type、
 *    source_* 用呼叫端讀到的舊值整列寫回 —— 讀到寫之間若有一筆訂單扣了庫存
 *    （atomic_deduct_stock），upsert 會把庫存蓋回去。這裡是 `.update()` 只帶這七欄，
 *    其他欄位一個都不碰。
 */
export type ProductContentPatch = {
  title: Localized;
  summary: Localized;
  description: Localized;
  image_key: string | null;
  price: number;
  compare_at_price: number | null;
  status: ProductStatus;
};

export async function updateProductContent(
  id: string,
  patch: ProductContentPatch,
): Promise<ProductRow> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .update({
      title: patch.title,
      summary: patch.summary,
      description: patch.description,
      image_key: patch.image_key,
      price: patch.price,
      compare_at_price: patch.compare_at_price,
      status: patch.status,
    })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new Error(`[repo/products] updateContent 失敗：${error.message}`);
  if (!data) throw new Error(`[repo/products] updateContent 失敗：找不到商品 ${id}`);
  return data as ProductRow;
}

export async function removeProduct(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("products").delete().eq("id", id);
  if (error) throw new Error(`[repo/products] remove 失敗：${error.message}`);
}
