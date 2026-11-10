/**
 * /events 的月曆檢視（?view=calendar&month=YYYY-MM）。
 *
 * 一份資料、兩種畫法，用 CSS 斷點切換（SSR 安全：伺服器不知道螢幕多寬，兩種都先畫）：
 *   · md 以上：7 欄月曆（<table>，週日開頭）。每格列當天場次：時間＋短標題。
 *   · md 以下：議程（agenda）。7 欄在 375px 每格只剩 ~50px，標題一個字都放不下，所以改成
 *     依日期分組的列表：左邊日期方塊（日、星期），右邊標題、時間、地點、狀態。
 *
 * 月份切換是 <Link search>：不跑 JS 也能換月、網址可以分享、上一頁回得去。loader 沒有
 * loaderDeps，所以換月不會重新讀資料（全部場次一次讀完，書店的量很小）。
 *
 * 「今天」與「已結束」都用 loader 的時間（loadedAt）算 —— SSR 與 hydrate 拿到同一個值，
 * 不會 #418。日期一律台北（見 src/lib/events-calendar.ts 檔頭）。
 *
 * 只做呈現：點下去是既有的活動詳情頁 /events/<slug>，報名、場次、名額都在那裡。
 * 詳情頁沒有「預選場次」的網址參數，所以這裡不帶。
 */
import { Link } from "@tanstack/react-router";
import { useLang, useT } from "@/i18n/LanguageContext";
import type { EventsType } from "@/lib/events-type";
import {
  agendaGroups,
  dayLabel,
  itemsByDay,
  monthGrid,
  monthHasEntries,
  monthLabel,
  nearestMonthWithEntries,
  rangeLabel,
  shiftMonth,
  weekdayOf,
  WEEKDAYS,
  type CalendarEntry,
  type DayItem,
} from "@/lib/events-calendar";

const COPY = {
  prev: { zh: "上個月", en: "Previous month", ja: "前の月" },
  next: { zh: "下個月", en: "Next month", ja: "次の月" },
  thisMonth: { zh: "本月", en: "This month", ja: "今月" },
  full: { zh: "額滿", en: "Full", ja: "満席" },
  ended: { zh: "已結束", en: "Ended", ja: "終了" },
  journey: { zh: "策旅", en: "Journey", ja: "旅" },
  allDay: { zh: "全天", en: "All day", ja: "終日" },
  dayN: { zh: "第 {n} 天", en: "Day {n}", ja: "{n}日目" },
  empty: {
    zh: "這個月沒有排定的活動。",
    en: "No events are scheduled this month.",
    ja: "今月の予定はありません。",
  },
  jumpNext: { zh: "下一場在", en: "Next events in", ja: "次の予定" },
  jumpPrev: { zh: "上一場在", en: "Previous events in", ja: "前の予定" },
  unavailable: {
    zh: "活動月曆暫時無法載入，請切換到列表檢視，或稍後再試。",
    en: "The calendar is temporarily unavailable. Please use the list view or try again later.",
    ja: "カレンダーを一時的に読み込めません。リスト表示をご利用いただくか、後ほどお試しください。",
  },
  caption: { zh: "活動月曆", en: "Events calendar", ja: "イベントカレンダー" },
  today: { zh: "今天", en: "Today", ja: "今日" },
};

type Lang = "zh" | "en" | "ja";

const EN_MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fill(s: string, n: number) {
  return s.replace("{n}", String(n));
}

/** 一筆的狀態字（無障礙標籤與議程共用）。 */
function statusWords(entry: CalendarEntry, t: (l: Record<Lang, string>) => string): string[] {
  const words: string[] = [];
  if (entry.kind === "journey") words.push(t(COPY.journey));
  if (entry.ended) words.push(t(COPY.ended));
  else if (entry.full) words.push(t(COPY.full));
  return words;
}

function timeText(item: DayItem, t: (l: Record<Lang, string>) => string): string {
  const { entry, dayIndex, totalDays } = item;
  if (totalDays > 1) {
    const range = rangeLabel(entry);
    return dayIndex === 1 && entry.startTime ? `${range} ${entry.startTime}` : range;
  }
  if (!entry.startTime) return t(COPY.allDay);
  return entry.endTime ? `${entry.startTime}–${entry.endTime}` : entry.startTime;
}

function ariaFor(item: DayItem, date: string, lang: Lang, t: (l: Record<Lang, string>) => string) {
  const { entry } = item;
  const parts = [
    dayLabel(date, lang),
    timeText(item, t),
    t(entry.title) + (entry.detail ? ` ${t(entry.detail)}` : ""),
  ];
  if (item.totalDays > 1) parts.push(fill(t(COPY.dayN), item.dayIndex));
  parts.push(...statusWords(entry, t));
  return parts.join("，");
}

function Badge({ children, tone }: { children: string; tone: "clay" | "ink" | "muted" }) {
  const cls =
    tone === "clay"
      ? "border-clay text-clay"
      : tone === "ink"
        ? "border-foreground text-foreground"
        : "border-border text-muted-foreground";
  return (
    <span
      className={`inline-block border px-1.5 py-px text-[11px] leading-4 tracking-widest ${cls}`}
    >
      {children}
    </span>
  );
}

function MonthNav({
  month,
  currentMonth,
  type,
}: {
  month: string;
  currentMonth: string;
  type: EventsType | undefined;
}) {
  const t = useT();
  const { lang } = useLang();
  const btn =
    "inline-flex min-h-11 min-w-11 items-center justify-center border border-border px-3 text-sm tracking-widest transition-colors hover:border-foreground";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
      <h2 className="text-2xl font-light tracking-wide tabular-nums md:text-3xl" aria-live="polite">
        {monthLabel(month, lang)}
      </h2>
      <nav aria-label={t(COPY.caption)} className="flex items-center gap-2">
        <Link
          to="/events"
          search={{ view: "calendar", month: shiftMonth(month, -1), type }}
          resetScroll={false}
          className={btn}
          aria-label={t(COPY.prev)}
          data-testid="calendar-prev"
        >
          <span aria-hidden="true">‹</span>
          <span className="ml-1 hidden sm:inline">{t(COPY.prev)}</span>
        </Link>
        <Link
          to="/events"
          search={{ view: "calendar", month: currentMonth, type }}
          resetScroll={false}
          className={`${btn} ${month === currentMonth ? "text-muted-foreground" : ""}`}
          aria-current={month === currentMonth ? "date" : undefined}
          data-testid="calendar-today"
        >
          {t(COPY.thisMonth)}
        </Link>
        <Link
          to="/events"
          search={{ view: "calendar", month: shiftMonth(month, 1), type }}
          resetScroll={false}
          className={btn}
          aria-label={t(COPY.next)}
          data-testid="calendar-next"
        >
          <span className="mr-1 hidden sm:inline">{t(COPY.next)}</span>
          <span aria-hidden="true">›</span>
        </Link>
      </nav>
    </div>
  );
}

function EmptyMonth({
  entries,
  month,
  type,
}: {
  entries: CalendarEntry[];
  month: string;
  type: EventsType | undefined;
}) {
  const t = useT();
  const { lang } = useLang();
  const next = nearestMonthWithEntries(entries, month, 1);
  const prev = nearestMonthWithEntries(entries, month, -1);
  const link =
    "inline-flex min-h-11 items-center border border-foreground px-4 text-sm tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground";
  return (
    <div className="border border-border p-6 md:p-8" data-testid="calendar-empty">
      <p className="text-sm leading-relaxed text-muted-foreground">{t(COPY.empty)}</p>
      {next || prev ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {next ? (
            <Link
              to="/events"
              search={{ view: "calendar", month: next, type }}
              resetScroll={false}
              className={link}
            >
              {t(COPY.jumpNext)} {monthLabel(next, lang)} →
            </Link>
          ) : null}
          {prev ? (
            <Link
              to="/events"
              search={{ view: "calendar", month: prev, type }}
              resetScroll={false}
              className={link}
            >
              ← {t(COPY.jumpPrev)} {monthLabel(prev, lang)}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** md 以上：7 欄月曆。 */
function MonthTable({
  entries,
  month,
  today,
}: {
  entries: CalendarEntry[];
  month: string;
  today: string;
}) {
  const t = useT();
  const { lang } = useLang();
  const weeks = monthGrid(month);
  const byDay = itemsByDay(entries, month);
  return (
    <table className="w-full table-fixed border-collapse" data-testid="calendar-grid">
      <caption className="sr-only">
        {t(COPY.caption)} {monthLabel(month, lang)}
      </caption>
      <thead>
        <tr>
          {WEEKDAYS[lang].map((w, i) => (
            <th
              key={w}
              scope="col"
              className={`border-b border-border pb-2 text-left text-xs font-normal tracking-widest ${
                i === 0 || i === 6 ? "text-clay" : "text-muted-foreground"
              }`}
            >
              {w}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0].date}>
            {week.map((day) => {
              const items = day.inMonth ? (byDay.get(day.date) ?? []) : [];
              const isToday = day.date === today;
              return (
                <td
                  key={day.date}
                  className={`h-32 border border-border p-1.5 align-top ${
                    day.inMonth ? "" : "bg-muted/40"
                  }`}
                  aria-label={day.inMonth ? dayLabel(day.date, lang) : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex h-6 min-w-6 items-center justify-center text-xs tabular-nums ${
                        isToday
                          ? "bg-foreground px-1 text-primary-foreground"
                          : day.inMonth
                            ? "text-foreground"
                            : "text-muted-foreground/60"
                      }`}
                    >
                      {Number(day.date.slice(8))}
                    </span>
                    {isToday ? (
                      <span className="text-[11px] tracking-widest text-muted-foreground">
                        {t(COPY.today)}
                      </span>
                    ) : null}
                  </div>
                  {items.length ? (
                    <ul className="mt-1 space-y-1">
                      {items.map((item) => (
                        <li key={item.entry.key}>
                          <GridItem item={item} date={day.date} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GridItem({ item, date }: { item: DayItem; date: string }) {
  const t = useT();
  const { lang } = useLang();
  const { entry, dayIndex, totalDays } = item;
  const continued = dayIndex > 1;
  return (
    <Link
      to="/events/$slug"
      params={{ slug: entry.slug }}
      aria-label={ariaFor(item, date, lang, t)}
      data-testid="calendar-item"
      className={`block border-l-2 px-1.5 py-1 text-xs leading-snug transition-colors hover:bg-muted ${
        entry.kind === "journey" ? "border-clay bg-oat/60" : "border-foreground/70"
      } ${entry.ended ? "opacity-50" : ""}`}
    >
      <span className="flex flex-wrap items-center gap-1">
        {continued ? (
          <span className="text-muted-foreground">{fill(t(COPY.dayN), dayIndex)}</span>
        ) : (
          <span className="tabular-nums text-muted-foreground">
            {entry.startTime ?? t(COPY.allDay)}
          </span>
        )}
        {entry.kind === "journey" && !continued ? (
          <Badge tone="clay">{t(COPY.journey)}</Badge>
        ) : null}
        {!entry.ended && entry.full && !continued ? <Badge tone="ink">{t(COPY.full)}</Badge> : null}
      </span>
      <span className="mt-0.5 line-clamp-2 break-words">
        {t(entry.title)}
        {entry.detail && t(entry.detail) && !continued ? (
          <span className="text-muted-foreground">｜{t(entry.detail)}</span>
        ) : null}
      </span>
      {totalDays > 1 && !continued ? <span className="sr-only">{rangeLabel(entry)}</span> : null}
    </Link>
  );
}

/** md 以下：議程。 */
function Agenda({
  entries,
  month,
  today,
}: {
  entries: CalendarEntry[];
  month: string;
  today: string;
}) {
  const t = useT();
  const { lang } = useLang();
  const groups = agendaGroups(entries, month);
  return (
    <ol className="divide-y divide-border border-y border-border" data-testid="calendar-agenda">
      {groups.map((g) => {
        const [, m, d] = g.date.split("-").map(Number);
        const isToday = g.date === today;
        return (
          <li key={g.date} className="flex gap-4 py-4">
            <div
              className={`flex w-14 shrink-0 flex-col items-center justify-center self-start border py-2 ${
                isToday
                  ? "border-foreground bg-foreground text-primary-foreground"
                  : "border-border"
              }`}
              aria-hidden="true"
            >
              <span className="text-[11px] tracking-widest opacity-70">
                {lang === "en" ? EN_MONTH_ABBR[m - 1] : `${m}月`}
              </span>
              <span className="text-2xl font-light leading-none tabular-nums">{d}</span>
              <span className="mt-1 text-xs">{WEEKDAYS[lang][weekdayOf(g.date)]}</span>
            </div>
            <ul className="min-w-0 flex-1 space-y-2">
              {g.items.map((item) => {
                const { entry } = item;
                return (
                  <li key={entry.key}>
                    <Link
                      to="/events/$slug"
                      params={{ slug: entry.slug }}
                      aria-label={ariaFor(item, g.date, lang, t)}
                      data-testid="agenda-item"
                      className={`block min-h-11 py-1 transition-colors hover:text-clay ${
                        entry.ended ? "opacity-50" : ""
                      }`}
                    >
                      <span className="block text-base leading-snug break-words">
                        {t(entry.title)}
                        {entry.detail && t(entry.detail) ? (
                          <span className="text-muted-foreground">｜{t(entry.detail)}</span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-sm tabular-nums text-muted-foreground">
                        {timeText(item, t)}
                        {item.dayIndex > 1 ? ` ・ ${fill(t(COPY.dayN), item.dayIndex)}` : ""}
                      </span>
                      {entry.location ? (
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground break-words">
                          {t(entry.location)}
                        </span>
                      ) : null}
                      {statusWords(entry, t).length ? (
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {entry.kind === "journey" ? (
                            <Badge tone="clay">{t(COPY.journey)}</Badge>
                          ) : null}
                          {entry.ended ? (
                            <Badge tone="muted">{t(COPY.ended)}</Badge>
                          ) : entry.full ? (
                            <Badge tone="ink">{t(COPY.full)}</Badge>
                          ) : null}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

export function EventsCalendar({
  entries,
  month,
  currentMonth,
  today,
  unavailable,
  type,
}: {
  entries: CalendarEntry[];
  /** 正在看的月份 "YYYY-MM"。 */
  month: string;
  /** 台北的本月（loader 時間）。 */
  currentMonth: string;
  /** 台北的今天（loader 時間）"YYYY-MM-DD"。 */
  today: string;
  unavailable: boolean;
  /**
   * /events 的類型篩選（?type=）。entries 已經由呼叫端篩過；這裡只負責讓換月、「本月」、
   * 「跳到下一個有場次的月份」這幾個連結把 type 帶著走，不會一換月就回到「全部」。
   */
  type?: EventsType;
}) {
  const t = useT();
  const has = monthHasEntries(entries, month);
  return (
    <div data-testid="events-calendar">
      <MonthNav month={month} currentMonth={currentMonth} type={type} />
      {unavailable ? (
        <div className="border border-border p-6 md:p-8">
          <p className="text-sm leading-relaxed text-muted-foreground">{t(COPY.unavailable)}</p>
        </div>
      ) : (
        <>
          <div className="hidden md:block">
            <MonthTable entries={entries} month={month} today={today} />
            {has ? null : (
              <div className="mt-6">
                <EmptyMonth entries={entries} month={month} type={type} />
              </div>
            )}
          </div>
          <div className="md:hidden">
            {has ? (
              <Agenda entries={entries} month={month} today={today} />
            ) : (
              <EmptyMonth entries={entries} month={month} type={type} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
