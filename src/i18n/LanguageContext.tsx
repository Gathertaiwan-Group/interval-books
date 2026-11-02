import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang, Localized } from "./types";
import { localizeHref } from "@/lib/seo/i18n";
import { syncRouterLang } from "@/lib/i18n-rewrite";
import { isAutoRedirecting } from "@/lib/lang-autodetect";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (l: Localized) => string;
  /** 公開頁的網址語言；私密頁（或沒有 router）→ null。 */
  urlLang: Lang | null;
  /** 訪客記住的語言（掛載後才有）。 */
  stored: Lang | null;
};

const LanguageContext = createContext<Ctx | null>(null);

/**
 * 語言從哪裡來（2026-11 /en /ja 網址前綴之後）：
 *
 *   · **公開頁**（首頁、活動、選物、關於…）：一律看**網址**。/events 是中文、/en/events 是英文。
 *     SSR 依網址輸出、瀏覽器第一次 render 也依網址，兩邊一定一致（不會 #418）。
 *     localStorage 記住的語言**不會**讓中文頁自動換成英文（Googlebot 是 en-US 的 Chromium、
 *     分享出去的中文連結也不該被轉走）；只會在中文頁顯示一個不擋畫面的「View in English?」提示
 *     （LanguageHint）。
 *   · **私密頁**（購物車、結帳、會員、後台…；沒有 /en 網址）：沿用訪客記住的語言
 *     （localStorage），掛載之後才讀——SSR 與第一次 render 都是中文，同原本的做法。
 *
 * 記住的語言什麼時候寫入：按語言切換鈕、或打開 /en、/ja 的頁面（之後的購物車、結帳介面
 * 延續同一個語言）。打開中文頁**不**寫入（中文是預設值，不代表訪客選了中文）。
 *
 * 🔴 這裡（React render／state）不要依 navigator.language 換語言（2026-11 SEO 健檢 H2）：
 *    render 時讀 navigator 會讓 SSR 與 hydration 不一致，Googlebot（en-US）也會看到英文。
 *    依瀏覽器語系的自動導向在 <head> 的 inline script 做（換網址、不換這一頁的語言），
 *    排除爬蟲、只導一次、手動優先——見 src/lib/lang-autodetect.ts。
 *
 * urlLang：由 __root.tsx 依目前網址算好傳進來（src/lib/seo/i18n.ts 的 publicLangOf）。
 *   Lang = 公開頁的語言；null = 私密頁；undefined = 沒有 router 的地方（selftest 的
 *   renderToStaticMarkup）——當作私密頁處理。
 */
export const LANG_STORAGE_KEY = "interval-books-lang";

export function readStoredLang(): Lang | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY) as Lang | null;
    if (saved === "zh" || saved === "en" || saved === "ja") return saved;
  } catch {
    /* ignore */
  }
  return null;
}

export function writeStoredLang(l: Lang) {
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
}

export function LanguageProvider({
  children,
  urlLang,
}: {
  children: ReactNode;
  urlLang?: Lang | null;
}) {
  // 記住的語言：只在掛載後讀（SSR 讀不到 localStorage）。
  const [stored, setStored] = useState<Lang | null>(null);

  useEffect(() => {
    setStored(readStoredLang());
  }, []);

  // 打開 /en、/ja 的頁面 = 選了那個語言（購物車、結帳沿用）。
  // 這一頁正被自動導走（例：中文訪客開了 /en 連結）→ 不寫，免得導回中文後介面卻記成英文。
  useEffect(() => {
    if (isAutoRedirecting()) return;
    if (urlLang === "en" || urlLang === "ja") {
      writeStoredLang(urlLang);
      setStored(urlLang);
    }
  }, [urlLang]);

  const lang: Lang = urlLang ?? stored ?? "zh";

  // 私密頁：頁首、頁尾的站內連結跟著介面語言（直接載入 /cart 時 router 還以為是中文）。
  // 只在掛載後（stored 有值）才做，SSR 與 hydration 的 href 維持一致。
  useEffect(() => {
    if (urlLang == null && stored) syncRouterLang(stored);
  }, [urlLang, stored]);

  // <html lang>：公開頁由 __root.tsx 的 RootShell 依網址輸出（SSR 就對）；私密頁跟著記住的語言。
  // urlLang 也列進依賴：從 /en/shop 換頁到 /cart 時 RootShell 會把 lang 寫回預設值，這裡要再蓋一次。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-Hant" : lang === "ja" ? "ja" : "en";
    }
  }, [lang, urlLang]);

  const setLang = (l: Lang) => {
    setStored(l);
    writeStoredLang(l);
  };

  const t = (entry: Localized) => entry[lang] || entry.zh;

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, urlLang: urlLang ?? null, stored }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLang must be used within LanguageProvider");
  return ctx;
}

export function useT() {
  return useLang().t;
}

/**
 * 讓一段子樹固定用某一種語言顯示，不管訪客選了什麼。給「只有中文版」的獨立著陸頁用
 * （例：events.kungtung.tsx 的報名區），共用的 SessionPicker／PlanPicker 才不會在
 * 中文頁面裡冒出英文。setLang 原封轉給外層，不改訪客記住的語言偏好。
 */
export function FixedLanguage({ lang, children }: { lang: Lang; children: ReactNode }) {
  const parent = useLang();
  const t = (entry: Localized) => entry[lang] || entry.zh;
  return (
    <LanguageContext.Provider value={{ ...parent, lang, t }}>{children}</LanguageContext.Provider>
  );
}

/**
 * 手寫的站內 `<a href>`（不是 <Link>）要帶上目前網址的語言前綴（/en、/ja）。
 * <Link> 不需要：router 的 output rewrite 會自動加（src/lib/i18n-rewrite.ts）。
 */
export function useLocalizeHref(): (href: string) => string {
  const { urlLang } = useLang();
  return (href: string) => localizeHref(href, urlLang ?? "zh");
}
