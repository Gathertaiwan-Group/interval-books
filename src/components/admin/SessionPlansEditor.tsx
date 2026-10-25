/**
 * 一個場次底下的多個價格方案（票種，0036）——嵌在 /admin/registrations/$sessionId/edit 的
 * `SessionForm`（src/components/admin/SessionForm.tsx；2026-10-25 起是內頁不是對話框）裡
 * （capacity/status 那組欄位之後、sort_order 之前），
 * 只在編輯既有場次時顯示：方案掛在 `event_sessions.id` 上，新建場次那一刻還沒有
 * id 可以掛，所以新增場次時這一整塊先不出現——存一次場次之後再回來編輯，才看得到
 * 「新增方案」。
 *
 * ── 沒有方案的場次一切照舊 ─────────────────────────────────────────────────
 * 這裡的「方案」是選配：一個場次可以永遠 0 個方案，那時價格與座位數照 0020 之前
 * 的行為——取 products.price、quantity 就是座位數。這個編輯器只是讓「要開的時候
 * 開得了」，不是每個場次都要填。
 *
 * ── units_taken 唯讀 ───────────────────────────────────────────────────────
 * 跟 SessionForm 的 capacity 欄位同一個立場：已賣出的單位數只顯示、不能填，
 * 由 reserve_plan_units() / release_plan_units() / release_session_seat() /
 * expire_unpaid_orders()（0036）在持有列鎖時維護。
 *
 * ── 已賣出的方案刪不掉，而且不會讓裸的 FK 錯誤冒出來（0035 的教訓）──────────
 * `removeEventSessionPlan()`（src/server/repos/event-sessions.ts）先查一次
 * order_items 再決定要不要真的刪，回傳的 reason 在這裡被翻成一句人話。
 *
 * ── 🔴 zod schema 值必須動態載入 ───────────────────────────────────────────
 * `eventSessionPlanSchema` 住在 src/lib/admin/schemas.ts，那個檔案已經被 100 處
 * 靜態匯入命中（多半是後台表單），而 scripts/bundle-admin-leak-selftest.mjs
 * 守著後台專用字串不能流進訪客必載的 bundle——TanStack Router 的路由拆分只抽離
 * `component:` 欄位本身，同一份路由模組圖裡「只被 component 呼叫的 sibling
 * 函式」（這裡的表單元件）仍然會被拉進 critical bundle。既有的 `eventSessionSchema`
 * 是靜態匯入（還沒被證實安全，只是還沒被那支測試的字串樣本抓到），這裡刻意不重蹈：
 * `PlanFormFields` 只在對話框真的打開時才 `await import("@/lib/admin/schemas")`
 * 去拿 `eventSessionPlanSchema` 這個值；型別（`EventSessionPlanFormValues`）走
 * `import type`，編譯期就會被整段擦除，不產生執行期的 import 邊。
 */
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { EventSessionPlanFormValues } from "@/lib/admin/schemas";
import type { listEventSessionPlans } from "@/lib/admin/fns/event-sessions";

export type PlanRow = Awaited<ReturnType<typeof listEventSessionPlans>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

const STATUS_LABEL: Record<"open" | "closed", string> = {
  open: "開放販售",
  closed: "已下架",
};

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 空字串／未填＝不限（null）。與 toLocalInput 成對。 */
function toIsoOrNull(local: string | null | undefined): string | null {
  const trimmed = (local ?? "").trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toFormValues(row: PlanRow): EventSessionPlanFormValues {
  return {
    id: row.id,
    session_id: row.session_id,
    title: row.title,
    price: row.price,
    seats_per_unit: row.seats_per_unit,
    capacity: row.capacity,
    sale_starts_at: toLocalInput(row.sale_starts_at),
    sale_ends_at: toLocalInput(row.sale_ends_at),
    status: row.status,
    sort_order: row.sort_order,
  };
}

type EditorProps = {
  sessionId: string;
  /** 已經按 session_id 篩過的方案清單（getEventSessionPageData 在伺服器上篩好）。 */
  plans: PlanRow[];
  /** 任何一次成功的新增／編輯／刪除之後呼叫——通常是 router.invalidate()。 */
  onChanged: () => void | Promise<void>;
  /**
   * 方案對話框開著、而且表單改過（比值，改回原樣不算）→ true。場次編輯頁把它併進
   * 未存變更防呆（2026-10-25 後台第 2 批）：方案打到一半按瀏覽器上一頁，一樣要先問。
   * 方案存檔成功或對話框關掉 → 表單卸載 → false。
   */
  onDirtyChange?: (dirty: boolean) => void;
};

export function SessionPlansEditor({ sessionId, plans, onChanged, onDirtyChange }: EditorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PlanRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const nextSortOrder = sorted.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: PlanRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: EventSessionPlanFormValues) {
    setSubmitting(true);
    try {
      const { upsertEventSessionPlan } = await import("@/lib/admin/fns/event-sessions");
      await upsertEventSessionPlan({
        data: {
          ...values,
          id: editing ? editing.id : undefined,
          session_id: sessionId,
          sale_starts_at: toIsoOrNull(values.sale_starts_at),
          sale_ends_at: toIsoOrNull(values.sale_ends_at),
        },
      });
      toast.success(editing ? "已更新方案" : "已新增方案");
      setDialogOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeEventSessionPlan } = await import("@/lib/admin/fns/event-sessions");
      const result = await removeEventSessionPlan({ data: { id: deleteTarget.id } });
      if (result.deleted) {
        toast.success("已刪除方案");
        setDeleteTarget(null);
        await onChanged();
      } else if (result.reason === "plan_has_orders") {
        // 0035 的教訓：不要讓裸的 FK 錯誤冒出來，這裡先查過一次、給人話。
        toast.error("這個方案已經有人購買，無法刪除。可以把狀態改成「已下架」。");
      } else {
        toast.error("找不到這個方案，可能已經被刪除");
        setDeleteTarget(null);
        await onChanged();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">價格方案（票種）</p>
          <p className="text-xs text-muted-foreground">
            選填。沒有任何「開放販售」的方案時，這個場次照舊用商品本身的價格，數量就是座位數。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" />
          新增方案
        </Button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚無方案。</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名稱</TableHead>
                <TableHead className="w-24">單價</TableHead>
                <TableHead className="w-24">每單位</TableHead>
                <TableHead className="w-28">名額</TableHead>
                <TableHead>販售期間</TableHead>
                <TableHead className="w-24">狀態</TableHead>
                <TableHead className="w-36 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="max-w-[10rem] truncate font-medium">{p.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">
                    NT${p.price.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.seats_per_unit} 位</TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.units_taken} / {p.capacity}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {/* 2026-10-25 起這張表在場次編輯「內頁」上、會被 SSR（原本在對話框裡只在瀏覽器畫）。
                        ⚠️ 不可以用 toLocaleString：伺服器是 UTC、瀏覽器是台北 → React #418。 */}
                    {p.sale_starts_at || p.sale_ends_at
                      ? `${formatTaipeiDateTime(p.sale_starts_at)} ～ ${formatTaipeiDateTime(p.sale_ends_at)}`
                      : "不限"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.status === "open" ? "default" : "secondary"}>
                      {STATUS_LABEL[p.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(p)}
                      >
                        刪除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯方案" : "新增方案"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填。名額只能調整上限，已賣出的單位數由系統維護。
            </DialogDescription>
          </DialogHeader>
          <PlanFormDialogBody
            key={formKey}
            open={dialogOpen}
            defaultValues={
              editing
                ? toFormValues(editing)
                : {
                    session_id: sessionId,
                    title: { ...EMPTY_LOCALIZED },
                    price: 0,
                    seats_per_unit: 1,
                    capacity: 10,
                    sale_starts_at: "",
                    sale_ends_at: "",
                    status: "open",
                    sort_order: nextSortOrder,
                  }
            }
            unitsTaken={editing ? editing.units_taken : null}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
            onDirtyChange={onDirtyChange}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除「{deleteTarget?.title.zh}」這個方案嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              刪除後無法復原。已經賣出過的方案會被資料庫擋下來，那時請改成「已下架」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type PlanFormDialogBodyProps = {
  /** 對話框現在開不開——關著的時候不用去載 schema。 */
  open: boolean;
  defaultValues: EventSessionPlanFormValues;
  unitsTaken: number | null;
  onSubmit: (values: EventSessionPlanFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * 只負責一件事：對話框開啟時才動態載入 `eventSessionPlanSchema`，載到之前畫一句
 * 讀取中，載到之後才把控制權交給真正的 `PlanForm`（那裡才會呼叫 `useForm()`）。
 * `zodResolver()` 需要在 `useForm()` 呼叫的當下就拿到 schema——react-hook-form
 * 的 resolver 不是之後能換的東西，所以「先載模組、再掛表單」必須是兩個元件，
 * 不能在同一個 `useForm()` 呼叫裡用一個還沒 resolve 的 Promise。
 */
function PlanFormDialogBody({ open, ...formProps }: PlanFormDialogBodyProps) {
  const [schema, setSchema] = useState<
    typeof import("@/lib/admin/schemas").eventSessionPlanSchema | null
  >(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void import("@/lib/admin/schemas").then((mod) => {
      if (alive) setSchema(() => mod.eventSessionPlanSchema);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!schema) {
    return <p className="py-8 text-center text-sm text-muted-foreground">表單載入中…</p>;
  }
  return <PlanForm schema={schema} {...formProps} />;
}

function PlanForm({
  schema,
  defaultValues,
  unitsTaken,
  onSubmit,
  submitting,
  submitLabel,
  onDirtyChange,
}: Omit<PlanFormDialogBodyProps, "open"> & {
  schema: typeof import("@/lib/admin/schemas").eventSessionPlanSchema;
}) {
  const form = useForm<EventSessionPlanFormValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  // 往上回報「方案表單改過沒」（見 EditorProps.onDirtyChange）。卸載（存檔成功、關掉）時歸零。
  const { dirty } = useFormDirty(form.watch());
  const reportRef = useRef(onDirtyChange);
  reportRef.current = onDirtyChange;
  useEffect(() => {
    reportRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => reportRef.current?.(false), []);

  return (
    <Form {...form}>
      {/* ⚠️ 這個對話框（portal）在 React 樹上仍在場次表單 <form> 裡面：submit 事件會沿著
          React 樹冒泡到場次表單的 onSubmit，等於按「儲存票種」順便存了場次並離開頁面。
          一定要 stopPropagation。 */}
      <form
        onSubmit={(e) => {
          e.stopPropagation();
          void form.handleSubmit(onSubmit)(e);
        }}
        className="space-y-5"
      >
        <LocalizedField name="title" label="方案名稱" />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>單價（每單位，TWD）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="seats_per_unit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>每單位佔用名額</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>雙人房這類是 2；一般票種是 1。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>方案名額上限（單位數）</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={field.value}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
              </FormControl>
              <FormDescription>
                {unitsTaken != null
                  ? `目前已賣出 ${unitsTaken} 個單位。調降到低於這個數字會被資料庫擋下來。`
                  : "已賣出的單位數由系統維護，不能在這裡填。"}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="sale_starts_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>販售開始時間（選填）</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>不填＝現在就能買（早鳥的起點）。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="sale_ends_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>販售結束時間（選填）</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>不填＝不設販售期限（早鳥的迄點）。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>狀態</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="open">開放販售</SelectItem>
                    <SelectItem value="closed">已下架</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>只有「開放販售」的方案會出現在前台。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="sort_order"
            render={({ field }) => (
              <FormItem>
                <FormLabel>排序</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
