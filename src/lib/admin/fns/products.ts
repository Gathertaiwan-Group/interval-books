/**
 * products server functions — the only way the admin UI is allowed to touch
 * public.products. Every export chains adminFnMiddleware: that middleware,
 * not the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { productSchema } from "@/lib/admin/schemas";

export const listProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listProducts } = await import("@/server/repos/products");
    return await listProducts();
  });

export const getProductById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getProductById } = await import("@/server/repos/products");
    return await getProductById(data.id);
  });

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(productSchema)
  .handler(async ({ data }) => {
    const { upsertProduct } = await import("@/server/repos/products");
    return await upsertProduct(data);
  });

export const removeProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeProduct } = await import("@/server/repos/products");
    await removeProduct(data.id);
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------
/**
 * /admin/products 進場要的全部資料，一支 fn。
 *
 * 原本是 loader 在瀏覽器端平行打 6 支 fn、再每個選品主題各打一支 listCuratedItems（N+1）——
 * 每一支都各自驗一次身分（重讀 profiles），正式站上每一支還是一趟獨立的 HTTP；其中
 * listPublicationNameMatches 讀的 publication_listing_candidates view 每次約 1 秒。
 *
 * 現在：身分只驗一次（adminFnMiddleware——原本那 7 支全部都是 adminFnMiddleware，一樣嚴），
 * 查詢在伺服器上平行跑，選品一次 `in (theme_id…)`，同名比對改在程式裡用已經抓回來的
 * 候選品項與刊物算（規則與 view 一字不差，見 src/lib/admin/publication-name-match.ts）。
 * 原本那幾支 fn 保留（其他頁面與寫入後的重抓還在用）。
 */
export const getAdminProductsPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listProducts } = await import("@/server/repos/products");
    const { listPublications } = await import("@/server/repos/publications");
    const { listInventoryCandidates, listListedInventoryProducts } =
      await import("@/server/repos/inventory-listing");
    const { listCuratedThemes, listCuratedItemsByThemes } = await import("@/server/repos/curated");
    const { matchPublicationNames } = await import("@/lib/admin/publication-name-match");

    const [products, publications, candidates, listed, curatedItemsAndThemes] = await Promise.all([
      listProducts(),
      listPublications(),
      listInventoryCandidates(),
      listListedInventoryProducts(),
      listCuratedThemes().then(async (curatedThemes) => ({
        curatedThemes,
        curatedItems: await listCuratedItemsByThemes(curatedThemes.map((t) => t.id)),
      })),
    ]);
    // 程式比對只看得到抓回來的候選與刊物。萬一碰到 PostgREST 的 db-max-rows（Supabase 預設
    // 1000）被截斷，就退回 view 本身（慢但完整），絕不靜默漏掉同名品項。
    const truncated = candidates.length >= 1000 || publications.length >= 1000;
    const nameMatches = truncated
      ? await (await import("@/server/repos/publications")).listPublicationNameMatches()
      : matchPublicationNames(candidates, publications);
    return {
      products,
      publications,
      nameMatches,
      candidates,
      listed,
      curatedThemes: curatedItemsAndThemes.curatedThemes,
      curatedItems: curatedItemsAndThemes.curatedItems,
    };
  });
