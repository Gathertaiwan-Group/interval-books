/**
 * 「選物」的〈主理人的選品〉分頁。
 *
 * 內容逐字搬自舊的 src/routes/curated.tsx（2026-09-02 導覽列合併）。
 *
 * ⚠️ 這裡的每一件都**買不到**：curated_items 只有 name / note，沒有 product_id，
 *    沒有價格也沒有庫存。所以它有自己的分頁、有自己的「詢問與選購」結尾，而不是
 *    跟商品混在同一個格狀清單裡 —— 混在一起客人會以為那些都能加入購物車。
 */
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { pageText, type CuratedThemeEntry, type PageContent } from "@/lib/cms";
import { CARD } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";
import { PanelIntro } from "./PublicationsPanel";

/** 後備文案 —— 只有在 Supabase 讀不到 pages/'curated' 那一列時才會用到。 */
const COPY = {
  title: { zh: "主理人的選品", en: "The Owner's Curated Window", ja: "店主の選品" },
  themeEmpty: {
    zh: "這個櫥窗正在整理中，很快會放上選件。",
    en: "This window is being arranged — pieces will appear here shortly.",
    ja: "こちらのウィンドウは準備中です。まもなく選品が並びます。",
  },
  intro: {
    zh: "我們以「主題櫥窗」呈現選物，而非商品清單。每一件物，都是一段被留下來的時間。",
    en: "We arrange the selection as themed windows, not as a catalogue. Each piece holds a quiet stretch of time.",
    ja: "商品リストではなく、テーマの窓辺として並べています。一品一品が、留まった時間そのもの。",
  },
  windowLabel: { zh: "Window", en: "Window", ja: "Window" },
  askPurchase: { zh: "詢問與選購", en: "Ask & purchase", ja: "お問合せ・お求め" },
} satisfies Record<string, Localized>;

export function CuratedPanel({
  page,
  curatedThemes,
}: {
  page: PageContent | null;
  curatedThemes: CuratedThemeEntry[];
}) {
  const t = useT();
  const p = pageText(page);
  const { ui, contactEmail, social } = useSiteContent();

  return (
    <>
      <PanelIntro title={t(p.title(COPY.title))} intro={t(p.intro(COPY.intro))} />

      <section className="container-editorial pb-24 space-y-32" data-testid="curated-themes">
        {curatedThemes.map((theme, i) => (
          <div key={theme.id}>
            <div className="grid md:grid-cols-12 gap-10 items-end mb-12">
              <div className="md:col-span-5">
                <p className="eyebrow text-2xl">
                  {t(p.block("windowLabel", COPY.windowLabel))} {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="display mt-4 text-4xl md:text-5xl">{t(theme.title)}</h3>
              </div>
              <p className="md:col-span-7 text-base leading-relaxed text-muted-foreground md:pb-2">
                {t(theme.description)}
              </p>
            </div>

            {/* 一個還沒放品項的主題，底下會是一個空的格線——主題標題下面什麼都沒有。
                後台是先建主題、再加品項，所以這個中間狀態是真的會被看到的。 */}
            {theme.items.length === 0 ? (
              <p className="border border-border p-7 text-sm leading-relaxed text-muted-foreground md:p-8">
                {t(p.block("themeEmpty", COPY.themeEmpty))}
              </p>
            ) : (
              // 一件一張獨立卡片，外框用前台共用的 CARD（src/lib/feature-layout.ts）；
              // 不是連結，所以不加 CARD_HOVER。
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:gap-8 lg:grid-cols-3">
                {theme.items.map((item, idx) => (
                  <article key={idx} className={`${CARD} p-5 md:p-6`}>
                    <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                      {String(idx + 1).padStart(2, "0")}
                    </p>
                    <h4 className="font-serif text-xl mt-3 leading-snug">{t(item.name)}</h4>
                    <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                      {t(item.note)}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 flex flex-wrap gap-4 text-xs tracking-widest items-center">
          <span className="text-muted-foreground mr-4">
            {t(p.block("askPurchase", COPY.askPurchase))}
          </span>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={`mailto:${contactEmail}`}
          >
            {t(ui.buttons.emailUs)}
          </a>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={social.line}
            target="_blank"
            rel="noreferrer"
          >
            {t(ui.buttons.line)}
          </a>
          <span className="text-clay">{t(ui.buttons.inStore)}</span>
        </div>
      </section>
    </>
  );
}
