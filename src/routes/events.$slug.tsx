import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { SessionList, SessionPicker } from "@/components/shop/SessionPicker";
import { QuantityStepper } from "@/components/shop/ShopBits";
import { useLang, useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchEventBySlug, fetchEventCategories } from "@/lib/cms";
import {
  directAnySeatsLeft,
  directCheckoutSearch,
  directSeatLimit,
  directSoleSession,
} from "@/lib/direct-checkout";
import { EVENT_LIST_FIELDS } from "@/lib/event-blocks";
import { imageFor } from "@/lib/images";
import { fetchActiveProductForEventSlug, type ShopProduct } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";

/**
 * 活動詳情頁。
 *
 * ── 這一頁在補的洞 ─────────────────────────────────────────────────────────
 * /events 從第一天起就是一個列表，每一則點下去是開一個**外部**連結。也就是說
 * 店家辦一場講座，這個站上沒有任何一頁在講那場講座是什麼。這一頁就是那一頁。
 *
 * ── 網址現在真的是 events.slug ─────────────────────────────────────────────
 * 這一頁上線時 public.events 還沒有 slug 欄位，網址吃的是 events.id；路由參數之所以
 * 從一開始就叫 $slug 而不叫 $id，就是為了這一天。0026 加上 events.slug 並且用
 * `slug = id` 回填，所以**在那之前發出去的每一個網址仍然指到同一場活動**。
 *
 * ⚠️ 反過來說，從 0026 起「在後台改代稱」就等於「讓已經發出去的那個網址 404」——
 *    因為這一頁對查無此活動是真的回 404（見下面第三段）。那句警告寫在 0026 的檔頭
 *    與後台 slug 欄位的說明文字上。
 *
 * ── 這一頁現在畫大圖、相簿、講者了（原本這裡寫著「仍然不畫封面圖」）───────────
 * 0026 加了 events.image_key 之後，這裡一路刻意不畫封面，理由是
 * imageFor(key, fallback) 永遠會回一張圖，對「還沒設圖」的活動渲染封面得到的不是
 * 「沒有封面」，而是一個假的灰框佔位——每一場都長一樣的那張。這個顧慮沒有消失，
 * 是被守住了：三塊新內容（大圖、相簿、講者）**各自**先判斷資料非空才畫，沒有資料
 * 就整塊不出現，不會出現空框或不相干的預設圖。
 *
 *   · 大圖：event.imageKey 非空才畫，用的正是後台表單一直在寫、也投影到
 *     products.image_key 給商店那一側用的同一欄。
 *   · 相簿：event.galleryKeys（0031 新加的 events.gallery_keys）非空陣列才畫。
 *   · 講者：event.speaker 非 null 才畫。這欄的真相在 public.artists（0025 的
 *     speaker_id 外鍵），不是新欄位——後台的「主講人」下拉一直都在，這一頁只是
 *     這一期才把它畫出來。見 src/lib/cms.ts#fetchEventBySlug 的檔頭。
 *
 * ⚠️ **版面刻意跟 /shop/$slug 不一樣**，不是偷懶漏抄：商品頁是「圖在左、資訊在
 *    右」的一次性兩欄格線（一張圖對一件商品）。這一頁是由上到下的編輯式排版——
 *    大圖是通欄的橫幅，相簿是多張縮圖的網格，講者是照片＋文字並排的小卡——因為
 *    一場活動可能有零到多張圖、有沒有講者也不一定，兩欄格線裝不下這種可變數量，
 *    勉強塞只會擠成「看起來像同一頁複製過來的」那種相似感。
 *
 * ── 三種讀取結果是三件事 ───────────────────────────────────────────────────
 *   查無此活動（或未發布）  → notFound()，真的 404
 *   讀取失敗                → 頁殼 + 「暫時無法載入」，**絕對不是 404**
 *   活動在、但沒有場次      → 完整渲染 + 空狀態文案，不是整塊消失
 *
 * PAGE 是頂層靜態常數、每一句都是 zh/en/ja 字面值：scripts/check-meta.mjs 靠靜態
 * 解析這個物件稽核三語，所以不可以改成算出來的值。
 */
const PAGE = {
  metaTitle: {
    zh: "活動｜小時光書店 Interval Books",
    en: "Event｜Interval Books",
    ja: "イベント｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店的一場活動：時間、場次與報名方式。",
    en: "An event at Interval Books — when it happens, which sittings are open, and how to join.",
    ja: "小時光書店の催しについて。日程、開催回、お申し込み方法をご案内します。",
  },
  back: { zh: "回到活動", en: "Back to events", ja: "イベント一覧へ" },
  aboutThis: { zh: "關於這場活動", en: "About this event", ja: "この催しについて" },
  registration: { zh: "報名", en: "Registration", ja: "お申し込み" },
  quantity: { zh: "報名人數", en: "How many places", ja: "お申し込み人数" },
  /**
   * 這個功能一直都在（人數選 2 就會出現兩組參加者欄位），但畫面上從來沒有一句話說過，
   * 等於藏起來。一個沒有人知道的功能與一個不存在的功能，在使用者那一端是同一件事。
   */
  quantityHint: {
    zh: "想找朋友一起來就把人數往上加，一筆訂單就報好；結帳時會逐位填寫參加者資料。",
    en: "Bringing friends? Turn the number up and book everyone in one order — we ask for each attendee's details at checkout.",
    ja: "ご友人とご一緒の場合は人数を増やしてください。1回のお申し込みでまとめて受け付けます（参加者ごとの情報はお手続き画面でご入力いただきます）。",
  },
  registerCta: { zh: "我要報名", en: "Register now", ja: "この回に申し込む" },
  registerNote: {
    zh: "按下之後直接進入結帳，會再請你填寫每一位參加者的資料。",
    en: "This takes you straight to checkout, where we ask for each attendee's details.",
    ja: "そのままお手続きへ進みます。次の画面で参加者お一人ずつの情報をご入力いただきます。",
  },
  pickSessionFirst: {
    zh: "請先選擇場次",
    en: "Please choose a sitting first",
    ja: "先に回をお選びください",
  },
  // 0036：這一場開了方案時，選完場次還要再選一個方案才能報名。
  pickPlanFirst: {
    zh: "請先選擇方案",
    en: "Please choose a plan first",
    ja: "先にプランをお選びください",
  },
  noSeats: {
    zh: "目前每一場都已額滿。歡迎來信詢問下一次的時間。",
    en: "Every sitting is full for now. Write to us and we will let you know about the next one.",
    ja: "現在すべての回が満席です。次回の日程についてはお問い合わせください。",
  },
  notOpen: {
    zh: "報名尚未開放。開放之後會在這裡放上報名連結。",
    en: "Registration is not open yet. The link will appear here once it is.",
    ja: "お申し込みはまだ開始していません。開始後、こちらにご案内を掲載します。",
  },
  unavailable: {
    zh: "活動資料暫時無法載入，請稍後再試。",
    en: "This event is temporarily unavailable. Please try again shortly.",
    ja: "イベント情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  registrationUnavailable: {
    zh: "報名資訊暫時無法載入，請稍後再試。",
    en: "Registration details are temporarily unavailable. Please try again shortly.",
    ja: "申し込み情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  aboutSpeaker: { zh: "關於講者", en: "About the speaker", ja: "講師について" },
  /**
   * 七個「一行一項」清單區塊的標題（0027）。鍵就是 EVENT_LIST_FIELDS 的欄位名，
   * 由 TypeScript 保證七個都有——日後在那份名單加一欄，這裡漏填會編譯失敗，
   * 而不是前台默默印出一個沒有標題的區塊。
   *
   * 用字要同時罩得住講座與策旅（同一個欄位，兩小時的講座與三天兩夜的旅程共用），
   * 所以是「流程」而不是「行程」或「課程大綱」。
   */
  listBlocks: {
    highlights: { zh: "活動亮點", en: "Highlights", ja: "ハイライト" },
    suitable_for: { zh: "適合這樣的你", en: "Who it's for", ja: "こんな方に" },
    not_suitable_for: { zh: "可能不適合", en: "Perhaps not for you", ja: "向いていない場合" },
    takeaways: { zh: "你會帶走什麼", en: "What you'll take away", ja: "持ち帰るもの" },
    outline: { zh: "流程", en: "Outline", ja: "進行内容" },
    includes: { zh: "費用包含", en: "What's included", ja: "含まれるもの" },
    notes: { zh: "注意事項", en: "Notes", ja: "ご注意" },
  } satisfies Record<(typeof EVENT_LIST_FIELDS)[number], Localized>,
  gallery: { zh: "更多照片", en: "More photos", ja: "その他の写真" },
};

/**
 * 活動自己的三語文案優先，活動還不知道是什麼的時候（讀取失敗）退回頁面層的常數
 * —— 同時也讓 scripts/check-meta.mjs 有一個靜態解得出來的物件字面值可以稽核。
 * 與 src/routes/shop.$slug.tsx 的 metaOr() 同一支。
 */
function metaOr(value: Localized | undefined, fallback: Localized): Localized {
  return value ?? fallback;
}

export const Route = createFileRoute("/events/$slug")({
  loader: async ({ params }) => {
    const [{ event, unavailable }, categories] = await Promise.all([
      fetchEventBySlug(params.slug),
      fetchEventCategories(),
    ]);
    // 這一行是這一頁最容易做錯的地方：只有「真的查不到」才 404。讀取失敗時
    // unavailable 為 true，於是這裡**不**丟 notFound()，改由元件渲染頁殼 ——
    // 不能因為資料庫眨一下眼，就告訴搜尋引擎這場活動不存在。
    if (!event && !unavailable) throw notFound();

    // 場次（0020 的 event_sessions）掛的是 products.id，不是 events.id，所以要先
    // 找到這場活動賣出去的那件商品。0026 之後這條反查走的是 products.slug
    // （= event-<events.slug>）這條唯一索引上的真連結，不再是 (source_type,
    // source_id) 加 limit(1)。
    //
    // ⚠️ 刻意等 event 回來再用 **event.slug** 問，不是拿 params.slug 直接問。
    //    兩者今天一定相等（DB 就是這樣查到這一列的），但拿回傳的那一列當權威，
    //    這一行就不會因為之後多了一層網址正規化（大小寫、尾斜線、舊網址轉址）而
    //    安靜地查錯東西。
    const booking = event
      ? await fetchActiveProductForEventSlug(event.slug)
      : { product: null, unavailable: false };

    return { event, unavailable, categories, booking };
  },
  head: ({ loaderData }) => {
    const event = loaderData?.event ?? null;
    const title = metaOr(event?.title, PAGE.metaTitle);
    const description = metaOr(event?.summary, PAGE.metaDescription);
    return {
      meta: [
        { title: title.zh },
        { name: "description", content: description.zh },
        { property: "og:title", content: title.zh },
        { property: "og:description", content: description.zh },
      ],
    };
  },
  component: EventDetail,
});

/** 報名按鈕的四種樣子。四種都要有畫面，沒有一種是「什麼都不畫」。 */
type RegistrationCta =
  | { kind: "external"; href: string }
  | { kind: "internal"; product: ShopProduct }
  | { kind: "closed" }
  | { kind: "unavailable" };

/**
 * 目的地照 events.registration_type 決定 —— 這是 0001 就存在、五期以來沒有任何
 * 路由讀過的兩個欄位之一（另一個是 payment_enabled，這一期仍然沒有人讀）。
 *
 * ── 🔴 這一頁現在真的有一個報名入口了（原本這裡寫著「不可以有」）────────────
 * 這段註解原本反對在活動頁做第二個結帳入口，理由是：「結帳是一條真管線
 * （cartInputFor → cart → checkout → 座位預留 → 金流 → 發票），而它的數量上限取的是
 * **選中那一場**的剩餘。第二個入口就是第二份那段邏輯，兩份遲早會長歪成『活動頁讓你買
 * 5 個位子、那一場只剩 1 個』。」
 *
 * **那個擔心是對的，所以它沒有被刪掉 —— 是那兩份被消掉了。** 這一頁現在讓客人選場次與
 * 人數，但它自己不算名額、也不建立訂單：
 *
 *   · 數量上限問的是 src/lib/direct-checkout.ts 的 directSeatLimit()，而那支只是
 *     cartInputFor(product, 1, session).limit —— 與購物車行的上限**是同一行程式碼**
 *     （src/lib/cart.ts:395）。這一頁沒有 remainingForSession、也沒有任何算式，
 *     所以「活動頁讓你買 5 個、那一場只剩 1 個」在結構上就發生不了。
 *   · 按鈕只是一個帶參數的 <Link to="/checkout">。品項在結帳頁由**同一份目錄資料**
 *     組回來，之後仍然走 placeOrder() → createOrder() 那八步。這一頁沒有第二條下單
 *     管線，也沒有第二份座位預留／發票／idempotency。
 *
 * 少掉的只有「商品頁 → 購物車」那兩頁 —— 它們對「哪一場、幾個人」沒有貢獻任何決定。
 * scripts/event-detail-page-selftest.mjs 的 [8] 就是在守上面這兩點。
 */
function registrationCta(
  registrationType: "external" | "internal",
  externalUrl: string,
  booking: { product: ShopProduct | null; unavailable: boolean },
): RegistrationCta {
  if (registrationType === "internal") {
    if (booking.product) return { kind: "internal", product: booking.product };
    // 「問不到」不等於「沒有」。讀取失敗時說「報名尚未開放」是一句它還不知道
    // 真假的話，所以分成兩種狀態。
    return booking.unavailable ? { kind: "unavailable" } : { kind: "closed" };
  }
  const href = externalUrl.trim();
  return href ? { kind: "external", href } : { kind: "closed" };
}

function EventDetail() {
  // 清單區塊取出來的是字串陣列，而 t() 只吃 Localized 字串，所以這裡要拿 lang
  // 自己選語系（規則與 t() 一致：當前語系沒東西就退回 zh）。
  const { t, lang } = useLang();
  const { event, unavailable, categories, booking } = Route.useLoaderData();
  const { ui } = useSiteContent();

  useDocumentMeta({
    title: metaOr(event?.title, PAGE.metaTitle),
    description: metaOr(event?.summary, PAGE.metaDescription),
    ogTitle: metaOr(event?.title, PAGE.metaTitle),
    ogDescription: metaOr(event?.summary, PAGE.metaDescription),
  });

  if (!event) {
    // 這裡只會是 unavailable === true：查無此活動已經在 loader 變成 404 了。
    // 留著這個分支不是防禦性寫法，是這一頁的第二種結果本來就長這樣。
    return (
      <PageShell>
        <section className="container-editorial py-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(PAGE.unavailable)}
          </p>
          <div className="mt-8">
            <BackLink label={t(PAGE.back)} />
          </div>
        </section>
      </PageShell>
    );
  }

  // 分類標籤查不到就退回 category 本身 —— events.category 的 id 就是中文字面值
  // （見 0001 的 event_categories 註解），所以退回去印出來仍然是讀得懂的字。
  const categoryLabel: Localized = categories.find((c) => c.id === event.category)?.label ?? {
    zh: event.category,
    en: event.category,
    ja: event.category,
  };

  const cta = registrationCta(event.registrationType, event.externalUrl, booking);

  return (
    <PageShell>
      <section className="container-editorial pt-12 md:pt-16">
        <BackLink label={t(PAGE.back)} />
      </section>

      <section className="container-editorial pb-12 pt-8">
        <p className="eyebrow text-2xl">{t(categoryLabel)}</p>
        <h1 className="display mt-4 text-4xl md:text-6xl leading-tight max-w-4xl">
          {t(event.title)}
        </h1>
        <p className="mt-6 text-sm tracking-widest text-muted-foreground">{event.date}</p>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
          {t(event.summary)}
        </p>
        <div className="rule mt-10" />
      </section>

      {/* 大圖。⚠️ event.imageKey 非空才畫這整塊——imageFor(key, fallback) 永遠
          會回一張圖，沒有判斷式的話，沒設圖的活動也會畫出同一張假灰框。
          整張圖照原比例完整顯示：以前是 aspect-[21/9] + object-cover 的通欄橫幅，
          直式海報被切到只剩中間一條、上面的標題字全不見。現在不套比例框，
          高度最多 80vh（太高的直式海報縮小置中，不必捲好幾屏才看到內文）。
          fallback 傳空字串：這個分支只在 imageKey 非空時才會執行，fallback
          永遠不會被用到，傳一個真的圖檔只是多一個沒有用途的 import。 */}
      {event.imageKey ? (
        <section className="container-editorial pb-16">
          {/* 沒有 loading="lazy"：這張通常是這頁的第一塊視覺內容（LCP 候選），
              lazy 反而會延後它，跟「載入速度優化」的目標反著走。不設 width/height：
              原比例未知（海報、照片都有），寫死比例的佔位反而會讓瀏覽器先排錯高度。 */}
          <img
            src={imageFor(event.imageKey, "")}
            alt={t(event.title)}
            className="mx-auto block h-auto max-h-[80vh] w-full object-contain"
          />
        </section>
      ) : null}

      {/* 引言。events.description 從 0001 就在資料裡，而 0001 自己的欄位註解寫著
          "not rendered by any route yet" —— 五期之後，它終於有工作了。
          whitespace-pre-line：這一欄是後台的多行輸入，換行是作者排的。 */}
      <section className="container-editorial pb-16">
        <div className="max-w-3xl">
          <p className="eyebrow text-2xl">{t(PAGE.aboutThis)}</p>
          <p className="mt-6 whitespace-pre-line text-base leading-relaxed text-foreground/80">
            {t(event.description)}
          </p>
        </div>
      </section>

      {/* 「一行一項」清單區塊（0027）。0027 建了欄位、後台一直能編，但前台在這一期
          之前從來沒有讀過它們——填了等於沒填。

          順序由 EVENT_LIST_FIELDS 決定（那份名單就是前台由上到下的順序）；空的那
          幾塊直接不畫，寧可少一塊，也不要印一個只有標題的空框。 */}
      {EVENT_LIST_FIELDS.map((field) => {
        const list = event.lists[field];
        // 與 t() 同一條規則：當前語系是空的就退回中文，不要讓整塊憑空消失。
        const items = list[lang].length ? list[lang] : list.zh;
        if (!items.length) return null;
        return (
          <section key={field} className="container-editorial pb-16">
            <div className="max-w-3xl border-t border-border pt-12">
              <p className="eyebrow text-2xl">{t(PAGE.listBlocks[field])}</p>
              <ul className="mt-6 space-y-3">
                {items.map((item, index) => (
                  <li
                    key={`${field}-${index}`}
                    className="text-base leading-relaxed text-foreground/80"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}

      {/* 講者介紹。event.speaker 非 null 才畫——真相在 public.artists，這一頁
          只是唯讀顯示。照片、頭銜、簡介三者各自再判斷一次非空，因為講者可以
          只填名字（例如還沒上傳照片）：那時候只印名字，不印一張不相干的照片
          或一段空白。 */}
      {event.speaker ? (
        <section className="container-editorial pb-16">
          <div className="max-w-3xl border-t border-border pt-12">
            <p className="eyebrow text-2xl">{t(PAGE.aboutSpeaker)}</p>
            <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-start">
              {event.speaker.imageKey ? (
                <img
                  src={imageFor(event.speaker.imageKey, "")}
                  alt={event.speaker.name}
                  loading="lazy"
                  width={160}
                  height={160}
                  className="h-32 w-32 shrink-0 rounded-full object-cover sm:h-40 sm:w-40"
                />
              ) : null}
              <div>
                <p className="text-lg font-medium">{event.speaker.name}</p>
                {event.speaker.title ? (
                  <p className="mt-1 text-xs tracking-widest text-muted-foreground">
                    {event.speaker.title}
                  </p>
                ) : null}
                {event.speaker.bio ? (
                  <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-foreground/80">
                    {event.speaker.bio}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* 相簿。event.galleryKeys 非空陣列才畫。RWD：手機兩欄、桌機三欄。 */}
      {event.galleryKeys.length > 0 ? (
        <section className="container-editorial pb-16">
          <div className="border-t border-border pt-12">
            <p className="eyebrow text-2xl">{t(PAGE.gallery)}</p>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {event.galleryKeys.map((key, i) => (
                <div key={`${key}-${i}`} className="aspect-square overflow-hidden bg-muted">
                  <img
                    src={imageFor(key, "")}
                    alt=""
                    loading="lazy"
                    width={600}
                    height={600}
                    className="h-full w-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="container-editorial pb-32">
        <div className="grid gap-12 border-t border-border pt-12 md:grid-cols-2 md:gap-16">
          {cta.kind === "internal" ? (
            <RegistrationPanel product={cta.product} />
          ) : (
            <>
              <SessionList
                sessions={booking.product?.sessions ?? []}
                // 商品還沒建立時沒有旗標可讀，退回「顯示」——那是 0029 的欄位預設，
                // 也是這一支之前的行為。（這條分支的 sessions 本來就是空的。）
                showSeatsRemaining={booking.product?.showSeatsRemaining ?? true}
              />

              <div>
                <p className="eyebrow text-2xl">{t(PAGE.registration)}</p>
                <div className="mt-6">
                  {cta.kind === "external" ? (
                    <a
                      href={cta.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block border border-foreground px-6 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
                    >
                      {t(ui.buttons.toEvent)}
                    </a>
                  ) : (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {cta.kind === "unavailable"
                        ? t(PAGE.registrationUnavailable)
                        : t(PAGE.notOpen)}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </PageShell>
  );
}

/**
 * 選場次、選人數、進結帳。這一區是這一頁唯一會寫入任何狀態的地方。
 *
 * ⚠️ 兩個狀態都只活在這個元件裡，**不進購物車、不進 localStorage**。這一頁連
 *    @/lib/cart 都沒有 import（見 registrationCta 上面那段），所以它不可能把任何東西
 *    留在瀏覽器上 —— 客人按下按鈕之前，這一頁對世界沒有任何副作用。
 *
 * 場次**有多場時不預選**。從多場裡幫客人挑一場，會讓「我選過了」與「系統幫我選了」在
 * 畫面上長得一樣，而這一頁下一步就是收錢。沒選場次時按鈕是一顆不能按的 <button>
 * （不是一個 <Link>），所以「沒選場次 → 進得了結帳」這件事在 DOM 上就沒有那條路可走。
 *
 * **剛好一場**是例外，直接預選：沒有第二個選項時「幫你挑」不成立，客人也不會誤以為
 * 自己選到了別的東西；讓他為了唯一的選項多點一下只是多一道關卡。⚠️ 但額滿的那一場
 * **不預選** —— 預選一個按不下去的場次，畫面會變成「已經選好了卻不能報名」，那比沒選
 * 更難懂。額滿時維持 null，客人看到的是場次上的「已額滿」。
 */
function RegistrationPanel({ product }: { product: ShopProduct }) {
  const t = useT();
  // 只在第一次 render 算一次。sessions 來自 loader，不會在這個元件的生命週期裡變。
  const [sessionId, setSessionId] = useState<string | null>(
    () => directSoleSession(product)?.id ?? null,
  );
  // 0036：這個場次選了哪個方案。跟 sessionId 一樣只活在這個元件裡，不進購物車。
  const [planId, setPlanId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);

  const selectedSession = product.sessions.find((s) => s.id === sessionId) ?? null;
  // 這個場次有沒有開方案——有的話報名前必須先選一個，沒有就照 0020 之後的行為，
  // 選完場次直接看得到數量與按鈕。
  const needsPlan = selectedSession !== null && selectedSession.plans.length > 0;
  const selectedPlan = selectedSession?.plans.find((p) => p.id === planId) ?? null;
  const readyToBook = selectedSession !== null && (!needsPlan || selectedPlan !== null);
  // 🔴 上限問 directSeatLimit()（→ cartInputFor().limit），這一頁自己不算。
  //    沒選場次時**不是**退回商品層級的數字 —— 那是跨場次最大值，拿它當數量上限正是
  //    這一期在防的 bug。沒選場次就把數量鎖在 1、連 stepper 都不能動。0036 起，
  //    選了方案時上限問的是那個方案（min(方案剩餘單位, floor(場次剩餘位子 /
  //    seatsPerUnit))，同樣是 cartInputFor() 算的，這一頁仍然不自己算）。
  const seatLimit = selectedSession ? directSeatLimit(product, selectedSession, selectedPlan) : 1;
  const anySeats = directAnySeatsLeft(product);

  return (
    <>
      {anySeats ? (
        <SessionPicker
          sessions={product.sessions}
          showSeatsRemaining={product.showSeatsRemaining}
          selectedId={sessionId}
          onSelect={(id) => {
            setSessionId(id);
            // 換場次就把方案與數量都收回——舊的方案可能不屬於新場次，舊的數量
            // 可能超過新場次（或新方案）的剩餘。與 src/routes/shop.$slug.tsx
            // 同一個決定。
            setPlanId(null);
            setQty(1);
          }}
        />
      ) : (
        <SessionList sessions={product.sessions} showSeatsRemaining={product.showSeatsRemaining} />
      )}

      {/* 0036：選了場次、而且那個場次有開方案，才畫方案選擇器——沒有方案的場次
          （陶作閱讀課那類）這裡完全不畫任何東西，畫面與 0020 之後逐字相同。 */}
      {selectedSession && needsPlan ? (
        <PlanPicker
          plans={selectedSession.plans}
          showSeatsRemaining={product.showSeatsRemaining}
          selectedId={planId}
          onSelect={(id) => {
            setPlanId(id);
            // 換方案就把數量收回 1：不同方案的名額上限不一樣。
            setQty(1);
          }}
        />
      ) : null}

      <div>
        <p className="eyebrow text-2xl">{t(PAGE.registration)}</p>
        {anySeats ? (
          <div className="mt-6 space-y-5">
            <div className="flex flex-wrap items-center gap-4">
              <QuantityStepper
                value={qty}
                max={seatLimit}
                onChange={(next) => setQty(Math.max(1, next))}
                label={t(PAGE.quantity)}
                disabled={!readyToBook}
              />
              {readyToBook && selectedSession ? (
                <Link
                  to="/checkout"
                  search={directCheckoutSearch(product, selectedSession, qty, selectedPlan)}
                  className="inline-block border border-foreground px-6 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
                >
                  {t(PAGE.registerCta)}
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-block cursor-not-allowed border border-border px-6 py-3 text-xs tracking-widest text-muted-foreground"
                >
                  {t(PAGE.registerCta)}
                </button>
              )}
            </div>
            {/* 人數選擇器就在上面一行，這一句貼著它 —— 它解釋的是那個 stepper 能做
                什麼，不是這一頁的總說明。沒選場次時 stepper 是鎖住的，但這句話仍然
                要出現：客人得先知道「可以幫朋友一起報名」，才會想去選場次。 */}
            <p className="text-sm leading-relaxed text-muted-foreground">{t(PAGE.quantityHint)}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {readyToBook
                ? t(PAGE.registerNote)
                : selectedSession === null
                  ? t(PAGE.pickSessionFirst)
                  : t(PAGE.pickPlanFirst)}
            </p>
          </div>
        ) : (
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{t(PAGE.noSeats)}</p>
        )}
      </div>
    </>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      to="/events"
      className="inline-flex items-center gap-2 text-xs tracking-widest text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
