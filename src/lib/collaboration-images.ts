/**
 * 「我們做過的合作類型」卡片（public.collaborations）的圖片對照表。
 *
 * 為什麼在程式裡、不在資料庫：collaborations 表沒有圖片欄位（只有 title／description／
 * sort_order），後台管理頁也已移除；這裡刻意不加 migration，改用 collaborations.id 對到
 * 一張自家的圖。
 *
 * 🔴 之後要換圖，改這個檔案的 COLLABORATION_IMAGES 就好：
 *   - imageKey 可以是 src/lib/images.ts 的內建圖檔名（"bookstore-interior.jpg"），
 *     或後台／MCP 上傳到 site-images bucket 後拿到的 "storage:<uuid>.<ext>"。
 *   - alt 三語都要寫，描述「圖片裡看得到什麼」，不是重複卡片標題。
 *   - 只用自家拍的／自家上傳的圖。外站或其他品牌的照片不要放。
 *   - 新增一筆 collaborations 卻沒在這裡加對照時，會用 COLLABORATION_IMAGE_FALLBACK（店門口）。
 *
 * 零 runtime import（只有型別），scripts/partnership-selftest.mjs 直接 import 驗證。
 */
import type { Localized } from "@/i18n/types";

export type CollaborationImage = {
  /** 交給 imageFor() 解析的 key（內建檔名或 storage:<name>）。 */
  imageKey: string;
  alt: Localized;
  /** object-position，直式照片裁成 4:3 時要保留的位置。預設置中。 */
  position?: string;
};

export const COLLABORATION_IMAGES: Record<string, CollaborationImage> = {
  // 療癒藝術節／療癒師品牌共創 → 身心靈工作坊「植生布植生牆｜布苔球」（/events/20261220）的封面
  "co-1": {
    imageKey: "storage:9b8aa6ea-251b-4288-ac76-c60cec756946.webp",
    alt: {
      zh: "木桌上一顆用麻繩纏繞、長出蕨葉的布苔球，背景是書架",
      en: "A twine-wrapped fabric moss ball sprouting fern leaves on a wooden table, with bookshelves behind",
      ja: "本棚を背に、木のテーブルに置かれた麻ひもで巻いたシダの生える布の苔玉",
    },
  },
  // 空間策展 → 店內空間（src/assets/bookstore-interior.jpg）
  "co-2": {
    imageKey: "bookstore-interior.jpg",
    alt: {
      zh: "紅磚老屋書店的一角：木造屋頂下掛著一幅山景大圖，下方是書架",
      en: "A corner of the red-brick bookshop: a large mountain photograph hangs beneath the timber roof, above the bookshelves",
      ja: "赤レンガの書店の一角。木の屋根の下に大きな山の写真、その下に本棚",
    },
    // 直式照片，店內人物在畫面中段；4:3 只取上段（山景大圖＋書架頂），避免拍到清楚的人臉。
    // 換成別張圖時這個值也要跟著重調（或拿掉，預設置中）。
    position: "50% 18%",
  },
  // 書店展售／茶品器具內容策展 → 選物（src/assets/curated-objects.jpg）
  "co-3": {
    imageKey: "curated-objects.jpg",
    alt: {
      zh: "銀色器皿裡插著球狀綠花與枝條的花藝擺設",
      en: "Round green blossoms and branches arranged in a silver vessel",
      ja: "銀色の器に生けた丸い緑の花と枝",
    },
    position: "50% 35%",
  },
  // 品牌共創 → 店門口（src/assets/storefront.jpg）
  "co-4": {
    imageKey: "storefront.jpg",
    alt: {
      zh: "華山紅磚六合院裡的小時光書店門口，兩旁擺滿盆栽",
      en: "The Interval Books entrance in Huashan's red-brick courtyard, lined with potted plants",
      ja: "華山の赤レンガ六合院にある小時光書店の入口。鉢植えが並ぶ",
    },
  },
};

export const COLLABORATION_IMAGE_FALLBACK: CollaborationImage = COLLABORATION_IMAGES["co-4"];

export function collaborationImage(id: string): CollaborationImage {
  return COLLABORATION_IMAGES[id] ?? COLLABORATION_IMAGE_FALLBACK;
}
