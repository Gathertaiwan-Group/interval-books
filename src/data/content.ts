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

export const curatedThemes: CuratedTheme[] = [
  {
    id: "ct-1",
    title: { zh: "地方風土", en: "Place & Terroir", ja: "土地と風土" },
    description: {
      zh: "從一本地方誌，到一罐自家熬的果醬。",
      en: "From a local journal to a jar of home-cooked jam.",
      ja: "地方誌から、自家製のジャムまで。",
    },
    items: [
      {
        name: {
          zh: "山村釀造．桂花蜜",
          en: "Mountain Village Osmanthus Honey",
          ja: "山村醸造 桂花蜜",
        },
        note: { zh: "南投手工小批次", en: "Small batch from Nantou", ja: "南投の小ロット" },
      },
      {
        name: { zh: "東海岸海鹽", en: "East Coast Sea Salt", ja: "東海岸の海塩" },
        note: { zh: "粗粒、慢曬", en: "Coarse, slow-dried", ja: "粗粒、ゆっくり天日干し" },
      },
      {
        name: { zh: "苗栗黑糖磚", en: "Miaoli Brown Sugar Block", ja: "苗栗の黒糖ブロック" },
        note: { zh: "古法柴燒", en: "Wood-fired the old way", ja: "古法の薪焚き" },
      },
      {
        name: { zh: "阿里山高山茶", en: "Alishan High Mountain Tea", ja: "阿里山高山茶" },
        note: { zh: "春摘．烏龍", en: "Spring pick · Oolong", ja: "春摘み・烏龍" },
      },
      {
        name: { zh: "金門高粱醋", en: "Kinmen Sorghum Vinegar", ja: "金門高粱酢" },
        note: { zh: "陳年三年", en: "Aged three years", ja: "三年熟成" },
      },
      {
        name: { zh: "花蓮米果", en: "Hualien Rice Cracker", ja: "花蓮の米菓" },
        note: { zh: "在地稻米製", en: "Made with local rice", ja: "地の米から" },
      },
    ],
  },
  {
    id: "ct-2",
    title: { zh: "器物與陶", en: "Vessels & Clay", ja: "器と陶" },
    description: {
      zh: "每一只都是職人手中緩慢的時間。",
      en: "Each piece, the slow time of a maker's hands.",
      ja: "ひとつひとつが、職人の手のなかの緩やかな時間。",
    },
    items: [
      {
        name: { zh: "粗陶茶碗", en: "Stoneware Tea Bowl", ja: "粗陶の茶碗" },
        note: {
          zh: "手捏．不規則口緣",
          en: "Hand-pinched, irregular rim",
          ja: "手びねり・不揃いの縁",
        },
      },
      {
        name: { zh: "白瓷小皿", en: "White Porcelain Small Dish", ja: "白磁の小皿" },
        note: { zh: "釉下青花", en: "Underglaze blue-and-white", ja: "釉下の青花" },
      },
      {
        name: { zh: "黑陶花器", en: "Black Clay Vase", ja: "黒陶の花器" },
        note: { zh: "燻燒．霧面", en: "Smoke-fired, matte", ja: "燻し焼き・マット" },
      },
      {
        name: { zh: "木製茶則", en: "Wooden Tea Scoop", ja: "木の茶則" },
        note: { zh: "台灣相思木", en: "Taiwanese acacia", ja: "台湾相思木" },
      },
      {
        name: { zh: "亞麻織布巾", en: "Linen Cloth", ja: "リネンの布巾" },
        note: { zh: "天然染", en: "Naturally dyed", ja: "天然染め" },
      },
      {
        name: { zh: "鑄鐵燭台", en: "Cast Iron Candlestick", ja: "鋳鉄の燭台" },
        note: { zh: "霧黑塗裝", en: "Matte black finish", ja: "マットブラック仕上げ" },
      },
    ],
  },
  {
    id: "ct-3",
    title: { zh: "茶與日常", en: "Tea & Daily", ja: "茶と日々" },
    description: {
      zh: "讀一頁書，配一口靜。",
      en: "A page of reading, a sip of quiet.",
      ja: "一頁の読書に、ひと口の静けさを。",
    },
    items: [
      {
        name: { zh: "手工焙茶包", en: "Hand-roasted Tea Bags", ja: "手焙煎ティーバッグ" },
        note: { zh: "三入裝", en: "Set of three", ja: "三入り" },
      },
      {
        name: { zh: "海鹽可可", en: "Sea Salt Cocoa", ja: "海塩ココア" },
        note: { zh: "70% 黑巧克力", en: "70% dark chocolate", ja: "70% ダーク" },
      },
      {
        name: { zh: "奶油酥餅", en: "Butter Shortbread", ja: "バターショートブレッド" },
        note: { zh: "古早味．小份量", en: "Old-fashioned, small", ja: "昔ながら・小ぶり" },
      },
      {
        name: { zh: "蜂蜜檸檬糖", en: "Honey Lemon Drops", ja: "はちみつレモン飴" },
        note: { zh: "台南龍眼蜜", en: "Tainan longan honey", ja: "台南の龍眼蜜" },
      },
      {
        name: { zh: "杏仁脆片", en: "Almond Crisps", ja: "アーモンドクリスプ" },
        note: { zh: "薄．脆．香", en: "Thin, crisp, fragrant", ja: "薄く・香ばしく" },
      },
      {
        name: { zh: "桂圓紅棗茶", en: "Longan & Date Tea", ja: "竜眼と紅棗の茶" },
        note: { zh: "冬季限定", en: "Winter only", ja: "冬季限定" },
      },
    ],
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
