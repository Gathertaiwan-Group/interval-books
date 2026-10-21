/**
 * 後台「標記已出貨／已取貨／已完成」的寫入（src/routes/admin/_shell.orders.tsx）。
 *
 * ── 為什麼不是 RPC、也不是新 migration ───────────────────────────────────────
 * 0034／0035 的其他後台動作都包在 security definer 函式裡，因為它們要**同一個交易
 * 裡改好幾張表**（付款列、名額、報名）。這裡只改 orders 一列的 status 與一個時間
 * 戳，一句 PostgREST 的 conditional update 就是原子的：
 *
 *   update orders set status = <to>, <stamp> = now
 *    where id = $1 and status = <from> and payment_status = 'paid'
 *      and paid_at is not null and shipping_method in (…)
 *   returning …
 *
 * 所有條件都在同一句 where 裡，Postgres 對那一列取 row lock 再判斷——沒有
 * read-then-write 的競態視窗。兩個分頁同時按，只有一個拿得到那一列，另一個回 0 列，
 * 走下面的重讀分類，回 already_done（成功的 no-op）。
 *
 * ── 稽核 ──────────────────────────────────────────────────────────────────
 * 既有的後台訂單動作沒有可以共用的稽核表：admin_delete_order／admin_archive_order
 * （0035）只用 `raise log`，admin_mark_order_paid（0034）把 actor 寫進
 * payments.raw_response（那是付款列，出貨沒有對應的列）；public.mcp_audit_log（0039）
 * 有 CHECK actor_role = 'mcp'，不能拿來記後台人員。新增稽核表需要 DDL，這一期不做，
 * 所以稽核走一行結構化的伺服器 log（Vercel log 可以 grep `[order-status]`）：
 *
 *   [order-status] {"event":"order_status_changed","action":"ship",…}
 *
 * 只印 id／訂單編號／動作／狀態／actor／時間，**不印客人的任何個資**。
 *
 * 🔴 這個檔案不寄信、不開發票、不動庫存與名額，也不 import 任何會做這些事的模組
 *    （scripts/order-fulfillment-selftest.mjs 有靜態測試守著）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import {
  FULFILLMENT_TRANSITIONS,
  classifyAfterNoop,
  type FulfillmentAction,
  type FulfillmentOrderFacts,
} from "@/lib/admin/order-fulfillment";

export type FulfillmentReason = "updated" | "already_done" | "ineligible" | "order_not_found";

export type FulfillmentOutcome = {
  updated: boolean;
  reason: FulfillmentReason;
  order_no: string | null;
  /** 這一次（或先前）之後的狀態；order_not_found 時為 null。 */
  status: string | null;
  shipped_at: string | null;
  completed_at: string | null;
};

const RETURN_COLUMNS = "id, order_no, status, shipped_at, completed_at";
const REREAD_COLUMNS =
  "id, order_no, status, payment_status, paid_at, shipping_method, shipped_at, completed_at";

function auditLog(entry: Record<string, unknown>) {
  console.log(`[order-status] ${JSON.stringify({ event: "order_status_changed", ...entry })}`);
}

export async function advanceOrderFulfillment(input: {
  orderId: string;
  actorId: string;
  action: FulfillmentAction;
}): Promise<FulfillmentOutcome> {
  const t = FULFILLMENT_TRANSITIONS[input.action];
  const now = new Date().toISOString();
  const db = supabaseAdmin();

  const patch: Record<string, string> = { status: t.to };
  patch[t.stampColumn] = now;

  const { data, error } = await db
    .from("orders")
    .update(patch)
    .eq("id", input.orderId)
    .eq("status", t.from)
    .eq("payment_status", "paid")
    .not("paid_at", "is", null)
    .in("shipping_method", [...t.methods])
    .select(RETURN_COLUMNS);

  if (error) {
    // code + message，不印整包 error（同 orders-admin.ts：DETAIL 可能帶整列個資）。
    console.error(`[repo/order-fulfillment] update 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/order-fulfillment] 更新訂單狀態失敗：${error.code}`);
  }

  type Row = {
    id: string;
    order_no: string;
    status: string;
    shipped_at: string | null;
    completed_at: string | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  if (rows.length === 1) {
    const r = rows[0];
    auditLog({
      action: input.action,
      order_id: r.id,
      order_no: r.order_no,
      from: t.from,
      to: t.to,
      actor_id: input.actorId,
      at: now,
    });
    return {
      updated: true,
      reason: "updated",
      order_no: r.order_no,
      status: r.status,
      shipped_at: r.shipped_at,
      completed_at: r.completed_at,
    };
  }

  // 0 列：重讀分類。這一步只讀，不會再寫。
  const { data: cur, error: readError } = await db
    .from("orders")
    .select(REREAD_COLUMNS)
    .eq("id", input.orderId)
    .maybeSingle();

  if (readError) {
    console.error(`[repo/order-fulfillment] reread 失敗：${readError.code} ${readError.message}`);
    throw new Error(`[repo/order-fulfillment] 訂單讀取失敗：${readError.code}`);
  }
  if (!cur) {
    return {
      updated: false,
      reason: "order_not_found",
      order_no: null,
      status: null,
      shipped_at: null,
      completed_at: null,
    };
  }

  const o = cur as unknown as FulfillmentOrderFacts & {
    order_no: string;
    completed_at: string | null;
  };
  const reason = classifyAfterNoop(input.action, o);
  if (reason === "already_done") {
    console.log(
      `[order-status] ${JSON.stringify({
        event: "order_status_noop",
        action: input.action,
        order_id: input.orderId,
        order_no: o.order_no,
        status: o.status,
        actor_id: input.actorId,
        at: now,
      })}`,
    );
  }
  return {
    updated: false,
    reason,
    order_no: o.order_no,
    status: o.status,
    shipped_at: o.shipped_at ?? null,
    completed_at: o.completed_at ?? null,
  };
}
