/**
 * 場次選擇器：一組場次卡片，額滿的那幾張不能點。
 *
 * 從 src/routes/shop.$slug.tsx 原樣搬出來的 —— 之後的活動詳情頁要用同一個選擇器，
 * 而「一邊抽元件一邊寫新頁」出問題時分不清是哪一邊壞的。所以先單獨抽、讓現有的
 * 商品頁換上去、確認畫面與行為完全沒變，新頁才敢接。
 *
 * 這裡**不持有選中的是哪一場**。選中的場次同時決定了數量上限（見 shop.$slug.tsx
 * 對 remainingForSession 的用法），把它藏進元件裡的話，外面就得再想辦法問回來 ——
 * 所以 selectedId 由呼叫端持有，元件只負責畫與回報點了哪一張。
 *
 * 「還剩幾位」一律走 src/lib/shop.ts 的 remainingForSession()，不在這裡自己算。
 * 那個數字同時是購物車行的上限與伺服器端預檢的依據，多一份實作就是多一個會跟
 * 它們慢慢長歪的地方。
 *
 * ── showSeatsRemaining：那句「尚餘名額 N」印不印 ────────────────────────────
 * 0029 起這是**逐場活動**的編輯決定（events.show_seats_remaining → 投影到
 * products，見 src/lib/shop.ts 的同名欄位）。名額設得寬鬆時（實務上就是「不限」），
 * 「尚餘名額 999」對客人不是資訊、看起來還像壞掉；但名額真的緊的時候「尚餘名額 2」
 * 是會影響決定的資訊，所以不能全站拿掉。
 *
 * 🔴 **「已額滿」不受這個旗標影響，永遠要顯示。** 那是「你報不了名」，跟「還剩
 *    幾位」不是同一件事 —— 關掉名額顯示的活動額滿時，客人仍然必須看得出來，
 *    否則畫面上只剩一張看起來正常、按下去卻沒反應的卡片。底下兩個元件都是
 *    **先判 full、再判旗標**，順序反過來就是這個 bug。
 *
 * 🔴 這個 prop **沒有預設值，而且是必填的**。給它 `= true` 的預設看起來體貼，
 *    實際效果是「新的呼叫端忘記傳」與「這場活動要顯示」在型別上長得一樣 ——
 *    於是漏傳會靜默地退回舊行為，而那正是這個開關被加進來要修掉的東西。
 *    必填之後，漏傳是一個 tsc 錯誤。
 *
 * ── now：場次開始了沒（2026-11）────────────────────────────────────────────
 * 已開始的場次（isSessionClosedForBooking，與結帳伺服器、資料庫 0049 同一條規則）
 * 標「已結束」、不能選、不印「尚餘名額」。逐場次判斷：同一個活動早場開始了、晚場照常。
 * `now` 一樣**必填、沒有預設值**——預設 Date.now() 會讓 SSR 與 hydrate 各拿一個時間，
 * 開場那一秒就是 #418。呼叫端傳 useBookingNow()（src/hooks/use-booking-now.ts）的值。
 */
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { formatPrice, remainingForSession, type ShopProduct, type ShopSession } from "@/lib/shop";
import { SEATS_LEFT_LABEL } from "@/components/shop/labels";
import { isSessionClosedForBooking } from "@/lib/event-status";

const COPY: Record<
  | "chooseSession"
  | "sessionFull"
  | "noSessions"
  | "sessionsHeading"
  | "noPublicSessions"
  | "sessionEnded"
  | "eventEnded"
  | "eventEndedNote"
  | "free"
  | "fee",
  Localized
> = {
  sessionEnded: { zh: "已結束", en: "Ended", ja: "終了" },
  eventEnded: { zh: "活動已結束", en: "This event has ended", ja: "終了しました" },
  eventEndedNote: {
    zh: "這場活動已經結束，報名已關閉。謝謝每一位參與的朋友，下一場活動請見活動列表。",
    en: "This event has ended and registration is closed. Thank you to everyone who joined — see the events page for what's next.",
    ja: "この催しは終了し、お申し込みは締め切りました。ご参加いただいた皆さま、ありがとうございました。次回はイベント一覧をご覧ください。",
  },
  free: { zh: "免費", en: "Free", ja: "無料" },
  fee: { zh: "費用", en: "Fee", ja: "料金" },
  chooseSession: { zh: "選擇場次", en: "Choose a sitting", ja: "回を選ぶ" },
  sessionFull: { zh: "已額滿", en: "Full", ja: "満席" },
  noSessions: {
    zh: "目前沒有開放報名的場次。歡迎來信詢問下一次的時間。",
    en: "No sittings are open for booking right now. Write to us and we will let you know the next one.",
    ja: "現在お申し込みいただける回はありません。次回の日程についてはお問い合わせください。",
  },
  sessionsHeading: { zh: "場次", en: "Sittings", ja: "開催回" },
  noPublicSessions: {
    zh: "這場活動目前沒有公開的場次時間。確定之後會公布在這裡。",
    en: "No sitting times have been published for this event yet. They will appear here once they are set.",
    ja: "この催しの日程はまだ公開されていません。決まり次第こちらに掲載します。",
  },
};

export function SessionPicker({
  sessions,
  selectedId,
  onSelect,
  showSeatsRemaining,
  basePrice = null,
  now,
}: {
  sessions: ShopSession[];
  /** 判斷場次是否已開始的時間點（useBookingNow）。**必填**——理由見檔頭。 */
  now: number;
  /** 目前選中的場次 id，還沒選就是 null。 */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /**
   * 這場活動要不要印「尚餘名額 N」（products.show_seats_remaining）。
   * **必填、沒有預設值** —— 理由見檔頭。額滿不受它影響。
   */
  showSeatsRemaining: boolean;
  /**
   * 售票商品的 products.price。沒有票種的場次（0036 之前的單一價格）就印這個價格——
   * 結帳收的就是它，JSON-LD 的 Offer 也是它（2026-11 SEO 驗收 #3：頁面上要看得到）。
   * 有票種的場次不印（選了場次之後 PlanPicker 會列每個票種的價格）。
   */
  basePrice?: number | null;
}) {
  const t = useT();

  if (sessions.length === 0) {
    return (
      <p className="mb-8 text-sm leading-relaxed text-muted-foreground">{t(COPY.noSessions)}</p>
    );
  }

  return (
    <fieldset className="mb-8 space-y-3">
      <legend className="eyebrow text-xl">{t(COPY.chooseSession)}</legend>
      {sessions.map((session) => {
        const left = remainingForSession(session);
        const full = left <= 0;
        // 已開始的場次：不能選、標「已結束」、不印剩餘名額。比額滿更優先——開始了就
        // 沒有「還剩幾位」可言。已開始的場次即使 selectedId 指著它也不畫成選中。
        const closed = isSessionClosedForBooking(session, now);
        const selected = !closed && session.id === selectedId;
        // 🔴 額滿優先，旗標只管「還剩幾位」那一句。null = 這一行整個不畫
        //    （不是畫一個空的 <span>，那會留下一條 8px 的空白邊距）。
        const note = closed
          ? t(COPY.sessionEnded)
          : full
            ? t(COPY.sessionFull)
            : showSeatsRemaining
              ? `${t(SEATS_LEFT_LABEL)} ${left}`
              : null;
        const unavailable = closed || full;
        return (
          <button
            key={session.id}
            type="button"
            disabled={unavailable}
            data-session-closed={closed ? "true" : undefined}
            aria-pressed={selected}
            onClick={() => onSelect(session.id)}
            className={`block w-full border p-4 text-left transition-colors ${
              selected ? "border-foreground" : "border-border hover:border-foreground/50"
            } ${unavailable ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="block text-sm">{t(session.title)}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {formatSessionWhen(session.startsAt)}
              {" ・ "}
              {t(session.location)}
            </span>
            {(session.plans ?? []).length === 0 && basePrice !== null ? (
              <span className="mt-2 block text-sm">
                {t(COPY.fee)} {basePrice > 0 ? formatPrice(basePrice) : t(COPY.free)}
              </span>
            ) : null}
            {note === null ? null : (
              <span className="mt-2 block text-xs text-muted-foreground">{note}</span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * 唯讀的場次清單，給 /events/$slug 用。
 *
 * ── 為什麼不是直接用上面那個 SessionPicker ──────────────────────────────────
 * 活動詳情頁**不結帳**。它的報名按鈕是導到 /shop/<slug>（見 src/routes/events.$slug.tsx
 * 對 fetchActiveProductForEventSlug 的用法），數量上限、佔位、金流全都發生在那一頁。
 * 在這裡放一個選得動的選擇器，等於讓客人選了一場、按下去卻發現什麼都沒帶過去 ——
 * 那個選擇是假的。所以這裡畫的是同一組資訊、但不能點。
 *
 * ── 為什麼住在這個檔案裡而不是活動頁自己畫 ──────────────────────────────────
 * 它跟 SessionPicker 共用 formatSessionWhen() 與 remainingForSession()。這兩樣
 * 各自只能有一份：前者複製一份就是兩種日期格式，後者複製一份就是「商品頁與活動頁
 * 對同一場活動顯示不同的剩餘名額」——  scripts/event-registration-selftest.mjs 上一期
 * 就是為了這件事才把選擇器抽出來的。
 *
 * 空清單一律渲染一句話，不是 return null：活動頁沒有任何場次資訊等於斷頭，而
 * 「還沒公布」與「這一塊壞了」在畫面上必須長得不一樣。
 */
export function SessionList({
  sessions,
  showSeatsRemaining,
  basePrice = null,
  ended = false,
  now,
}: {
  sessions: ShopSession[];
  /**
   * 判斷場次是否已開始的時間點（useBookingNow）。已開始的那幾場標「已結束」。
   * **必填**；只有 EventEndedNotice（整個活動已結束，`ended` 蓋過一切）傳 null。
   */
  now: number | null;
  /**
   * 這場活動要不要印「尚餘名額 N」（products.show_seats_remaining）。
   * **必填、沒有預設值** —— 理由見檔頭。額滿不受它影響。
   */
  showSeatsRemaining: boolean;
  /** 見 SessionPicker 的 basePrice。這裡沒有 PlanPicker，所以有票種的場次也逐一列出票價。 */
  basePrice?: number | null;
  /** 活動已結束：每一場標「已結束」，不印「尚餘名額」／「已額滿」。 */
  ended?: boolean;
}) {
  const t = useT();

  return (
    <div>
      <p className="eyebrow text-2xl">{t(COPY.sessionsHeading)}</p>
      {sessions.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          {t(COPY.noPublicSessions)}
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {sessions.map((session) => {
            const left = remainingForSession(session);
            // 與 SessionPicker 同一條規則、同一個順序：額滿優先，旗標只管剩餘。
            // 已結束最優先（2026-11 SEO 驗收 #2：結束的活動不再印「尚餘名額」）。
            const closed = ended || (now !== null && isSessionClosedForBooking(session, now));
            const note = closed
              ? t(COPY.sessionEnded)
              : left <= 0
                ? t(COPY.sessionFull)
                : showSeatsRemaining
                  ? `${t(SEATS_LEFT_LABEL)} ${left}`
                  : null;
            const prices: Array<{ key: string; label: string | null; price: number }> =
              (session.plans ?? []).length > 0
                ? session.plans.map((p) => ({ key: p.id, label: t(p.title), price: p.price }))
                : basePrice !== null
                  ? [{ key: "base", label: null, price: basePrice }]
                  : [];
            return (
              <li
                key={session.id}
                className="border border-border p-4"
                data-session-closed={closed ? "true" : undefined}
              >
                <span className="block text-sm">{t(session.title)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {formatSessionWhen(session.startsAt)}
                  {" ・ "}
                  {t(session.location)}
                </span>
                {prices.map((p) => (
                  <span key={p.key} className="mt-2 block text-sm">
                    {p.label ?? t(COPY.fee)} {p.price > 0 ? formatPrice(p.price) : t(COPY.free)}
                  </span>
                ))}
                {note === null ? null : (
                  <span className="mt-2 block text-xs text-muted-foreground">{note}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 活動已結束時報名區的樣子（2026-11 SEO 驗收 #2）：場次與票價照列（JSON-LD 的價格要
 * 在頁面上看得到）、每一場標「已結束」、不印「尚餘名額」；報名按鈕停用並改文案，
 * DOM 裡沒有任何通往 /checkout 的連結。
 *
 * 「已結束」由呼叫端判斷（src/lib/seo/pages.ts 的 eventEnded() → event-status.ts 的
 * isEventEnded()），與 /events「已結束」分頁同一條規則。詳情頁與三個著陸頁都用這一個。
 * 2026-11 起另一個入口：每一個場次都已開始（direct-checkout.ts 的 directBookingClosed()
 * → isSessionClosedForBooking()），即使還沒過最後一個場次的結束日，也換成這個畫面。
 */
export function EventEndedNotice({
  product,
  heading,
  eyebrowClassName = "eyebrow text-2xl",
}: {
  product: ShopProduct;
  heading?: string;
  eyebrowClassName?: string;
}) {
  const t = useT();
  return (
    <>
      <SessionList
        sessions={product.sessions}
        showSeatsRemaining={false}
        basePrice={product.price}
        ended
        now={null}
      />
      <div data-event-ended="true">
        {heading ? <p className={eyebrowClassName}>{heading}</p> : null}
        <div className={heading ? "mt-6 space-y-5" : "mt-8 space-y-5"}>
          <button
            type="button"
            disabled
            className="inline-block cursor-not-allowed border border-border px-6 py-3 text-xs tracking-widest text-muted-foreground"
          >
            {t(COPY.eventEnded)}
          </button>
          <p className="text-sm leading-relaxed text-muted-foreground">{t(COPY.eventEndedNote)}</p>
        </div>
      </div>
    </>
  );
}

/** 店在台北。場次時間一律用這個時區呈現，與看的人在哪裡無關。 */
const SESSION_TIME_ZONE = "Asia/Taipei";

/**
 * 場次時間。與語系無關的固定格式：這個頁面是三語的，而 `toLocaleString` 會在
 * 三種語系之間給出三種長度差很多的字串，把卡片撐歪。
 *
 * 🔴 **時區寫死 Asia/Taipei，不可以用 getHours()／getDate() 那一組。**
 *    那一組讀的是「執行環境」的時區，而這個頁面是 SSR 的：伺服器跑在 UTC，
 *    所以 10:00 的場次會先被畫成 02:00，等瀏覽器接手才跳成 10:00。客人看到的
 *    第一眼是錯的，而這一頁在收錢。（實際發生過：2026-09-05 的陶藝工作坊
 *    上架後，活動頁與商品頁都印出「2026.09.05 02:00」。）
 *
 *    寫死台北而不是「使用者的時區」也是刻意的：實體活動的時間屬於店，不屬於
 *    看的人。人在東京看到的也該是台北時間 10:00，那才是他要出現的時刻。
 */
const SESSION_TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: SESSION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatSessionWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const part of SESSION_TIME_FORMAT.formatToParts(d)) p[part.type] = part.value;
  // en-CA 的 hour12:false 在午夜會給 "24"，這裡正規化回 "00"。
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}.${p.month}.${p.day} ${hour}:${p.minute}`;
}
