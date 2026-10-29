import { createFileRoute } from "@tanstack/react-router";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { imageFor } from "@/lib/images";
import {
  AliceHeader,
  AliceNav,
  AliceSection1,
  AliceSection2,
  AliceSection3,
  AliceSection4,
} from "@/components/kungtung/HostSections";
import kungtungCss from "@/components/kungtung/kungtung.css?url";

/**
 * 《范毅舜公東教堂文化之旅》參考站的主理人內頁（原站 /hosts/…），從著陸頁「閱讀…完整經歷」連過來。
 * 路由檔名的 `kungtung_` 讓它不巢狀在 events.kungtung.tsx 底下（那頁沒有 <Outlet />）。
 * 版面與轉換方式見 src/routes/events.kungtung.tsx。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "Alice 劉柳樺｜文化策旅人｜公東教堂文化之旅｜小時光書店",
    en: "Alice Liu — Journey Curator｜Kung Tung Chapel Journey｜Interval Books",
    ja: "Alice 劉柳樺｜文化の旅のキュレーター｜公東教会文化の旅｜小時光書店",
  },
  metaDescription: {
    zh: "小時光風土誌書店主理人 × 馥自然人文空間策旅主理人 Alice 劉柳樺的經歷與策展。",
    en: "Alice Liu, founder of Interval Books and journey curator at INNTERVAL Fu Nature & Humanities Space: her work and curation.",
    ja: "小時光風土誌書店の店主であり、馥自然人文空間の旅のキュレーター、Alice 劉柳樺の経歴と企画。",
  },
};

const OG_IMAGE_KEY = "storage:3eec0ea5-091b-44f2-8d3a-7b9e65225725.webp";

export const Route = createFileRoute("/events/kungtung_/hosts/alice")({
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.metaTitle.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      { property: "og:image", content: imageFor(OG_IMAGE_KEY, "") },
    ],
    links: [
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500&family=Noto+Serif+TC:wght@400;600&display=swap",
      },
      { rel: "stylesheet", href: kungtungCss },
    ],
  }),
  component: AliceHost,
});

function AliceHost() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.metaTitle,
    ogDescription: PAGE.metaDescription,
    ogImage: imageFor(OG_IMAGE_KEY, ""),
  });
  return (
    <div className="kt-root">
      <main className="kt-host-page">
        <AliceNav />
        <AliceHeader />
        <AliceSection1 />
        <AliceSection2 />
        <AliceSection3 />
        <AliceSection4 />
      </main>
    </div>
  );
}
