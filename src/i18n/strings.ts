// UI 字串（導覽列、按鈕、區塊標題等）
import type { Localized } from "./types";

export const UI = {
  brand: { zh: "小時光書店", en: "Interval Books", ja: "小時光書店" },
  brandSub: { zh: "Interval Books", en: "Hourlight Bookstore", ja: "Interval Books" },

  nav: {
    home: { zh: "首頁", en: "Home", ja: "ホーム" },
    events: { zh: "活動", en: "Events", ja: "イベント" },
    publications: { zh: "地方刊物展", en: "Publications", ja: "地域の刊行物" },
    journeys: { zh: "策旅", en: "Journeys", ja: "旅" },
    curated: { zh: "主理人的選品", en: "Curated", ja: "店主の選品" },
    shop: { zh: "選購", en: "Shop", ja: "ショップ" },
    cart: { zh: "購物車", en: "Cart", ja: "カート" },
    visit: { zh: "來店資訊", en: "Visit", ja: "ご来店" },
    about: { zh: "關於", en: "About", ja: "について" },
    contact: { zh: "聯絡", en: "Contact", ja: "お問合せ" },
    curation: { zh: "策展與合作", en: "Curation & Collaboration", ja: "キュレーション" },
    privacy: { zh: "隱私權聲明", en: "Privacy", ja: "プライバシー" },

    // ── 導覽列合併後的兩格（2026-09-02，九格 → 五格）──────────────────────
    //
    // 刻意用**新的 key**，而不是改寫上面的 `shop` / `about`。
    //
    // cms.ts 的 buildUi() 先鋪這一份靜態表，再讓 ui_strings 那張表的每一列覆蓋上去
    // （src/lib/cms.ts buildUi）。supabase/seed.sql:57 已經在正式庫塞了
    // ('nav','about') = 「關於」；改寫這裡的 about 值，畫面上仍然會是資料庫那一份，
    // 而且改的人看不出來為什麼沒生效。新 key 在 ui_strings 裡沒有對應列，所以
    // 一定走這裡的值 —— 之後客戶想改，往 ui_strings 補一列即可（後台的
    // /admin/strings 只編既有列，不新增）。
    //
    // 舊 key 一個都沒刪：index.tsx 拿 nav.curated / nav.visit 當區塊標題用，
    // SiteFooter 拿 nav.curation / nav.privacy，刪掉會直接壞掉。
    select: { zh: "選物", en: "Selection", ja: "セレクト" },
    aboutStore: { zh: "關於小時光", en: "About Interval Books", ja: "小時光について" },

    // ── 客人帳號入口（2026-09-03）──────────────────────────────────────────
    // 與上面「九格 → 五格」同一條理由：新 key，不改寫既有的。頭首導覽走圖示
    // （見 SiteHeader.tsx），這個字串目前只當作該圖示的 aria-label／title。
    account: { zh: "我的帳號", en: "My Account", ja: "マイページ" },

    // ── 異業合作頁（2026-10-26）—— 新 key，理由同上。不進主導覽列，只在 footer、
    //    /about 與 /curation 出現。
    partnership: { zh: "異業合作", en: "Partnership", ja: "協働のご相談" },
  },

  footer: {
    visit: { zh: "來訪", en: "Visit", ja: "ご来店" },
    contact: { zh: "聯繫", en: "Contact", ja: "お問合せ" },
    follow: { zh: "追蹤", en: "Follow", ja: "フォロー" },
    account: { zh: "我的帳號", en: "My Account", ja: "マイページ" },
    aboutBlurb: {
      zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
      en: "Tucked inside Huashan Cultural Park, Interval Books is a quiet pause — birdsong outside, the scent of tea and paper within, and the warmth of small encounters.",
      ja: "華山文化園にひっそりと佇む小時光書店。鳥のさえずり、茶と本の香り、ひとと人のあたたかな繋がりが息づく場所です。",
    },
    rights: {
      zh: "小時光書店．保留所有權利",
      en: "Interval Books. All rights reserved.",
      ja: "Interval Books. All rights reserved.",
    },
    everyday: { zh: "每日開放", en: "Open every day", ja: "年中無休" },
  },

  buttons: {
    toEvent: { zh: "前往活動網站", en: "Visit event site", ja: "イベントサイトへ" },
    // 站內的活動詳情頁。與 toEvent 是兩件事：toEvent 真的把人送去別人的網站
    // （售票頁、主辦單位官網），viewEvent 是留在這個站上。
    viewEvent: { zh: "查看活動", en: "View event", ja: "イベントを見る" },
    toJourney: { zh: "前往旅程網站", en: "Visit journey site", ja: "旅のサイトへ" },
    navigate: { zh: "點此導航", en: "Open in Maps", ja: "地図を開く" },
    emailUs: { zh: "Email 聯繫", en: "Email us", ja: "メールで問合せ" },
    line: { zh: "LINE 私訊", en: "Message on LINE", ja: "LINE で連絡" },
    inStore: { zh: "到店選購", en: "Visit in store", ja: "店頭でご覧" },
    viewAll: { zh: "查看全部", en: "View all", ja: "すべて見る" },
    backHome: { zh: "回到首頁", en: "Back home", ja: "ホームへ" },
    addToCart: { zh: "加入購物車", en: "Add to cart", ja: "カートに入れる" },
    soldOut: { zh: "已售完", en: "Sold out", ja: "完売" },
    viewProduct: { zh: "查看商品", en: "View item", ja: "商品を見る" },
    continueShopping: { zh: "繼續選購", en: "Continue shopping", ja: "買い物を続ける" },
    remove: { zh: "移除", en: "Remove", ja: "削除" },
    viewCart: { zh: "前往購物車", en: "Go to cart", ja: "カートへ" },
  },

  sections: {
    thisMonth: { zh: "本月精選", en: "This Month", ja: "今月の特集" },
    featuredEvents: { zh: "精選活動", en: "Featured Events", ja: "特選イベント" },
    featuredJourney: { zh: "精選策旅", en: "Featured Journey", ja: "特選の旅" },
  },
} as const;

export const SITE_INFO = {
  shortDesc: {
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
    en: "Tucked inside Huashan Cultural Park, Interval Books is a quiet pause — birdsong outside, the scent of tea and paper within, and the warmth of small encounters.",
    ja: "華山文化園にひっそりと佇む小時光書店。鳥のさえずり、茶と本の香り、ひとと人のあたたかな繋がりが息づく場所です。",
  } as Localized,
  address: {
    zh: "華山文創園區．紅磚六合院 西7-3館",
    en: "Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3",
    ja: "華山1914文化創意産業園區 紅煉瓦六合院 西7-3館",
  } as Localized,
  city: {
    zh: "台北市中正區",
    en: "Zhongzheng District, Taipei",
    ja: "台北市中正区",
  } as Localized,
  hours: {
    zh: "週一至週日 11:00 – 19:00",
    en: "Mon – Sun, 11:00 – 19:00",
    ja: "月〜日 11:00 – 19:00",
  } as Localized,
  closed: {
    zh: "每日開放（特殊節日另行公告）",
    en: "Open every day (special closures announced)",
    ja: "年中無休（特別休業は別途告知）",
  } as Localized,
};

export const CONTACT_EMAIL = "intervalbookstores@gmail.com";
export const SITE_URL = "https://intervalbooks.tw";

export const CONTACT_PHONES = [
  { label: "Tel", display: "+886 2 2341 6800", tel: "+886223416800" },
  { label: "Mobile", display: "+886 917 540 615", tel: "+886917540615" },
] as const;

// 社群連結：若值為空字串，Footer 會自動隱藏該項。
// 之後拿到正式網址時，直接填入下方字串即可（或改由環境變數注入）。
export const SOCIAL = {
  instagram: "https://www.instagram.com/intervalbookstw/",
  facebook: "", // TODO: 填入正式 Facebook 粉絲頁網址
  line: "", // TODO: 填入正式 LINE 官方帳號連結（例如 https://lin.ee/xxxxxx）
};

export const MAP = {
  embed: "https://www.google.com/maps?q=華山1914文化創意產業園區&output=embed",
  link: "https://goo.gl/maps/RB2ep3NoWFenLamV9",
  apple:
    "https://maps.apple.com/?q=%E8%8F%AF%E5%B1%B11914%E6%96%87%E5%8C%96%E5%89%B5%E6%84%8F%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80&ll=25.0440,121.5298",
};
