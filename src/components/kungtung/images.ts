/**
 * 《范毅舜公東教堂文化之旅》著陸頁用到的圖（Storage 15 張＋public/kungtung 3 張）。
 *
 * Storage 的是業主 Lovable 參考站（www.kungtung.intervalbooks.tw）上的原圖，2026-10-29 下載、
 * 轉成 WebP（長邊 ≤1600px）後經站上 MCP 的 upload_image_from_url 存進 site-images bucket，
 * 頁面上**不熱連** Lovable 的網址。key 名稱沿用原站的檔名，方便對照。
 */
import { imageFor } from "@/lib/images";

const KEYS = {
  "interval-logo": "storage:90d0c691-93ca-4fde-88ff-be26f32403d0.webp",
  "gudong-church-interior": "storage:91c89fe9-1301-4d69-8708-7ff42ffbab94.webp",
  "fan-yishun-portrait": "storage:dc86a283-0c38-409d-acda-4545085bf86e.webp",
  gongdong_chapel_cover_stone: "storage:18d5d5ae-d0ba-40d3-8ac8-e79d5d36c3ff.webp",
  gongdong_chapel_cover_glass: "storage:69448ba7-000a-4aca-94e4-b622d27a4f47.webp",
  convent_on_the_hill_cover_wall: "storage:5e72a4a8-eb6b-4fc3-91ef-f5a63e22458e.webp",
  convent_on_the_hill_cover_night: "storage:933928da-807d-4bf3-92ff-67292552019f.webp",
  // 舊版（積木文化）立體書封，直式；主持人頁「代表著作」的 3:4 格子仍用這張。
  coastal_range_swiss_cover_3d: "storage:4224f82c-f20f-4aae-bd1c-f33201efdc93.webp",
  "alice-portrait-tea": "storage:3eec0ea5-091b-44f2-8d3a-7b9e65225725.webp",
  "funature-dish": "storage:b8f06766-ee6c-4cf1-beca-93b691815051.webp",
  "funature-books": "storage:f5932da4-d4af-491e-9028-3fd023debc4b.webp",
  "funature-exterior": "storage:4d7280fd-fe0e-4d63-b227-8fe345dc6969.webp",
  "funature-room": "storage:aa86a968-9c2e-471e-a362-5367c6fb9f85.webp",
  "funature-chef": "storage:46af9012-5adf-49b8-ae08-a684081b6564.webp",
  "funature-slippers": "storage:ebb6c2ee-1ea1-44c3-af8e-889fc038f9d6.webp",
} as const;

/**
 * 2026-10-29 業主另外提供的時報出版版書封（《走進一座大教堂》《海岸山脈的瑞士人》新版、
 * 新增的《野台戲》），轉 WebP（長邊 1200px）後放在 repo 的 public/kungtung/，
 * 以站內相對路徑引用。《海岸山脈的瑞士人》新版是整張橫式書封（書名在右緣、作者名在左下），
 * 只放在著陸頁可容納橫圖的格子；舊版《走進一座大教堂》書封（Storage 6052effe…）不再使用。
 */
const LOCAL = {
  walk_into_cathedral_cover: "/kungtung/walk-into-cathedral-cover.webp",
  coastal_range_swiss_spread: "/kungtung/coastal-range-swiss-cover.webp",
  yetaixi_cover: "/kungtung/yetaixi-cover.webp",
} as const;

export type KungtungImage = keyof typeof KEYS | keyof typeof LOCAL;

export const IMG = {
  ...Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, imageFor(key, "")])),
  ...LOCAL,
} as Record<KungtungImage, string>;

/** og:image 用的那一張（首屏的公東教堂內部實景，= events.image_key）。 */
export const HERO_KEY = KEYS["gudong-church-interior"];
