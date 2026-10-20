/**
 * 「一頁新增活動」——/admin/events/new 打開的那一頁。
 *
 * 一張表單、由上到下四段（基本 → 場次 → 報名與費用 → 發布）、一顆按鈕，就把一場
 * 「看得到、買得到」的活動建好：活動＋商品＋場次＋票種，全部走既有的那一套
 * （products → event_sessions → event_session_plans，見 CLAUDE.md 最上面那一節）。
 * 寫入在 src/server/event-quick-create.ts，純邏輯在 src/lib/admin/event-quick-create.ts。
 *
 * 組裝器（_shell.events.$id.tsx）沒有被取代：建好之後的細修（亮點、流程、FAQ、相簿、
 * 英日文潤稿…）照舊在那裡做，成功畫面有一顆「進階編輯」直接過去。
 *
 * ⚠️ ImageField 是複合元件，不包 <FormControl>（組裝器檔頭的雷 5）。這一頁乾脆不用
 *    react-hook-form：場次與票種是兩組可增減的列，用一份 useState 加同一支
 *    validateQuickCreate()（server 寫入前也跑同一支）比較直接。
 */
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useBlocker, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ImageField } from "@/components/admin/ImageField";
import { eventReading } from "@/lib/images";
import {
  DEFAULT_LOCATION,
  DEFAULT_PLAN_NAME,
  deriveDisplayDate,
  emptyPlan,
  emptySession,
  initialQuickCreate,
  normalizeForSubmit,
  validateQuickCreate,
  type QuickCreateErrors,
  type QuickKind,
  type QuickCreateInput,
  type QuickPlanInput,
  type QuickRegistrationMode,
  type QuickSessionInput,
} from "@/lib/admin/event-quick-create";
import type { Localized } from "@/i18n/types";

type CategoryOption = { id: string; label: Localized };
type ArtistOption = { id: string; name: string; discipline: string | null; is_active: boolean };

/**
 * 活動與策旅的字。**同一個元件、同一支寫入**，差別只在這張表（與策旅多的回程日期、
 * 主題、卡片）。不要為策旅複製一份元件 —— 兩份表單遲早會長歪。
 */
const COPY = {
  event: {
    noun: "活動",
    sessionNoun: "場次",
    listPath: "/admin/events",
    listLabel: "回活動列表",
    backLabel: "返回活動列表",
    titlePlaceholder: "例如：《海的聲音》手作繪本分享會",
    locationLabel: "地點",
    dateLabel: "日期",
    startLabel: "開始",
    endLabel: "結束",
    intro:
      "填完這一頁按「建立活動」，活動、場次、票種一次建好。亮點、流程、常見問答等細節，建好之後再到「進階編輯」補。",
  },
  journey: {
    noun: "策旅",
    sessionNoun: "梯次",
    listPath: "/admin/journeys",
    listLabel: "回策旅列表",
    backLabel: "返回策旅列表",
    titlePlaceholder: "例如：2026 台東池上秋收山海旅行",
    locationLabel: "集合地點",
    dateLabel: "出發日期",
    startLabel: "出發時間",
    endLabel: "回程時間",
    intro:
      "填完這一頁按「建立策旅」，策旅卡片、報名頁、梯次、票種一次建好。報名與付款走跟活動同一套（策旅的報名頁就是一場活動頁）；行程、FAQ 等細節建好之後再到「進階編輯」補。",
  },
} as const;

/** Radix 的 <SelectItem> 不接受 value=""，「不指定主講人」用哨兵值（同組裝器）。 */
const NO_SPEAKER = "__none__";

const MODE_OPTIONS: { value: QuickRegistrationMode; label: string; hint: string }[] = [
  { value: "paid", label: "付費報名", hint: "客人在本站選日期、選票種、線上付款。" },
  { value: "free", label: "免費報名", hint: "客人在本站報名，不用付錢，名單一樣進後台。" },
  {
    value: "external",
    label: "外部連結",
    hint: "報名在別的網站（例如 Google 表單），這裡只放連結。",
  },
];

type Created = {
  eventId: string;
  slug: string;
  published: boolean;
  untranslated: number;
  sessionCount: number;
  planCount: number;
};

/* ------------------------------------------------------------------ *
 * 小元件
 * ------------------------------------------------------------------ */

function Step({
  n,
  title,
  description,
  children,
}: {
  n: number;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-md border border-border p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Badge variant="outline" className="mt-0.5 shrink-0 font-mono">
          {n}
        </Badge>
        <div className="min-w-0">
          <h2 className="text-lg font-medium">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id?: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5" data-error={error ? "true" : undefined}>
      <Label htmlFor={id} className={error ? "text-destructive" : undefined}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/** 數字輸入：空字串存成 NaN（驗證會擋下來），畫面上顯示空白而不是 NaN。 */
function numberValue(n: number): string | number {
  return Number.isNaN(n) ? "" : n;
}
function parseNumber(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

/* ------------------------------------------------------------------ *
 * 本體
 * ------------------------------------------------------------------ */

export function EventQuickCreate({
  kind = "event",
  categories,
  artists,
}: {
  kind?: QuickKind;
  categories: CategoryOption[];
  artists: ArtistOption[];
}) {
  const router = useRouter();
  const copy = COPY[kind];
  const isJourney = kind === "journey";
  /** 策旅預設選名稱帶「策旅」的那個分類（正式庫是「策旅說明會」），找不到就留空讓人選。 */
  const initial = (): QuickCreateInput => ({
    ...initialQuickCreate(kind),
    category: isJourney ? (categories.find((c) => c.id.includes("策旅"))?.id ?? "") : "",
  });
  const [values, setValues] = useState<QuickCreateInput>(initial);
  const [errors, setErrors] = useState<QuickCreateErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const touched = useRef(false);

  const activeArtists = useMemo(() => artists.filter((a) => a.is_active), [artists]);
  const previewDate = deriveDisplayDate(values.sessions);

  /** 改任何一欄都走這裡：記下「有東西沒存」，送出過一次之後即時重驗。 */
  function update(next: QuickCreateInput) {
    touched.current = true;
    setValues(next);
    if (attempted) setErrors(validateQuickCreate(next));
  }
  const set = <K extends keyof QuickCreateInput>(key: K, value: QuickCreateInput[K]) =>
    update({ ...values, [key]: value });

  function setSession(i: number, patch: Partial<QuickSessionInput>) {
    set(
      "sessions",
      values.sessions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }
  function addSession() {
    // 新的一列沿用上一列的地點、名額、時間（同一系列活動最常見的情況），日期留空。
    const last = values.sessions[values.sessions.length - 1];
    set("sessions", [
      ...values.sessions,
      last ? { ...last, date: "", end_date: "" } : emptySession(kind),
    ]);
  }
  function removeSession(i: number) {
    set(
      "sessions",
      values.sessions.filter((_, idx) => idx !== i),
    );
  }
  function setPlan(i: number, patch: Partial<QuickPlanInput>) {
    set(
      "plans",
      values.plans.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    );
  }

  /* 離開守衛：填了東西還沒送出就換頁／關分頁，先問一句（同組裝器的做法）。 */
  const shouldBlock = () => touched.current && !created;
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });

  async function handleSubmit() {
    setAttempted(true);
    const payload = normalizeForSubmit(values);
    const found = validateQuickCreate(payload);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      toast.error(`還有 ${Object.keys(found).length} 個欄位要修正（紅字標示）`);
      // 捲到第一個紅字。等下一個 frame，讓錯誤先畫出來。
      requestAnimationFrame(() => {
        document
          .querySelector('[data-error="true"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return;
    }

    setSubmitting(true);
    try {
      const { createEventQuick } = await import("@/lib/admin/fns/events");
      const result = await createEventQuick({ data: payload });
      setCreated({
        eventId: result.eventId,
        slug: result.slug,
        published: result.published,
        untranslated: result.untranslated,
        sessionCount: result.sessionIds.length,
        planCount: result.planIds.length,
      });
      toast.success(result.published ? `${copy.noun}已建立並發布` : `${copy.noun}已存成草稿`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      // 列表頁（父路由）的 loader 要拿到這一場。
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "建立失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    touched.current = false;
    setValues(initial());
    setErrors({});
    setAttempted(false);
    setCreated(null);
  }

  /* ── 成功畫面 ─────────────────────────────────────────────────────── */
  if (created) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-md border border-border p-6 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-3 text-2xl font-medium">
            {created.published ? `${copy.noun}已建立並發布` : `${copy.noun}已存成草稿`}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {created.sessionCount > 0
              ? `已建立 ${created.sessionCount} 個${copy.sessionNoun}${created.planCount > 0 ? `、${created.planCount} 個票種` : ""}${isJourney ? "，以及 /journeys 上的策旅卡片" : ""}。`
              : `這場使用外部連結報名，沒有建立${copy.sessionNoun}。`}
            {created.published
              ? "前台現在就看得到。"
              : `草稿前台看不到；確認好之後到「進階編輯」打開「發布狀態」並把商品改成「已上架」${isJourney ? "，策旅卡片則在策旅列表按「編輯」打開發布" : ""}。`}
          </p>
          {created.untranslated > 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              有 {created.untranslated}{" "}
              段英日文沒自動翻譯成功，暫時放中文——可以到進階編輯按「自動翻譯」補上。
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              英文、日文版已自動翻譯，可到進階編輯潤稿。
            </p>
          )}
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button variant="outline" asChild className="gap-1.5">
              <a href={`/events/${created.slug}`} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                查看前台頁面
              </a>
            </Button>
            <Button asChild>
              <Link to="/admin/events/$id" params={{ id: created.eventId }}>
                進階編輯（組裝器）
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to={copy.listPath}>{copy.listLabel}</Link>
            </Button>
          </div>
          <button
            type="button"
            onClick={startOver}
            className="mt-4 text-sm text-muted-foreground underline underline-offset-4"
          >
            再新增一場
          </button>
        </div>
      </div>
    );
  }

  const internal = values.mode !== "external";

  /* ── 表單 ─────────────────────────────────────────────────────────── */
  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-28">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 gap-1.5" asChild>
          <Link to={copy.listPath}>
            <ArrowLeft className="h-4 w-4" />
            {copy.backLabel}
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-medium">新增{copy.noun}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{copy.intro}</p>
      </div>

      {/* ── 1. 基本 ─────────────────────────────────────────────── */}
      <Step n={1} title="基本資料">
        <Field id="qc-title" label={`${copy.noun}名稱`} required error={errors.title}>
          <Input
            id="qc-title"
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={copy.titlePlaceholder}
          />
        </Field>

        {isJourney ? (
          <Field
            id="qc-theme"
            label="旅程主題（選填）"
            hint="策旅卡片上的一句話，例如「池上秋收稻穗藝術節」。留空就用分類名稱。"
          >
            <Input
              id="qc-theme"
              value={values.theme}
              onChange={(e) => set("theme", e.target.value)}
            />
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="分類"
            required
            error={errors.category}
            hint={categories.length === 0 ? "還沒有任何分類，請先到「活動分類」新增。" : undefined}
          >
            <Select value={values.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger aria-label="分類">
                <SelectValue placeholder="請選擇分類" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label.zh}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="主講人（選填）" hint="講者資料在「講者」頁維護；不選就不顯示講者介紹。">
            <Select
              value={values.speaker_id ?? NO_SPEAKER}
              onValueChange={(v) => set("speaker_id", v === NO_SPEAKER ? null : v)}
            >
              <SelectTrigger aria-label="主講人">
                <SelectValue placeholder="不指定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SPEAKER}>不指定</SelectItem>
                {activeArtists.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.discipline ? `（${a.discipline}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="space-y-1.5">
          <Label>封面圖（選填）</Label>
          <ImageField
            value={values.image_key}
            onChange={(key) => set("image_key", key)}
            fallback={eventReading}
            hint="建議橫式 4:3（例如 1600×1200）。直式海報也會完整顯示。"
          />
        </div>

        <Field
          id="qc-description"
          label={`${copy.noun}簡介`}
          required
          error={errors.description}
          hint="會顯示在活動頁「關於這場活動」。第一段同時當作列表卡片上的一句話摘要，所以第一段寫最重要的。可以換行分段。"
        >
          <Textarea
            id="qc-description"
            rows={7}
            value={values.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={"一句話說明這場活動在做什麼、適合誰。\n\n第二段之後可以寫詳細內容。"}
          />
        </Field>
      </Step>

      {/* ── 2. 場次 ─────────────────────────────────────────────── */}
      <Step
        n={2}
        title={copy.sessionNoun}
        description={
          internal
            ? isJourney
              ? "時間一律是台灣時間。出發與回程可以是不同天；同一條路線開好幾梯就「再加一個梯次」，客人報名時可以選。"
              : "時間一律是台灣時間。同一場活動辦好幾梯就「再加一個場次」，客人報名時可以選。"
            : `外部連結報名不會在本站建立${copy.sessionNoun}，這裡的日期只用來顯示在列表上（可以不填）。`
        }
      >
        {errors.sessions ? (
          <p className="text-sm font-medium text-destructive" data-error="true">
            {errors.sessions}
          </p>
        ) : null}
        <ol className="space-y-3">
          {values.sessions.map((s, i) => {
            const k = `sessions.${i}`;
            const canRemove = values.sessions.length > 1 || !internal;
            return (
              <li key={i} className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {copy.sessionNoun} {i + 1}
                  </p>
                  {canRemove ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 text-muted-foreground"
                      onClick={() => removeSession(i)}
                    >
                      <Trash2 className="h-4 w-4" />
                      移除
                    </Button>
                  ) : null}
                </div>
                <div
                  className={`grid grid-cols-2 gap-3 ${isJourney ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}
                >
                  <div className={isJourney ? "" : "col-span-2 sm:col-span-1"}>
                    <Field
                      id={`qc-s${i}-date`}
                      label={copy.dateLabel}
                      required
                      error={errors[`${k}.date`]}
                    >
                      <Input
                        id={`qc-s${i}-date`}
                        type="date"
                        value={s.date}
                        onChange={(e) => setSession(i, { date: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field
                    id={`qc-s${i}-start`}
                    label={copy.startLabel}
                    required
                    error={errors[`${k}.start`]}
                  >
                    <Input
                      id={`qc-s${i}-start`}
                      type="time"
                      value={s.start}
                      onChange={(e) => setSession(i, { start: e.target.value })}
                    />
                  </Field>
                  {isJourney ? (
                    <Field id={`qc-s${i}-enddate`} label="回程日期" error={errors[`${k}.end_date`]}>
                      <Input
                        id={`qc-s${i}-enddate`}
                        type="date"
                        value={s.end_date}
                        min={s.date || undefined}
                        onChange={(e) => setSession(i, { end_date: e.target.value })}
                      />
                    </Field>
                  ) : null}
                  <Field
                    id={`qc-s${i}-end`}
                    label={copy.endLabel}
                    required
                    error={errors[`${k}.end`]}
                  >
                    <Input
                      id={`qc-s${i}-end`}
                      type="time"
                      value={s.end}
                      onChange={(e) => setSession(i, { end: e.target.value })}
                    />
                  </Field>
                </div>
                {internal ? (
                  <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                    <Field
                      id={`qc-s${i}-loc`}
                      label={copy.locationLabel}
                      required
                      error={errors[`${k}.location`]}
                      hint={
                        s.location.trim() === DEFAULT_LOCATION.zh
                          ? "預設是書店本店（英日文地址已內建）。"
                          : undefined
                      }
                    >
                      <Input
                        id={`qc-s${i}-loc`}
                        value={s.location}
                        onChange={(e) => setSession(i, { location: e.target.value })}
                      />
                    </Field>
                    <Field
                      id={`qc-s${i}-cap`}
                      label="名額"
                      required
                      error={errors[`${k}.capacity`]}
                    >
                      <Input
                        id={`qc-s${i}-cap`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={numberValue(s.capacity)}
                        onChange={(e) => setSession(i, { capacity: parseNumber(e.target.value) })}
                      />
                    </Field>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="outline" className="w-full gap-1.5" onClick={addSession}>
          <Plus className="h-4 w-4" />
          再加一個{copy.sessionNoun}
        </Button>
        <p className="text-sm text-muted-foreground">
          列表上會顯示：<span className="font-medium text-foreground">{previewDate}</span>
        </p>
      </Step>

      {/* ── 3. 報名與費用 ───────────────────────────────────────── */}
      <Step n={3} title="報名與費用">
        <RadioGroup
          value={values.mode}
          onValueChange={(v) => set("mode", v as QuickRegistrationMode)}
          className="grid gap-2 sm:grid-cols-3"
        >
          {MODE_OPTIONS.map((o) => (
            <Label
              key={o.value}
              htmlFor={`qc-mode-${o.value}`}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal ${
                values.mode === o.value ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <RadioGroupItem id={`qc-mode-${o.value}`} value={o.value} className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>

        {values.mode === "paid" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              票種會套用到每一個{copy.sessionNoun}；每個票種的名額就是該{copy.sessionNoun}
              的名額。付款走站上既有的結帳（線上刷卡／匯款）。
            </p>
            {errors.plans ? (
              <p className="text-sm font-medium text-destructive" data-error="true">
                {errors.plans}
              </p>
            ) : null}
            <ol className="space-y-2">
              {values.plans.map((p, i) => (
                <li key={i} className="grid grid-cols-[1fr_8rem_auto] items-start gap-2">
                  <Field
                    id={`qc-p${i}-name`}
                    label={i === 0 ? "票種名稱" : `票種 ${i + 1}`}
                    required
                    error={errors[`plans.${i}.name`]}
                  >
                    <Input
                      id={`qc-p${i}-name`}
                      value={p.name}
                      onChange={(e) => setPlan(i, { name: e.target.value })}
                      placeholder={DEFAULT_PLAN_NAME}
                    />
                  </Field>
                  <Field
                    id={`qc-p${i}-price`}
                    label="價格（NT$）"
                    required
                    error={errors[`plans.${i}.price`]}
                  >
                    <Input
                      id={`qc-p${i}-price`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={numberValue(p.price)}
                      onChange={(e) => setPlan(i, { price: parseNumber(e.target.value) })}
                    />
                  </Field>
                  <div className="pt-6">
                    {values.plans.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`移除票種 ${i + 1}`}
                        onClick={() =>
                          set(
                            "plans",
                            values.plans.filter((_, idx) => idx !== i),
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : (
                      <span className="block w-9" />
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              className="w-full gap-1.5"
              onClick={() => set("plans", [...values.plans, emptyPlan()])}
            >
              <Plus className="h-4 w-4" />
              再加一個票種
            </Button>
          </div>
        ) : null}

        {values.mode === "free" ? (
          <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            客人報名不用付款，送出就算報名成功；名單在「活動報名」頁。名額照上面每個
            {copy.sessionNoun}填的數字。
          </p>
        ) : null}

        {values.mode === "external" ? (
          <Field
            id="qc-url"
            label="報名網址"
            required
            error={errors.external_url}
            hint="前台的「報名」按鈕會直接連到這裡。"
          >
            <Input
              id="qc-url"
              type="url"
              inputMode="url"
              value={values.external_url}
              onChange={(e) => set("external_url", e.target.value)}
              placeholder="https://forms.gle/…"
            />
          </Field>
        ) : null}
      </Step>

      {/* ── 4. 發布 ─────────────────────────────────────────────── */}
      <Step n={4} title="發布">
        <RadioGroup
          value={values.publish ? "publish" : "draft"}
          onValueChange={(v) => set("publish", v === "publish")}
          className="grid gap-2 sm:grid-cols-2"
        >
          {[
            { v: "publish", label: "立即發布", hint: "建好就出現在前台，客人可以報名。" },
            { v: "draft", label: "先存草稿", hint: "前台看不到，之後在進階編輯打開發布。" },
          ].map((o) => (
            <Label
              key={o.v}
              htmlFor={`qc-pub-${o.v}`}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal ${
                (values.publish ? "publish" : "draft") === o.v
                  ? "border-primary bg-primary/5"
                  : "border-border"
              }`}
            >
              <RadioGroupItem id={`qc-pub-${o.v}`} value={o.v} className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </Step>

      {/* ── 送出 ─────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
        <p className="text-sm text-muted-foreground">
          {values.publish ? "建立後立即發布" : "建立後存成草稿"}
        </p>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || categories.length === 0}
          className="min-w-32"
        >
          {submitting ? "建立中…（約 10 秒）" : `建立${copy.noun}`}
        </Button>
      </div>

      <AlertDialog open={blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>要離開這一頁嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              這張表單還沒送出。離開就會失去已經填的內容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>留在這一頁</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => blocker.proceed?.()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              離開，不儲存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
