import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Download, Eye, Plus, Trash2 } from "lucide-react";
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
import { eventSessionSchema, type EventSessionFormValues } from "@/lib/admin/schemas";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type {
  listBookableProducts,
  listEventSessionPlans,
  listEventSessions,
} from "@/lib/admin/fns/event-sessions";
import type { listSessionRoster } from "@/lib/admin/fns/event-registrations";
import { RegistrationRevealDialog } from "@/components/admin/RegistrationRevealDialog";
import { SessionPlansEditor } from "@/components/admin/SessionPlansEditor";

type SessionRow = Awaited<ReturnType<typeof listEventSessions>>[number];
type ProductRow = Awaited<ReturnType<typeof listBookableProducts>>[number];
type RosterRow = Awaited<ReturnType<typeof listSessionRoster>>[number];
type PlanRow = Awaited<ReturnType<typeof listEventSessionPlans>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

const STATUS_LABEL: Record<EventSessionFormValues["status"], string> = {
  open: "開放報名",
  closed: "未開放",
};

/**
 * /admin/registrations —— 活動場次與報名名單。
 *
 * 這一頁做兩件事，而它們是同一件事的兩面：**維護場次**（名額的唯一真相，
 * migration 0020 §1）與**看名單**（誰報名了）。分成兩頁的話，「這個梯次為什麼還有
 * 位子卻報不了名」就得在兩頁之間來回比對。
 *
 * ⚠️ 名單頁的列表是**遮罩過的**，而明文有兩條路，兩條都會留下紀錄（0021 §0.1）：
 *    - 姓名是全名 —— 遮了現場點不了名，與 0019 讓廠商名稱明文、只遮識別碼是
 *      同一條線。
 *    - 電話與信箱只有遮罩值，而且遮罩是在 **SQL** 做的（0021 §3 的
 *      public.admin_event_roster）。這一頁與它底下的 Node 行程都拿不到明文，
 *      所以它**不可能**不小心把明文印出來。
 *    - 單列「顯示完整聯絡方式」→ reveal_registration_contact()，寫一筆
 *      reason='attendee_contact' 的 pii_access_log。
 *    - 「匯出簽到表」→ export_event_roster()，寫**一筆** reason='roster_export'，
 *      subject 是場次而不是每一位參加者。
 *
 * ⚠️ 列表本身**不寫 log**。名單頁一次顯示 30 個人，每次開頁寫 30 列會讓
 *    pii_access_log 失去唯一的用途（0019 §1.1：它要回答的是「有沒有人在亂查」）。
 *
 * 名額不在 /admin/products 上了：0020 把 products.capacity 綁成 null，所以那個
 * 欄位已經從商品表單移除，改由這裡按場次維護。
 *
 * ── 移除單筆報名（0035）───────────────────────────────────────────────────
 * 名單彈窗每一列多一顆「移除」，呼叫 deleteAdminRegistration()
 * （admin_delete_registration()，掛 adminFnMiddleware——見
 * src/lib/admin/fns/event-registrations.ts 的說明）。名額由資料庫那一支自動還
 * 回去，這裡不用另外算。已付款的列也允許移除（user 決定），確認對話框用這一列
 * 既有的 payment_status／on_roster（listSessionRoster() 早就回傳了）明確示警
 * 「這位已經付過錢」，不需要等 RPC 回來才知道。
 */
export const Route = createFileRoute("/admin/_shell/registrations")({
  /**
   * ⚠️ 這一頁是唯一**需要 migration 已經套用**才看得到東西的地方，而且它現在有
   *    **兩個**階段要接：0020（場次與報名兩張表）與 0021（名單的 view 與兩支
   *    明文函式）。程式碼先上線、migration 後套用，所以「0020 套了但 0021 還沒」
   *    是真的會發生的中間狀態。
   *
   * 兩個旗標分開，是為了讓那個中間狀態仍然有用：
   *
   *   schemaMissing —— 0020 還沒套。場次表不存在，整頁沒有東西可以顯示。
   *   rosterReady   —— 0021 已經套。false 的時候場次列表照常顯示（名額、狀態、
   *                    新增與編輯全部可用），只有「報名人數」與名單那幾顆按鈕
   *                    收起來。
   *
   * 如果把兩件事併成一個旗標，0020 套完當天整頁會變成一張「請先套 migration」的
   * 說明 —— 而那時候場次明明已經維護得動了。
   *
   * **只接「表／view 不存在」這一種**：其餘的錯誤照樣往上丟（連線壞了、權限不對，
   * 那些不該被說成「還沒套 migration」）。
   *
   * 前台不需要這種處理：purchase 路徑的每一支查詢都有「購物車裡真的有活動才查」
   * 的前置判斷，全是書的購物車一次都不會碰到 event_sessions。
   */
  loader: async () => {
    const { listEventSessions, listBookableProducts, listEventSessionPlans } =
      await import("@/lib/admin/fns/event-sessions");
    const { countRegistrationsBySession } = await import("@/lib/admin/fns/event-registrations");
    const empty = {
      sessions: [] as Awaited<ReturnType<typeof listEventSessions>>,
      products: [] as Awaited<ReturnType<typeof listBookableProducts>>,
      plans: [] as Awaited<ReturnType<typeof listEventSessionPlans>>,
      counts: {} as Awaited<ReturnType<typeof countRegistrationsBySession>>,
    };

    let sessions = empty.sessions;
    let products = empty.products;
    try {
      [sessions, products] = await Promise.all([listEventSessions(), listBookableProducts()]);
    } catch (err) {
      if (!isSchemaMissing(err)) throw err;
      return { ...empty, schemaMissing: true, rosterReady: false };
    }

    // 0036：方案表是這一期才加的，用同一套「還沒套 migration 就退化」處理——
    // 場次照常顯示，只有「方案」那一塊會是空的。與 rosterReady 平行但各自獨立：
    // 「0020 套了、0036 還沒套」是真的會發生的中間狀態（程式碼先上線）。
    let plans = empty.plans;
    try {
      plans = await listEventSessionPlans();
    } catch (err) {
      if (!isSchemaMissing(err)) throw err;
    }

    try {
      const counts = await countRegistrationsBySession();
      return { sessions, products, plans, counts, schemaMissing: false, rosterReady: true };
    } catch (err) {
      if (!isSchemaMissing(err)) throw err;
      return { ...empty, sessions, products, plans, schemaMissing: false, rosterReady: false };
    }
  },
  head: () => ({
    meta: [{ title: "活動報名｜小時光書店後台" }],
  }),
  component: AdminRegistrationsPage,
});

/**
 * 「這個錯誤是不是『表／view 還不存在』」。
 *
 * PostgREST 對「表不存在」回的是 PGRST205（schema cache 找不到），直連 Postgres
 * 則是 42P01。兩個字串都認，因為這一段的重點是訊息本身。
 *
 * ⚠️ 刻意**沒有**收 `/does not exist/i`。那個字串太寬：`function … does not exist`
 *    （RPC 簽名打錯）與 `column … does not exist`（COLUMNS 漏改）也會命中，而那
 *    兩件事都是真的 bug，被說成「還沒套 migration」就會被藏起來，直到有人納悶
 *    為什麼套完了畫面還是那句話。
 */
function isSchemaMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /PGRST205|42P01|schema cache/i.test(message);
}

/**
 * timestamptz → `<input type="datetime-local">` 吃得下的字串。
 *
 * 用本地時間的欄位而不是 UTC：店員填的是「這場活動幾點開始」，那是牆上時鐘的
 * 時間。轉回 ISO 由 toIso() 負責，兩支必須成對修改。
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toFormValues(row: SessionRow): EventSessionFormValues {
  return {
    id: row.id,
    product_id: row.product_id,
    title: row.title,
    location: row.location,
    starts_at: toLocalInput(row.starts_at),
    ends_at: toLocalInput(row.ends_at),
    capacity: row.capacity,
    status: row.status,
    sort_order: row.sort_order,
  };
}

function AdminRegistrationsPage() {
  const { sessions, products, plans, counts, schemaMissing, rosterReady } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();

  // ⚠️ 只控制畫面。真正擋住直接 POST /_serverFn/… 的是 fns 那一層的
  //    requireRosterRead()，而它是從 staff_permissions 重讀出來的。
  const canReadRoster = user.permissions.includes("event.roster.read");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [rosterOf, setRosterOf] = useState<SessionRow | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [revealOf, setRevealOf] = useState<RosterRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RosterRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const productById = useMemo(
    () => new Map(products.map((p: ProductRow) => [p.id, p])),
    [products],
  );

  function productLabel(id: string): string {
    return productById.get(id)?.title.zh ?? id;
  }

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: SessionRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function openRoster(row: SessionRow) {
    setRosterOf(row);
    setRoster(null);
    setRosterLoading(true);
    try {
      const { listSessionRoster } = await import("@/lib/admin/fns/event-registrations");
      setRoster(await listSessionRoster({ data: { sessionId: row.id } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "名單讀取失敗");
      setRosterOf(null);
    } finally {
      setRosterLoading(false);
    }
  }

  /**
   * 匯出簽到表。
   *
   * ⚠️ **CSV 是 server fn 回來的字串，不是一條 HTTP 路由。** 快樂手的 CSV 是
   *    route handler，踩過「權限不足時 redirect 到登入頁，瀏覽器照樣把登入頁的
   *    HTML 存成 roster.csv」。這裡的回傳型別是 { filename, csv }，沒有任何路徑
   *    可以讓它變成一份 HTML；授權失敗就是下面這個 catch，使用者看到 toast。
   *
   * ⚠️ 呼叫成功就一定留下一筆 pii_access_log（subject 是場次）。toast 把紀錄編號
   *    印出來，理由與 RegistrationRevealDialog 相同：講明白會被記錄，比偷偷記錄
   *    有用。
   */
  async function handleExport(row: SessionRow) {
    setExporting(true);
    try {
      const { exportSessionRoster } = await import("@/lib/admin/fns/event-registrations");
      const { filename, csv, count, log_id } = await exportSessionRoster({
        data: { sessionId: row.id },
      });
      // BOM 已經在 csv 字串開頭（src/lib/csv.ts），這裡不要再加一次。
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      // ⚠️ 掛進 DOM 再點，而且 revoke 排到下一個 tick：直接 revoke 會在部分瀏覽器
      //    上讓下載在真正開始之前就失去來源，結果是一個 0 byte 的檔案。
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`已匯出 ${count} 位・紀錄編號 ${log_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "名單匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  /**
   * 移除單筆報名（0035）。成功後從目前開著的名單本地過濾掉這一列——不用整個重打
   * listSessionRoster()，開著的 Dialog 感覺不到閃爍；同時 invalidate 路由，讓
   * 外層那張場次表的「報名」欄與「名額」欄（seats_taken／counts）在下次看到時
   * 是新的數字。兩件事都要做，理由不同：前者是這個 Dialog 自己的畫面，後者是
   * route loader 才有的資料，roster 這個 state 完全碰不到它。
   */
  async function handleRemoveRegistration() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const { deleteAdminRegistration } = await import("@/lib/admin/fns/event-registrations");
      const result = await deleteAdminRegistration({
        data: { registrationId: removeTarget.registration_id },
      });
      if (result.reason === "deleted") {
        toast.success("已移除這筆報名，名額已還原");
        setRoster((prev) =>
          prev ? prev.filter((r) => r.registration_id !== removeTarget.registration_id) : prev,
        );
        setRemoveTarget(null);
        await router.invalidate();
      } else {
        toast.error("找不到這筆報名，可能已經被移除");
        setRemoveTarget(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失敗，請稍後再試");
    } finally {
      setRemoving(false);
    }
  }

  async function handleSubmit(values: EventSessionFormValues) {
    setSubmitting(true);
    try {
      const { upsertEventSession } = await import("@/lib/admin/fns/event-sessions");
      await upsertEventSession({
        data: {
          ...values,
          id: editing ? editing.id : undefined,
          starts_at: toIso(values.starts_at),
          ends_at: (values.ends_at ?? "").trim() ? toIso(values.ends_at!) : null,
        },
      });
      toast.success(editing ? "已更新場次" : "已新增場次");
      setDialogOpen(false);
      await router.invalidate();
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
      const { removeEventSession } = await import("@/lib/admin/fns/event-sessions");
      await removeEventSession({ data: { id: deleteTarget.id } });
      toast.success("已刪除場次");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      // 有人報名過的場次刪不掉（兩條 on delete restrict 外鍵）。原文往上丟，
      // 因為那句話正是店員需要知道的事。
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = sessions.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1;

  const defaultValues: EventSessionFormValues = editing
    ? toFormValues(editing)
    : {
        product_id: products[0]?.id ?? "",
        title: { ...EMPTY_LOCALIZED },
        location: { ...EMPTY_LOCALIZED },
        starts_at: "",
        ends_at: "",
        capacity: 20,
        // 新場次預設「未開放」，與 0020 回填的場次同一個立場：先建好、確認日期
        // 與名額之後再手動打開。fail-closed。
        status: "closed",
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">活動報名</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {sessions.length} 個場次。名額在這裡維護——商品頁不再有名額欄位。
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5" disabled={products.length === 0}>
          <Plus className="h-4 w-4" />
          新增場次
        </Button>
      </div>

      {schemaMissing && (
        <p className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
          活動場次的資料表還沒建立。這一頁要等 migration 0020_event_sessions_registrations.sql
          套用到資料庫之後才會有內容——程式碼會 先上線，資料庫是另一個步驟。
        </p>
      )}

      {!schemaMissing && !rosterReady && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          名單功能還沒開通：migration 0021_roster_pii.sql 尚未套用到資料庫。場次可以
          照常維護（名額、時間、開關），但「報名人數」、名單與匯出要等那一支套用之後
          才會出現——遮罩與稽核紀錄都做在資料庫裡，沒有它就沒有安全的明文出口。
        </p>
      )}

      {!schemaMissing && products.length === 0 && (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          目前沒有活動或策旅類型的商品。請先到「商品」新增一件 event／journey
          商品，才能為它建立場次。
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>活動商品</TableHead>
              <TableHead>場次</TableHead>
              <TableHead>時間</TableHead>
              <TableHead className="w-28">名額</TableHead>
              <TableHead className="w-32">報名</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  尚無場次。
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const count = counts[s.id] ?? { total: 0, paid: 0 };
                // ⚠️ 三個數字，不是兩個。seats_taken 是「押住了幾個位子」，
                //    count.total 是「有幾位登錄了姓名」。0020 §4.4 回填的舊場次
                //    只補一位參加者（捏造另外兩位是說謊），所以那些場次上這兩個
                //    數字本來就不一樣，而現場點名的人必須看得出來。
                const unnamed = Math.max(0, s.seats_taken - count.total);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-xs truncate">
                      {productLabel(s.product_id)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">{s.title.zh}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {/* 不可以 toLocaleString：伺服器（UTC、Node 的 ICU）與瀏覽器印出來的
                          字不一樣 → React #418。見 src/lib/taipei-time.ts。 */}
                      {formatTaipeiDateTime(s.starts_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.seats_taken} / {s.capacity}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {!rosterReady ? (
                        "—"
                      ) : (
                        <>
                          {count.paid} 已付款
                          {count.total !== count.paid ? `／${count.total} 筆` : ""}
                          {unnamed > 0 ? (
                            <span className="block text-xs text-amber-600">
                              另有 {unnamed} 位未登錄姓名
                            </span>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.status === "open" ? "default" : "secondary"}>
                        {STATUS_LABEL[s.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!rosterReady}
                          onClick={() => void openRoster(s)}
                        >
                          名單
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                          編輯
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(s)}
                        >
                          刪除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯場次" : "新增場次"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。名額只能調整
              上限，已報名人數由系統維護。
            </DialogDescription>
          </DialogHeader>
          <SessionForm
            key={formKey}
            defaultValues={defaultValues}
            products={products}
            seatsTaken={editing ? editing.seats_taken : null}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
            editingSessionId={editing ? editing.id : null}
            plans={editing ? plans.filter((p) => p.session_id === editing.id) : []}
            onPlansChanged={() => router.invalidate()}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={rosterOf !== null} onOpenChange={(open) => !open && setRosterOf(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{rosterOf ? rosterOf.title.zh : ""} 報名名單</DialogTitle>
            <DialogDescription>
              電話與信箱只顯示遮罩值，而且遮罩是在資料庫做的——這一頁拿不到明文。
              要看某一位的完整聯絡方式或匯出簽到表，兩條路都會留下刪不掉的存取紀錄。
            </DialogDescription>
          </DialogHeader>

          {/* ⚠️ 匯出只含已付款（on_roster）。未付款的人不會來，印進簽到表會讓現場
              多準備座位與講義。那個條件寫在 0021 §3 的 view 裡，畫面、CSV 與
              Phase 3 的提醒信共用同一份。 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
            <span className="text-muted-foreground">
              {rosterLoading ? (
                "讀取中…"
              ) : (
                <>
                  共 {roster?.length ?? 0} 筆，其中{" "}
                  <strong>{(roster ?? []).filter((r) => r.on_roster).length}</strong>{" "}
                  位已付款（＝會出現在簽到表上）；其餘是被未付款的訂單押著的位子。
                </>
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              // ⚠️ disabled 只是畫面。擋住直接呼叫的是 server fn 的 requireRosterRead()。
              disabled={
                exporting ||
                rosterLoading ||
                !canReadRoster ||
                rosterOf === null ||
                (roster ?? []).filter((r) => r.on_roster).length === 0
              }
              title={canReadRoster ? undefined : "需要「查看活動報名名單」權限"}
              onClick={() => rosterOf && void handleExport(rosterOf)}
            >
              <Download className="h-4 w-4" />
              {exporting ? "匯出中…" : "匯出簽到表（CSV）"}
            </Button>
          </div>

          {rosterLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">讀取中…</p>
          ) : (roster?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">尚無報名。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>信箱</TableHead>
                    <TableHead>電話</TableHead>
                    <TableHead>訂單</TableHead>
                    <TableHead className="w-24">付款</TableHead>
                    <TableHead className="w-24">注意事項</TableHead>
                    <TableHead className="w-40 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(roster ?? []).map((r, i) => (
                    <TableRow key={r.registration_id}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      {/* 「沒填」與「填了但你看不到」要長得不一樣 —— 遮罩值本身分
                          不出這兩件事，所以 view 另外送了 has_email / has_phone。 */}
                      <TableCell className="text-muted-foreground">
                        {r.has_email ? (r.email_masked ?? "—") : "（未填）"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.has_phone ? (r.phone_masked ?? "—") : "（未填）"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.order_no}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.on_roster ? "default" : "secondary"}>
                          {r.on_roster ? "已付款" : r.payment_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.notice_ack_at ? "已同意" : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5"
                            disabled={!r.has_email && !r.has_phone}
                            onClick={() => setRevealOf(r)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            顯示
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-destructive hover:text-destructive"
                            onClick={() => setRemoveTarget(r)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            移除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <RegistrationRevealDialog
        open={revealOf !== null}
        onOpenChange={(open) => !open && setRevealOf(null)}
        registration={revealOf}
        canReadRoster={canReadRoster}
      />

      {/* 移除單筆報名（0035）。已付款的列（on_roster）在這裡明確示警——這一列的
          payment_status／on_roster 從 listSessionRoster() 就有了，不用等 RPC
          回來才知道要不要警告。 */}
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要移除「{removeTarget?.name}」的報名嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.on_roster ? (
                <span className="block font-medium text-destructive">
                  警告：這位已經付過錢（訂單 {removeTarget?.order_no}）。移除只會刪掉報名
                  紀錄並還原名額，不會辦理退款——退款要另外處理。
                </span>
              ) : null}
              <span className="block">
                移除後這個位子的名額會立即還給場次，其他人就報得到名。這個動作無法復原。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemoveRegistration();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "移除中…" : "確定移除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個場次嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。已經有人報名或下過單的場次
              會被資料庫擋下來，那時請先處理那些訂單。
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

type SessionFormProps = {
  defaultValues: EventSessionFormValues;
  products: ProductRow[];
  /** 編輯時的已報名人數；新增時是 null（還沒有東西可以顯示）。唯讀。 */
  seatsTaken: number | null;
  onSubmit: (values: EventSessionFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
  /**
   * 0036：編輯中的場次 id，null＝正在新增一個還沒存過的場次。方案掛在
   * event_sessions.id 上，新建場次那一刻還沒有 id 可以掛，所以方案編輯器只在
   * 這裡非 null 時才畫——見 SessionPlansEditor 的檔頭。
   */
  editingSessionId: string | null;
  /** 已經按 editingSessionId 篩過的方案清單，新增場次時永遠是空陣列。 */
  plans: PlanRow[];
  /** 方案的任何一次新增／編輯／刪除之後呼叫（router.invalidate()）。 */
  onPlansChanged: () => void;
};

function SessionForm({
  defaultValues,
  products,
  seatsTaken,
  onSubmit,
  submitting,
  submitLabel,
  editingSessionId,
  plans,
  onPlansChanged,
}: SessionFormProps) {
  const form = useForm<EventSessionFormValues>({
    resolver: zodResolver(eventSessionSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="product_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>活動商品</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="請選擇活動商品" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title.zh}
                      {p.status === "active" ? "" : "（未上架）"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="場次名稱" />
        <LocalizedField name="location" label="地點" />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="starts_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>開始時間</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ends_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>結束時間（選填）</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="capacity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>名額上限</FormLabel>
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
                  {seatsTaken != null
                    ? `目前已佔用 ${seatsTaken} 個位子。調降到低於這個數字會被資料庫擋下來。`
                    : "已報名人數由系統維護，不能在這裡填。"}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
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
                    <SelectItem value="closed">未開放</SelectItem>
                    <SelectItem value="open">開放報名</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  只有「開放報名」的場次會出現在前台，也只有它收得了報名。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* 0036：價格方案（票種）。只在編輯既有場次時出現——見 SessionPlansEditor
            檔頭與上面 editingSessionId 的說明。新增場次時這裡完全不畫，不是畫一個
            停用的空狀態：存一次場次、重新打開編輯，才會看到「新增方案」。 */}
        {editingSessionId ? (
          <SessionPlansEditor
            sessionId={editingSessionId}
            plans={plans}
            onChanged={onPlansChanged}
          />
        ) : null}

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

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
