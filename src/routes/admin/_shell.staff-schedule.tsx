/**
 * /admin/staff-schedule —— 門市排班
 *
 * 只讀的排班規劃說明，給管理員看兼職夥伴怎麼輪班。沒有資料表、沒有 server fn：
 * 內容全在 src/lib/admin/staff-schedule.ts，要改班表只改那一支，這一頁只負責畫出來。
 *
 * 權限：登入由 _shell 的 beforeLoad 擋；這一頁再把門市人員（staff）導回櫃檯
 * （同 _shell.index.tsx 的慣例），側欄連結也是 staff: false。這一頁沒有任何資料
 * 從 server 讀出來，也不含個資，所以不需要 adminFnMiddleware。
 */
import type { ReactNode } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CalendarClock, Info, Scale } from "lucide-react";
import {
  HEADLINE,
  HOURS_NOTE,
  LEGAL_REMINDERS,
  PLACEHOLDER_NOTE,
  PROCESS_STEPS,
  SHIFTS,
  SHIFT_NOTE,
  STAFF,
  STAFFING_FACTS,
  WEEK,
  staffWeeklyHours,
  type StaffCode,
} from "@/lib/admin/staff-schedule";

export const Route = createFileRoute("/admin/_shell/staff-schedule")({
  beforeLoad: ({ context }) => {
    if (context.user?.role === "staff") {
      throw redirect({ to: "/admin/pos" });
    }
  },
  head: () => ({ meta: [{ title: "門市排班｜小時光書店後台" }] }),
  component: StaffSchedulePage,
});

/**
 * 每位夥伴一個淡色底（從品牌的 oat／clay 色相延伸，再各偏一個色相），字一律用 ink，
 * 對比都在 10:1 以上。顏色只是輔助，格子裡一定同時寫代號／名字。
 */
const STAFF_TONE: Record<StaffCode, string> = {
  A: "bg-[oklch(0.92_0.04_60)] border-[oklch(0.72_0.07_60)]",
  B: "bg-[oklch(0.93_0.04_140)] border-[oklch(0.7_0.07_140)]",
  C: "bg-[oklch(0.93_0.035_230)] border-[oklch(0.7_0.06_230)]",
  D: "bg-[oklch(0.93_0.04_350)] border-[oklch(0.72_0.07_350)]",
};

const nameOf = (code: StaffCode) => STAFF.find((s) => s.code === code)?.name ?? code;

function StaffChip({ code, prefix }: { code: StaffCode; prefix?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-sm font-medium text-foreground ${STAFF_TONE[code]}`}
    >
      {prefix && <span className="text-xs font-normal">{prefix}</span>}
      {nameOf(code)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

const ROW_DEFS = [
  { key: "early", label: "早班" },
  { key: "late", label: "晚班" },
  { key: "extra", label: "加強／整理" },
] as const;

function cellFor(day: (typeof WEEK)[number], row: (typeof ROW_DEFS)[number]["key"]) {
  if (row === "early") return <StaffChip code={day.early} />;
  if (row === "late") return <StaffChip code={day.late} />;
  if (!day.extra) return <span className="text-muted-foreground">—</span>;
  return (
    <StaffChip code={day.extra.staff} prefix={day.extra.shift === "weekend" ? "加強" : "整理"} />
  );
}

function StaffSchedulePage() {
  const summary = staffWeeklyHours();

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-medium">門市排班</h1>
        <p className="text-base">{HEADLINE}</p>
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {PLACEHOLDER_NOTE}
        </p>
      </header>

      <Section title="營業與人力">
        <dl className="grid gap-3 sm:grid-cols-2">
          {STAFFING_FACTS.map((f) => (
            <div key={f.label} className="rounded-md border border-border bg-card px-4 py-3">
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd className="mt-1 text-sm">{f.value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="班別">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  班別
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  時間
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  工時
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  內容
                </th>
              </tr>
            </thead>
            <tbody>
              {SHIFTS.map((s) => (
                <tr key={s.key} className="border-t border-border">
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                    {s.label}
                  </th>
                  <td className="px-3 py-2">{s.time}</td>
                  <td className="whitespace-nowrap px-3 py-2">{s.hours} 小時</td>
                  <td className="px-3 py-2">{s.duty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground">{SHIFT_NOTE}</p>
      </Section>

      <Section title="範例週班表">
        <ul className="flex flex-wrap gap-2" aria-label="夥伴色標">
          {STAFF.map((s) => (
            <li key={s.code}>
              <StaffChip code={s.code} />
            </li>
          ))}
        </ul>

        {/* 桌機：一週一張表 */}
        <div className="hidden overflow-x-auto rounded-md border border-border md:block">
          <table className="w-full text-sm">
            <caption className="sr-only">範例週班表，週一到週日</caption>
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="w-28 px-3 py-2 text-left font-medium">
                  <span className="sr-only">班別</span>
                </th>
                {WEEK.map((d) => (
                  <th
                    key={d.day}
                    scope="col"
                    className={`px-2 py-2 text-center font-medium ${d.weekend ? "text-[var(--clay)]" : ""}`}
                  >
                    {d.day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROW_DEFS.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {row.label}
                  </th>
                  {WEEK.map((d) => (
                    <td key={d.day} className="px-2 py-2 text-center">
                      {cellFor(d, row.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 手機：每日一張卡 */}
        <ol className="grid gap-2 md:hidden">
          {WEEK.map((d) => (
            <li key={d.day} className="rounded-md border border-border bg-card px-3 py-2">
              <p className={`text-sm font-medium ${d.weekend ? "text-[var(--clay)]" : ""}`}>
                週{d.day}
              </p>
              <dl className="mt-1 grid grid-cols-[5.5rem_1fr] items-center gap-y-1 text-sm">
                {ROW_DEFS.filter((row) => row.key !== "extra" || d.extra).map((row) => (
                  <div key={row.key} className="contents">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd>{cellFor(d, row.key)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="每人每週時數">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[360px] text-sm">
            <thead className="bg-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  夥伴
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  每週時數
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  週末班
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.code} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <StaffChip code={s.code} />
                  </th>
                  <td className="whitespace-nowrap px-3 py-2">{s.hours} 小時</td>
                  <td className="px-3 py-2">{s.weekendShifts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground">{HOURS_NOTE}</p>
      </Section>

      <Section title="法規提醒">
        <ul className="space-y-2 rounded-md border border-border bg-card px-4 py-3 text-sm">
          {LEGAL_REMINDERS.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Scale className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="排班流程">
        <ol className="space-y-2 text-sm">
          {PROCESS_STEPS.map((step, i) => (
            <li key={step} className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
                {i + 1}
              </span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
        </ol>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          班表內容寫在 src/lib/admin/staff-schedule.ts，要調整請改那一支檔案。
        </p>
      </Section>
    </div>
  );
}
