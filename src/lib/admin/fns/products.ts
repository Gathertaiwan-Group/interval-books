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

// ---------------------------------------------------------------------------
// 編輯／新增內頁（2026-10-25 後台第 2 批：彈窗改內頁）
// ---------------------------------------------------------------------------
/*
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。原本商品頁的編輯／新增彈窗直接拿
 * 整頁 loader（getAdminProductsPageData：商品、刊物、候選品項、選品…全部）在記憶體裡的
 * 那一列；改成內頁之後，每一頁的 loader 只叫下面其中一支，**只抓那一筆＋那張表單要的
 * 選項**，不再為了編一件商品把整頁七份資料重抓一次。
 *
 * 授權：五支全部 adminFnMiddleware —— 與它們對應的存檔 fn（upsertProduct、
 * updatePublication〔fns/publications.ts〕、upsertCuratedItem〔fns/curated.ts〕）
 * 一模一樣，沒有放寬（scripts/admin-detail-products-selftest.mjs 守著）。
 * 刊物與選品的整頁 fn 放在這個檔案而不是各自的 fns 檔：它們是「商品」這一頁的內頁，
 * 與 getAdminProductsPageData 放一起比較好找；repo 一樣是動態 import。
 */

/** /admin/products/product/$id —— 一般商品／票券的完整表單。 */
export const getProductEditPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getProductById } = await import("@/server/repos/products");
    return { product: await getProductById(data.id) };
  });

/**
 * /admin/products/product/new —— 新增一般商品的精簡表單只需要「下一個排序值」。
 * 原本是商品頁拿記憶體裡整份 products 算 max(sort_order)+1；這裡同一條規則在伺服器上算。
 */
export const getNewGoodsPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listProducts } = await import("@/server/repos/products");
    const products = await listProducts();
    return { nextSortOrder: products.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1 };
  });

/** /admin/products/publication/$id —— 刊物校稿。 */
export const getPublicationEditPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getPublicationById } = await import("@/server/repos/publications");
    return { publication: await getPublicationById(data.id) };
  });

/**
 * /admin/products/curated/$id —— 選品一項。主題名稱只拿來寫副標（編輯時不給換主題：
 * 換主題要連 sort_order 一起換，upsertCuratedItem 的更新分支刻意不寫 sort_order）。
 */
export const getCuratedItemEditPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const { getCuratedItemById, getCuratedThemeById } = await import("@/server/repos/curated");
    const [item, link] = await Promise.all([getCuratedItemById(data.id), loadCuratedLinkData()]);
    const theme = item ? await getCuratedThemeById(item.theme_id) : null;
    return { item, themeTitle: theme?.title.zh ?? null, ...link };
  });

/**
 * 選品編輯／新增頁的「連結商品」那一格要的資料（0041）：能選的商品（書籍／一般商品，
 * 上架中或草稿；規則在 unified-products.ts#curatedLinkOptions）與 0041 的欄位在不在。
 * 欄位不在（migration 還沒套用）時那一格會停用並說明，表單其餘照常能存。
 */
async function loadCuratedLinkData() {
  const { isCuratedLinkSupported } = await import("@/server/repos/curated");
  const { listProducts } = await import("@/server/repos/products");
  const { listPublications } = await import("@/server/repos/publications");
  const { listListedInventoryProducts } = await import("@/server/repos/inventory-listing");
  const { curatedLinkOptions } = await import("@/lib/admin/unified-products");
  const [linkSupported, products, publications, listed] = await Promise.all([
    isCuratedLinkSupported(),
    listProducts(),
    listPublications(),
    listListedInventoryProducts(),
  ]);
  return {
    linkSupported,
    linkOptions: curatedLinkOptions({ products, publications, listed }),
  };
}

/**
 * /admin/products/curated/new —— 新增選品要選主題，sort_order 是「該主題目前最大值 + 1」
 * （unique(theme_id, sort_order)，見 unified-products.ts#nextCuratedSortOrder）。
 * 品項只回 theme_id／sort_order 兩欄：算排序值用不到名稱與備註。
 */
export const getCuratedItemNewPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listCuratedThemes, listCuratedItemsByThemes } = await import("@/server/repos/curated");
    const [themes, link] = await Promise.all([listCuratedThemes(), loadCuratedLinkData()]);
    const items = await listCuratedItemsByThemes(themes.map((t) => t.id));
    return {
      themes: themes.map((t) => ({ id: t.id, title: t.title })),
      itemOrders: items.map((i) => ({ theme_id: i.theme_id, sort_order: i.sort_order })),
      ...link,
    };
  });
