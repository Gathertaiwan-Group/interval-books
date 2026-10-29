import { createFileRoute } from "@tanstack/react-router";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { imageFor } from "@/lib/images";
import {
  FanHeader,
  FanNav,
  FanSection1,
  FanSection2,
  FanSection3,
  FanSection4,
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
    zh: "范毅舜｜文化領路人｜公東教堂文化之旅｜小時光書店",
    en: "Nicholas Fan — Cultural Guide｜Kung Tung Chapel Journey｜Interval Books",
    ja: "范毅舜｜文化の案内人｜公東教会文化の旅｜小時光書店",
  },
  metaDescription: {
    zh: "攝影作家范毅舜的經歷、代表著作與媒體報導。《公東的教堂》作者，親自帶領旅人走進公東教堂。",
    en: "Photographer and author Nicholas Fan: career, major books and press. Author of The Chapel of Kung Tung, guiding travellers into the chapel in person.",
    ja: "写真家・作家、范毅舜の経歴、代表作とメディア掲載。『公東的教堂』の著者が公東教会を自ら案内します。",
  },
};

const OG_IMAGE_KEY = "storage:dc86a283-0c38-409d-acda-4545085bf86e.webp";

export const Route = createFileRoute("/events/kungtung_/hosts/fan-yishun")({
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
  component: FanYishunHost,
});

function FanYishunHost() {
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
        <FanNav />
        <FanHeader />
        <FanSection1 />
        <FanSection2 />
        <FanSection3 />
        <FanSection4 />
      </main>
    </div>
  );
}
