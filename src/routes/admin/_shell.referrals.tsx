/**
 * /admin/referrals —— 推廣與分潤（0040）
 *
 * 一頁四塊：月結報表（每位推廣者的訂單、毛利、分潤、獎金池、扣回、應付、標記已結算、
 * CSV）、推廣者管理（新增／編輯／停用、複製連結）、全站預設（一張設定卡）。
 *
 * 所有數字由伺服器算（src/lib/referral.ts computeMonthlyReport，有自檢）；這一頁只負責
 * 顯示。
 *
 * 2026-10-26 起新增／編輯推廣者不再是彈窗（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到
 * 上一頁」）：連到 /admin/referrals/new、/admin/referrals/$id（ReferrerForm）。月份的選擇與那個
 * 月份的報表交給 useLoaderBackedList：背景重抓會反映在畫面上，從內頁回來月份原樣還原。
 * 「標記已結算」的確認仍是 window.confirm（一句話的確認，不是表單）。授權：src/lib/admin/fns/referrals.ts 每一支都掛 adminFnMiddleware，側欄
 * staff: false 只是畫面。時間一律經 src/lib/taipei-time.ts。
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, Download, Handshake, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toCsv } from "@/lib/csv";
import {
  referralLink,
  type MonthlyReport,
  type ReferralSettings,
  type ReferrerResult,
} from "@/lib/referral";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import { textToTiers, tiersLabel, tiersToText } from "@/lib/admin/referral-tiers";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import { currentTaipeiMonth, formatTaipeiDateTime, shiftPeriod } from "@/lib/taipei-time";
import type { ReferrerRow } from "@/server/repos/referrals";

export const Route = createFileRoute("/admin/_shell/referrals")({
  loader: async () => {
    const { listReferrersAdmin, getReferralReportAdmin } =
      await import("@/lib/admin/fns/referrals");
    const period = shiftPeriod(currentTaipeiMonth(), -1);
    const [list, report] = await Promise.all([
      listReferrersAdmin(),
      getReferralReportAdmin({ data: { period } }),
    ]);
    return { ...list, report, period };
  },
  head: () => ({ meta: [{ title: "推廣與分潤｜小時光書店後台" }] }),
  component: ReferralsPage,
});

function money(n: number) {
  const s = Math.abs(Math.round(n)).toLocaleString("zh-TW");
  return n < 0 ? `−NT$ ${s}` : `NT$ ${s}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("已複製");
  } catch {
    toast.error("無法複製，請手動選取");
  }
}

type ReferralsData = {
  referrers: ReferrerRow[];
  settings: ReferralSettings;
  report: MonthlyReport;
};

function ReferralsPage() {
  const loaded = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });

  // 月份＝這張列表的「篩選」：換月份 → 重抓；背景重抓、寫入後重抓會反映在畫面上；
  // 從推廣者內頁回來，月份原樣還原（lib/admin/useLoaderBackedList.ts）。
  const loaderData = useMemo<ReferralsData>(
    () => ({ referrers: loaded.referrers, settings: loaded.settings, report: loaded.report }),
    [loaded.referrers, loaded.settings, loaded.report],
  );
  const list = useLoaderBackedList({
    key: "referrals",
    loaderFilter: loaded.period,
    loaderData,
    loaderUpdatedAt,
    errorMessage: "讀取失敗",
    fetcher: async (p: string): Promise<ReferralsData> => {
      const fns = await import("@/lib/admin/fns/referrals");
      const [l, report] = await Promise.all([
        fns.listReferrersAdmin(),
        fns.getReferralReportAdmin({ data: { period: p } }),
      ]);
      return { referrers: l.referrers, settings: l.settings, report };
    },
  });
  const period = list.filter;
  const setPeriod = list.setFilter;
  const { referrers, settings, report } = list.data;
  const loading = list.loading;
  const reload = list.reload;

  const thisMonth = currentTaipeiMonth();
  const months = useMemo(
    () => Array.from({ length: 13 }, (_, i) => shiftPeriod(thisMonth, -i)),
    [thisMonth],
  );

  async function settle(r: ReferrerResult) {
    const ok = window.confirm(
      `確定把 ${r.referrer.name}（${r.referrer.code}）${period} 標記為已結算？\n應付 ${money(r.payable)}。\n結算後這個月不能再結一次。`,
    );
    if (!ok) return;
    try {
      const { settleReferralAdmin } = await import("@/lib/admin/fns/referrals");
      const res = await settleReferralAdmin({
        data: { referrerId: r.referrer.id, period, note: null },
      });
      if (res.ok) toast.success(`已結算 ${money(res.amount)}`);
      else
        toast.error(
          res.reason === "month_not_over"
            ? "這個月還沒過完，不能結算"
            : res.reason === "already_settled"
              ? "這個月已經結算過了"
              : "找不到這位推廣者",
        );
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "結算失敗");
    }
  }

  function exportCsv() {
    type Row = { r: ReferrerResult; o: ReferrerResult["orders"][number] | null };
    const rows: Row[] = report.referrers.flatMap((r) => [
      ...r.orders.map((o) => ({ r, o })),
      { r, o: null },
    ]);
    const csv = toCsv(rows, [
      { header: "月份", value: () => period },
      { header: "推廣者", value: (x) => x.r.referrer.name },
      { header: "推薦碼", value: (x) => x.r.referrer.code },
      { header: "類型", value: (x) => (x.r.referrer.kind === "team" ? "團隊成員" : "外部推廣者") },
      { header: "訂單編號", value: (x) => (x.o ? x.o.orderNo : "（合計）"), forceText: true },
      { header: "付款時間", value: (x) => (x.o ? formatTaipeiDateTime(x.o.paidAt) : "") },
      {
        header: "新舊客",
        value: (x) => (x.o ? (x.o.customerType === "new" ? "新客" : "舊客") : ""),
      },
      { header: "排除", value: (x) => (x.o?.excluded === "self" ? "自購" : "") },
      { header: "選品金額", value: (x) => (x.o ? x.o.goodsSubtotal : "") },
      { header: "折扣", value: (x) => (x.o ? x.o.discount : "") },
      { header: "折後營收", value: (x) => (x.o ? x.o.netRevenue : x.r.attributedRevenue) },
      { header: "毛利", value: (x) => (x.o ? x.o.grossProfit : x.r.attributedGrossProfit) },
      { header: "毛利為估算", value: (x) => (x.o ? (x.o.costEstimated ? "是" : "否") : "") },
      { header: "分潤", value: (x) => (x.o ? x.o.commission : x.r.commission) },
      { header: "獎金池", value: (x) => (x.o ? "" : x.r.poolShare) },
      { header: "扣回", value: (x) => (x.o ? "" : -x.r.clawback.amount) },
      { header: "應付", value: (x) => (x.o ? "" : x.r.payable) },
      {
        header: "已結算",
        value: (x) =>
          x.o
            ? ""
            : x.r.settlement
              ? `${x.r.settlement.amount}（${formatTaipeiDateTime(x.r.settlement.settledAt)}）`
              : "",
      },
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `推廣分潤_${period}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const monthOver = period < thisMonth;

  return (
    <div className="space-y-8">
      <h1 className="flex items-center gap-2 text-lg font-medium">
        <Handshake className="h-5 w-5" aria-hidden="true" />
        推廣與分潤
      </h1>

      {/* ── 月結報表 ───────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="period">月份（台北時間）</Label>
            <select
              id="period"
              className="block h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={loading}
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === thisMonth ? "（本月，進行中）" : ""}
                </option>
              ))}
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={loading}>
            <Download className="mr-1 h-4 w-4" />
            匯出 CSV
          </Button>
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
        </div>

        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          <SummaryCard
            label="線上選品營收"
            value={money(report.shop.revenue)}
            hint={`${report.shop.orderCount} 張含選品的已付款訂單`}
          />
          <SummaryCard
            label="選品毛利"
            value={money(report.shop.grossProfit)}
            hint={
              report.shop.estimatedLines > 0
                ? `其中 ${report.shop.estimatedLines}/${report.shop.totalLines} 行是用預設毛利率 ${settings.defaultMarginPercent}% 估算`
                : "全部使用進銷存進價"
            }
          />
          <SummaryCard label="分潤合計" value={money(report.totals.commission)} />
          <SummaryCard
            label="團隊獎金池"
            value={money(report.totals.poolShare)}
            hint={
              !report.pool.enabled
                ? "未設定門檻，不計算"
                : report.pool.undistributed
                  ? `池子 ${money(report.pool.amount)}，但沒有啟用中的團隊成員`
                  : `超過門檻 ${money(report.pool.excess)}，分給 ${report.pool.members} 位團隊成員`
            }
          />
          <SummaryCard label="應付合計" value={money(report.totals.payable)} />
        </div>

        {report.cap.applied ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            本月分潤＋獎金池原本是 {money(report.cap.requested)}，超過上限（選品毛利 ×{" "}
            {settings.payoutCapPercent}% = {money(report.cap.limit)}），已全部等比例縮為{" "}
            {Math.round(report.cap.factor * 1000) / 10}%。
          </p>
        ) : null}
        {!monthOver ? (
          <p className="text-sm text-muted-foreground">
            這個月還沒過完，數字會繼續變動；過完才能標記已結算。
          </p>
        ) : null}

        {report.referrers.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有推廣者。先在下方新增一位。</p>
        ) : (
          <div className="space-y-4">
            {report.referrers.map((r) => (
              <ReferrerReportCard
                key={r.referrer.id}
                r={r}
                canSettle={monthOver}
                onSettle={() => void settle(r)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 推廣者管理 ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">推廣者</h2>
          <Button asChild size="sm">
            <Link preload="intent" to="/admin/referrals/new">
              <Plus className="mr-1 h-4 w-4" />
              新增推廣者
            </Link>
          </Button>
        </div>
        <div className="space-y-2">
          {referrers.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border p-3 text-sm"
            >
              <div className="min-w-[10rem] flex-1">
                <p className="font-medium">
                  {p.name}{" "}
                  <Badge
                    variant={p.kind === "team" ? "default" : "secondary"}
                    className="ml-1 font-normal"
                  >
                    {p.kind === "team" ? "團隊成員" : "外部推廣者"}
                  </Badge>
                  {!p.active ? (
                    <Badge variant="outline" className="ml-1 font-normal">
                      已停用
                    </Badge>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  折扣 {p.discount_percent ?? settings.defaultDiscountPercent}%
                  {p.discount_percent === null ? "（預設）" : ""}・分潤{" "}
                  {p.commission_tiers ? `個人級距 ${tiersLabel(p.commission_tiers)}` : "全站級距"}
                  {p.contact ? `・${p.contact}` : ""}
                </p>
              </div>
              <code className="rounded bg-muted px-2 py-1 text-sm font-semibold tracking-wider">
                {p.code}
              </code>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void copy(referralLink(p.code))}>
                  <Copy className="mr-1 h-4 w-4" />
                  複製連結
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/admin/referrals/$id"
                    params={{ id: p.id }}
                    preload="intent"
                    onClick={() => rememberAdminPeek("referrer", p.id, p)}
                  >
                    <Pencil className="mr-1 h-4 w-4" />
                    編輯
                  </Link>
                </Button>
              </div>
            </div>
          ))}
          {referrers.length === 0 ? (
            <p className="text-sm text-muted-foreground">還沒有推廣者。</p>
          ) : null}
        </div>
      </section>

      {/* ── 全站預設 ───────────────────────────────────────────── */}
      <SettingsCard settings={settings} onSaved={() => void reload()} />
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-medium tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ReferrerReportCard({
  r,
  canSettle,
  onSettle,
}: {
  r: ReferrerResult;
  canSettle: boolean;
  onSettle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {r.referrer.name}{" "}
            <code className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">{r.referrer.code}</code>{" "}
            <span className="text-xs text-muted-foreground">
              {r.referrer.kind === "team" ? "團隊成員" : "外部推廣者"}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {r.orders.length} 張推薦訂單・歸屬營收 {money(r.attributedRevenue)}・歸屬毛利{" "}
            {money(r.attributedGrossProfit)}・平均費率 {r.averageRate}%
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">應付</p>
          <p
            className={`text-lg font-medium tabular-nums ${r.payable < 0 ? "text-destructive" : ""}`}
          >
            {money(r.payable)}
          </p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
        <dt className="text-muted-foreground">分潤</dt>
        <dd className="text-right sm:text-left">
          {money(r.commission)}
          {r.commission !== r.commissionBeforeCap ? (
            <span className="ml-1 text-xs text-muted-foreground">
              （上限前 {money(r.commissionBeforeCap)}）
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">團隊獎金池</dt>
        <dd className="text-right sm:text-left">{money(r.poolShare)}</dd>
        <dt className="text-muted-foreground">退款扣回</dt>
        <dd className="text-right sm:text-left">
          {r.clawback.amount > 0 ? `−${money(r.clawback.amount)}` : money(0)}
          {r.clawback.orders.length > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">
              （{r.clawback.orders.map((c) => c.orderNo).join("、")}）
            </span>
          ) : null}
        </dd>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.settlement ? (
          <p className="text-sm">
            <Badge className="mr-2 font-normal">已結算</Badge>
            {money(r.settlement.amount)}・{formatTaipeiDateTime(r.settlement.settledAt)}・
            {r.settlement.settledByEmail ?? "—"}
            {r.settledDiffers ? (
              <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                現在重算是 {money(r.payable)}，與已付不同（多半是結算後才有變動的訂單）
              </span>
            ) : null}
          </p>
        ) : (
          <Button size="sm" variant="outline" onClick={onSettle} disabled={!canSettle}>
            標記已結算
          </Button>
        )}
        {r.orders.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "收起訂單" : "看訂單"}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>訂單</TableHead>
                <TableHead>付款時間</TableHead>
                <TableHead>客人</TableHead>
                <TableHead className="text-right">選品</TableHead>
                <TableHead className="text-right">折扣</TableHead>
                <TableHead className="text-right">毛利</TableHead>
                <TableHead className="text-right">分潤</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="whitespace-nowrap">{o.orderNo}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatTaipeiDateTime(o.paidAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {o.customerType === "new" ? "新客" : "舊客"}
                    {o.excluded === "self" ? (
                      <Badge variant="outline" className="ml-1 font-normal">
                        自購不計
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(o.goodsSubtotal)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">−{money(o.discount)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(o.grossProfit)}
                    {o.costEstimated ? (
                      <span className="ml-1 text-xs text-muted-foreground">估</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.commission)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// -----------------------------------------------------------------------------
// 全站預設
// -----------------------------------------------------------------------------

function SettingsCard({ settings, onSaved }: { settings: ReferralSettings; onSaved: () => void }) {
  const [v, setV] = useState(() => ({
    defaultDiscountPercent: String(settings.defaultDiscountPercent),
    defaultMarginPercent: String(settings.defaultMarginPercent),
    tiers: tiersToText(settings.commissionTiers),
    newCustomerMultiplier: String(settings.newCustomerMultiplier),
    teamPoolBaseline: settings.teamPoolBaseline === null ? "" : String(settings.teamPoolBaseline),
    teamPoolPercent: String(settings.teamPoolPercent),
    teamPoolEqualPercent: String(settings.teamPoolEqualPercent),
    payoutCapPercent: String(settings.payoutCapPercent),
    clawbackDays: String(settings.clawbackDays),
  }));
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    const tiers = textToTiers(v.tiers);
    if (!tiers) {
      toast.error("分潤級距格式不對，例如：10000:15, 30000:20, :25");
      return;
    }
    setSaving(true);
    try {
      const { updateReferralSettingsAdmin } = await import("@/lib/admin/fns/referrals");
      await updateReferralSettingsAdmin({
        data: {
          defaultDiscountPercent: Number(v.defaultDiscountPercent),
          defaultMarginPercent: Number(v.defaultMarginPercent),
          commissionTiers: tiers,
          newCustomerMultiplier: Number(v.newCustomerMultiplier),
          teamPoolBaseline: v.teamPoolBaseline.trim() === "" ? null : Number(v.teamPoolBaseline),
          teamPoolPercent: Number(v.teamPoolPercent),
          teamPoolEqualPercent: Number(v.teamPoolEqualPercent),
          payoutCapPercent: Number(v.payoutCapPercent),
          clawbackDays: Number(v.clawbackDays),
        },
      });
      toast.success("已儲存設定");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請檢查數字範圍");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-3 sm:p-4">
      <h2 className="text-base font-medium">全站預設</h2>
      <p className="text-xs text-muted-foreground">
        改了之後，所有還沒結算的月份都會用新的設定重算；已結算的金額不會變。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="客人折扣預設 %">
          <Input
            inputMode="decimal"
            value={v.defaultDiscountPercent}
            onChange={set("defaultDiscountPercent")}
          />
        </Field>
        <Field label="沒有進價時的估算毛利率 %">
          <Input
            inputMode="decimal"
            value={v.defaultMarginPercent}
            onChange={set("defaultMarginPercent")}
          />
        </Field>
        <Field label="新客分潤倍率">
          <Input
            inputMode="decimal"
            value={v.newCustomerMultiplier}
            onChange={set("newCustomerMultiplier")}
          />
        </Field>
        <div className="sm:col-span-3">
          <Field label="分潤級距（月歸屬毛利，累進）">
            <Input value={v.tiers} onChange={set("tiers")} placeholder="10000:15, 30000:20, :25" />
          </Field>
        </div>
        <Field label="團隊獎金池門檻（月線上選品營收，空白＝不計算）">
          <Input
            inputMode="numeric"
            value={v.teamPoolBaseline}
            onChange={set("teamPoolBaseline")}
          />
        </Field>
        <Field label="獎金池 %（超過門檻的部分）">
          <Input inputMode="decimal" value={v.teamPoolPercent} onChange={set("teamPoolPercent")} />
        </Field>
        <Field label="獎金池平分比例 %（其餘按毛利占比）">
          <Input
            inputMode="decimal"
            value={v.teamPoolEqualPercent}
            onChange={set("teamPoolEqualPercent")}
          />
        </Field>
        <Field label="發放上限（占當月選品毛利 %）">
          <Input
            inputMode="decimal"
            value={v.payoutCapPercent}
            onChange={set("payoutCapPercent")}
          />
        </Field>
        <Field label="退款扣回期限（結算月結束後幾天）">
          <Input inputMode="numeric" value={v.clawbackDays} onChange={set("clawbackDays")} />
        </Field>
      </div>
      <Button size="sm" onClick={() => void save()} disabled={saving}>
        {saving ? "儲存中…" : "儲存設定"}
      </Button>
    </section>
  );
}
