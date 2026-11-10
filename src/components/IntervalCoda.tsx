/**
 * 「店名的由來」：休止符記號＋INTERVAL＋「留一段屬於自己的＿＿＿小時光。」＋一段說明。
 *
 * 2026-11-10 業主要求從首頁最後的收尾段搬到 /about（故事段之後、「我們做的事」之前）。
 * 樣式沿用首頁原本那一段：置中、休止符記號、句中「＿＿＿」畫成一段細線。
 *
 * 句子本身（motto）仍是 pages/'index' 的 hero.intro —— 後台一直在那一格改它，/about 的
 * loader 會一起讀 index 那一列，所以改了照樣生效。INTERVAL 小標與說明文從來不在 CMS
 * （首頁時代就是程式預設值），一起搬到這裡。
 *
 * 英日文 2026-11-10 修正：音樂上的 interval 是「音程」，不是休止符；改成「幕與幕之間的停頓，
 * 像樂譜上的休止符」的說法。中文是業主原文，不動。
 */
import type { Localized } from "@/i18n/types";
import { RestMark } from "@/components/RestMark";

export const INTERVAL_COPY = {
  kicker: { zh: "INTERVAL", en: "INTERVAL", ja: "INTERVAL" },
  /** hero.intro 讀不到時的後備（與 pages/'index' 目前的值相同）。 */
  motto: {
    zh: "留一段屬於自己的＿＿＿小時光。",
    en: "Keep an interval that belongs only to you.",
    ja: "あなただけの小さな時間を、ひとつ。",
  },
  body: {
    zh: "INTERVAL 是樂譜上的休止符。休止不是空白，是讓音樂呼吸的地方。那一格留給你——讀的、聊的，或出發的。",
    en: "An interval is the pause between two acts—like a rest in a score, it lets the music breathe. That space is yours: to read, to talk, or to set out.",
    ja: "INTERVAL は、幕と幕のあいだのひと休み。楽譜の休符のように、音楽に息をつかせる間です。その余白はあなたのもの——読むために、語るために、出かけるために。",
  },
} satisfies Record<string, Localized>;

/** 「＿＿＿」：motto 裡刻意的留白。畫成一段細線，螢幕閱讀器略過不唸。 */
const BLANK_RE = /[＿_]{2,}/;

export function IntervalCoda({
  kicker,
  motto,
  body,
  className = "",
  testId,
}: {
  kicker: string;
  motto: string;
  body: string;
  className?: string;
  testId?: string;
}) {
  const [before, after] = BLANK_RE.test(motto) ? motto.split(BLANK_RE) : [motto, null];
  return (
    <section
      className={`container-editorial text-center ${className}`}
      aria-labelledby="interval-coda-title"
      data-testid={testId}
    >
      <RestMark className="mx-auto text-clay" />
      <p className="mt-6 text-xs tracking-[0.4em] text-clay">{kicker}</p>
      <h2
        id="interval-coda-title"
        className="display mx-auto mt-6 max-w-3xl text-3xl leading-[1.5] md:text-[2.6rem]"
      >
        {before}
        {after !== null ? (
          <>
            <span
              aria-hidden="true"
              className="mx-2 inline-block w-[3.5em] translate-y-[-0.2em] border-b border-clay align-baseline"
            />
            {after}
          </>
        ) : null}
      </h2>
      <p className="mx-auto mt-8 max-w-xl text-[0.95rem] leading-[1.95] text-muted-foreground">
        {body}
      </p>
    </section>
  );
}
