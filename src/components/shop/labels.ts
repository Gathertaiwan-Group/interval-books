/**
 * Storefront copy that is shared between routes but is not a component.
 *
 * Kept out of ShopBits.tsx so that file exports components only — mixing
 * constants in breaks React Fast Refresh for the whole module
 * (react-refresh/only-export-components).
 *
 * Deliberately not in src/i18n/strings.ts either: cms.ts#buildUi only merges
 * the brand/nav/footer/buttons/sections/notFound groups from the ui_strings
 * table, so a new group there would be dead weight the admin cannot edit
 * anyway. This is page copy, which the codebase keeps next to the page — the
 * same choice every other public route makes with its local PAGE constant.
 */
import type { Localized } from "@/i18n/types";
import type { ShopProductType } from "@/lib/shop";

/**
 * 「尚餘名額」，後面接一個數字。
 *
 * 住在這裡而不是任何一邊的檔案裡，是因為 /shop/$slug 有兩個地方用到同一句：商品
 * 層級的名額徽章（路由自己畫）與每一張場次卡片上的剩餘（SessionPicker 畫）。同一
 * 句話兩份字面值，遲早會有人只改到其中一份。
 *
 * ⚠️ /shop 列表頁的同名文案是**另一份**，走 cms.ts 的 p.block("seatsLeft", …)，
 *    後台可以覆寫。那一份不要併進來 —— 併了就等於把列表頁的可覆寫文案偷偷變成
 *    寫死的。
 */
export const SEATS_LEFT_LABEL: Localized = { zh: "尚餘名額", en: "Places left", ja: "残り枠" };

/** Display labels for products.product_type. */
export const PRODUCT_TYPE_LABELS: Record<ShopProductType, Localized> = {
  // 2026-11-11：目前線上的 goods 是地方好物（屏東潮州金弘的冷壓麻油、花生醬）。
  goods: { zh: "地方好物", en: "Local goods", ja: "地域の品" },
  book: { zh: "書籍", en: "Books", ja: "書籍" },
  event: { zh: "活動", en: "Events", ja: "イベント" },
  journey: { zh: "策旅", en: "Journeys", ja: "旅" },
};
