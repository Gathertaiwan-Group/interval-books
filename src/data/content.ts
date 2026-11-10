import type { Localized } from "@/i18n/types";

// === 共用型別（含二期預留欄位） ===
export type EventCategory =
  | "讀書會"
  | "療癒生活節"
  | "策旅說明會"
  | "陶藝家展售"
  | "身心靈工作坊"
  | "好書交流";

export interface EventItem {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  date: string; // 顯示用日期字串
  isoDate?: string; // 二期排序用
  category: EventCategory;
  externalUrl: string; // 一期：外連活動網站（待替換）
  registrationType: "external" | "internal"; // 二期擴充
  paymentEnabled: boolean; // 二期擴充
}

export interface JourneyItem {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  days: Localized;
  theme: Localized;
  externalUrl: string; // 一期：外連
  registrationType: "external" | "internal";
  paymentEnabled: boolean;
}

export interface CuratedItem {
  name: Localized;
  note: Localized;
}

export interface CuratedTheme {
  id: string;
  title: Localized;
  description: Localized;
  items: CuratedItem[];
}

// === 資料 ===

export const events: EventItem[] = [];

export const journeys: JourneyItem[] = [];

// 2026-11-10 業主要求移除假資料：原本每個主題底下各 6 件的範例選品（蜂蜜、茶碗之類的示意品名）
// 已從正式庫 curated_items 刪除，這裡的後備也一併拿掉——讀不到資料庫時不能又冒出假品名。
// 主題本身保留（後台還有這三個主題，之後主理人放真的選品進去）。
export const curatedThemes: CuratedTheme[] = [
  {
    id: "ct-1",
    title: { zh: "地方風土", en: "Place & Terroir", ja: "土地と風土" },
    description: {
      zh: "從一本地方誌，到一罐自家熬的果醬。",
      en: "From a local journal to a jar of home-cooked jam.",
      ja: "地方誌から、自家製のジャムまで。",
    },
    items: [],
  },
  {
    id: "ct-2",
    title: { zh: "器物與陶", en: "Vessels & Clay", ja: "器と陶" },
    description: {
      zh: "每一只都是職人手中緩慢的時間。",
      en: "Each piece, the slow time of a maker's hands.",
      ja: "ひとつひとつが、職人の手のなかの緩やかな時間。",
    },
    items: [],
  },
  {
    id: "ct-3",
    title: { zh: "茶與日常", en: "Tea & Daily", ja: "茶と日々" },
    description: {
      zh: "讀一頁書，配一口靜。",
      en: "A page of reading, a sip of quiet.",
      ja: "一頁の読書に、ひと口の静けさを。",
    },
    items: [],
  },
];

// === 策展與合作（低調）===
export const collaborations: { title: Localized; desc: Localized }[] = [
  {
    title: {
      zh: "療癒藝術節／療癒師品牌共創",
      en: "Healing Arts Festivals & Practitioner Brands",
      ja: "ヒーリング・アートフェス／セラピスト共創",
    },
    desc: {
      zh: "為節慶與品牌設計具策展感的療癒現場。",
      en: "Curated healing experiences for festivals and brands.",
      ja: "祭典やブランドのために、キュレーションされたヒーリングの場を。",
    },
  },
  {
    title: {
      zh: "空間策展",
      en: "Space Curation",
      ja: "空間キュレーション",
    },
    desc: {
      zh: "為旅宿、咖啡館、辦公空間策劃選書與選物。",
      en: "Books and objects for hotels, cafés, and offices.",
      ja: "宿、カフェ、オフィスのための選書と選品。",
    },
  },
  {
    title: {
      zh: "書店展售／茶品器具內容策展",
      en: "Bookshop Showcase & Tea-ware Content",
      ja: "書店ショーケース／茶道具の内容企画",
    },
    desc: {
      zh: "結合書、茶與器物的主題內容策劃。",
      en: "Themed editorial pairings of books, tea, and vessels.",
      ja: "本、茶、器物を組み合わせたテーマ企画。",
    },
  },
  {
    title: {
      zh: "品牌共創",
      en: "Brand Co-creation",
      ja: "ブランド共創",
    },
    desc: {
      zh: "為品牌設計閱讀活動、內容資產與企業接待。",
      en: "Reading events, content, and hospitality for brands.",
      ja: "ブランドのための読書プログラム、コンテンツ、ホスピタリティ。",
    },
  },
];
