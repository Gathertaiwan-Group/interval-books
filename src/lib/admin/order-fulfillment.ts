/**
 * 訂單出貨／取貨／完成的純邏輯 —— 哪一張訂單可以按哪一顆按鈕、按下去狀態從哪裡
 * 變到哪裡、0 列更新時怎麼判斷是「已經做過了」還是「不符合條件」。
 *
 * 不 import 任何 server 程式，scripts/order-fulfillment-selftest.mjs 直接用 Node
 * 原生型別剝離載入這一份驗證（同 src/lib/admin/todo.ts 的做法）。畫面
 * （_shell.orders.tsx）、寫入（src/server/repos/order-fulfillment.ts）、列表與首頁
 * 「待出貨」的計數（orders-admin.ts／admin-todo.ts）都從這裡拿條件，不各自再寫一份。
 *
 * ── 狀態機（orders.status，0005 的 CHECK）────────────────────────────────
 *
 *   processing ──ship──────▶ shipped ──complete──▶ completed   （宅配 home／超商 cvs）
 *   processing ──pickup────────────────────────────▶ completed   （門市自取 pickup）
 *
 *   shipping_method = 'none'（純活動票券，結帳時 !needsShipping）→ 沒有任何按鈕。
 *
 * 三個動作都要求「已付款」：payment_status = 'paid' **且** paid_at 有值。只看其中
 * 一欄的話，手改過資料庫、兩欄不一致的訂單會被放行——兩個條件都放進同一句
 * conditional update 裡，資料庫那一層一起擋。
 *
 * 寫入本身（src/server/repos/order-fulfillment.ts）只改 orders.status 與
 * shipped_at／completed_at 兩個時間戳（updated_at 由 0005 的 trigger 自己更新），
 * 不寄信、不開發票、不動庫存與名額。
 *
 * 出貨通知信（2026-10-22 業主核准）由 server fn 在寫入**之後**另外排，條件只有
 * 一個：shouldSendShippedEmail()——ship 這個動作、這一次真的寫入了。pickup／complete
 * 與冪等的 already_done 都不寄。
 */

export type FulfillmentAction = "ship" | "pickup" | "complete";

/** 需要出貨（有實體配送）的收件方式。與 0005 orders.shipping_method 的 CHECK 對齊。 */
export const SHIPPABLE_METHODS = ["home", "cvs"] as const;
/** 門市自取。 */
export const PICKUP_METHODS = ["pickup"] as const;

export type FulfillmentTransition = {
  /** 只有目前是這個 status 的訂單才會被更新（conditional update 的 .eq("status", from)）。 */
  from: "processing" | "shipped";
  to: "shipped" | "completed";
  /** 只有 shipping_method 在這個清單裡的訂單才會被更新（.in("shipping_method", …)）。 */
  methods: readonly string[];
  /** 這一次要蓋上「現在」的時間戳欄位。 */
  stampColumn: "shipped_at" | "completed_at";
};

export const FULFILLMENT_TRANSITIONS: Record<FulfillmentAction, FulfillmentTransition> = {
  ship: {
    from: "processing",
    to: "shipped",
    methods: SHIPPABLE_METHODS,
    stampColumn: "shipped_at",
  },
  pickup: {
    from: "processing",
    to: "completed",
    methods: PICKUP_METHODS,
    stampColumn: "completed_at",
  },
  complete: {
    from: "shipped",
    to: "completed",
    methods: SHIPPABLE_METHODS,
    stampColumn: "completed_at",
  },
};

export type FulfillmentOrderFacts = {
  status: string;
  payment_status: string;
  paid_at: string | null;
  shipping_method: string;
  shipped_at?: string | null;
};

/** 已付款：兩欄都要成立（見檔頭）。 */
export function isPaid(o: Pick<FulfillmentOrderFacts, "payment_status" | "paid_at">): boolean {
  return o.payment_status === "paid" && o.paid_at !== null && o.paid_at !== "";
}

/** 這個動作對這張訂單是否成立——與 repo 那句 conditional update 的篩選條件逐項相同。 */
export function canApply(action: FulfillmentAction, o: FulfillmentOrderFacts): boolean {
  const t = FULFILLMENT_TRANSITIONS[action];
  return isPaid(o) && o.status === t.from && t.methods.includes(o.shipping_method);
}

/**
 * 詳情畫面要顯示哪一顆按鈕（同一時間最多一顆）。null＝沒有按鈕：未付款、純票券、
 * 已完成、已取消……都是。
 */
export function availableFulfillmentAction(o: FulfillmentOrderFacts): FulfillmentAction | null {
  for (const action of ["ship", "pickup", "complete"] as const) {
    if (canApply(action, o)) return action;
  }
  return null;
}

/**
 * conditional update 回 0 列之後，重讀那一列來分類：
 *   already_done —— 這個動作想達成的狀態已經成立（重複點擊、兩個分頁同時按），
 *                   當成功的 no-op 回報，不是錯誤。
 *   ineligible   —— 不符合條件（未付款、狀態不對、收件方式不對）。
 *
 * ship 的「已經做過」包含 shipped 之後又被標成 completed 的情況（shipped_at 有值）：
 * 舊分頁上再按一次「標記已出貨」，不該回「不符合條件」嚇人。
 */
export function classifyAfterNoop(
  action: FulfillmentAction,
  o: FulfillmentOrderFacts,
): "already_done" | "ineligible" {
  const t = FULFILLMENT_TRANSITIONS[action];
  if (!t.methods.includes(o.shipping_method)) return "ineligible";
  if (o.status === t.to) return "already_done";
  if (action === "ship" && o.status === "completed" && o.shipped_at) return "already_done";
  return "ineligible";
}

export const ACTION_BUTTON_LABEL: Record<FulfillmentAction, string> = {
  ship: "標記已出貨",
  pickup: "標記已取貨",
  complete: "標記已完成",
};

export const STATUS_LABEL_ZH: Record<string, string> = {
  pending: "待處理",
  processing: "處理中",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失敗",
};

/**
 * 二次確認的說明文字：一定講出訂單編號、狀態從什麼變成什麼、以及會不會寄信。
 * ship 會寄出貨通知信，所以講出收件信箱（遮罩過的，後台本來就只拿得到遮罩值）；
 * pickup／complete 不寄。
 */
export function confirmDescription(
  action: FulfillmentAction,
  orderNo: string,
  maskedEmail?: string | null,
): string {
  const t = FULFILLMENT_TRANSITIONS[action];
  const from = STATUS_LABEL_ZH[t.from];
  const to = STATUS_LABEL_ZH[t.to];
  const stamp = t.stampColumn === "shipped_at" ? "出貨時間" : "完成時間";
  const head = `訂單 ${orderNo} 的狀態會從「${from}」改成「${to}」`;
  if (action === "ship") {
    return (
      `${head}、記下現在的時間作為${stamp}，並寄出貨通知信給 ${maskedEmail || "訂購人信箱"}。` +
      "這個動作無法在這一頁復原。"
    );
  }
  return `${head}，並記下現在的時間作為${stamp}。這個動作不會寄信通知客人，也無法在這一頁復原。`;
}

/**
 * 要不要排出貨通知信：**只有** ship、而且這一次真的把 processing 改成了 shipped。
 * already_done（重按／另一個分頁先按了）、ineligible、order_not_found、pickup、
 * complete 一律不寄。
 */
export function shouldSendShippedEmail(action: FulfillmentAction, reason: string): boolean {
  return action === "ship" && reason === "updated";
}

/**
 * 出貨通知信的結果 → 給後台人員的提示。null＝不用提示（排進去了，或之前就排過）。
 * src/server/notify.ts 的 ShippedNotifyOutcome 與 ShippedNotifyResult 同形（這裡不
 * import 它，保持零 import；tsc 會在兩邊對不上時於 fns/orders.ts 報錯）。
 */
export function shippedNotifyWarning(outcome: ShippedNotifyResult): string | null {
  if (outcome.status !== "failed") return null;
  if (outcome.reason === "notify_timeout") {
    return "狀態已更新，但通知信排入逾時，請稍後到寄信紀錄確認是否已寄出";
  }
  return "狀態已更新，但通知信排入失敗";
}

export type ShippedNotifyResult =
  | { status: "queued" }
  | { status: "duplicate" }
  | { status: "failed"; reason: string };

/**
 * 狀態變更 → （必要時）排出貨通知信。server fn 唯一的編排邏輯，依賴由呼叫端注入，
 * 所以自檢可以拿記憶體裡的 orders 表與假的 outbox 驅動它本人。
 *
 * 規則：
 *   1. 先寫狀態（advance）。它 throw 就照樣往外丟——那是狀態沒寫成，該讓後台看到錯。
 *   2. 只有 shouldSendShippedEmail() 成立才呼叫 notifyShipped。
 *   3. 🔴 notifyShipped 失敗（回 failed 或甚至 throw）**不影響**第 1 步的結果：
 *      回傳值照舊是 updated，只多一句 notify_warning。
 */
export async function runFulfillmentWithNotify<R extends { reason: string }>(
  action: FulfillmentAction,
  deps: {
    advance: () => Promise<R>;
    notifyShipped: () => Promise<ShippedNotifyResult>;
    onNotifyError?: (message: string) => void;
  },
): Promise<R & { notify_warning: string | null }> {
  const result = await deps.advance();
  if (!shouldSendShippedEmail(action, result.reason)) {
    return { ...result, notify_warning: null };
  }
  let outcome: ShippedNotifyResult;
  try {
    outcome = await deps.notifyShipped();
  } catch (err) {
    deps.onNotifyError?.(err instanceof Error ? err.message : String(err));
    outcome = { status: "failed", reason: "unexpected_error" };
  }
  return { ...result, notify_warning: shippedNotifyWarning(outcome) };
}

/**
 * 「待出貨」的條件：已付款、處理中、宅配或超商、未封存。列表的 scope='to_ship'
 * 與首頁卡片的計數都用這一組，點進去看到的筆數與卡片上一致。
 */
export const TO_SHIP_FILTER = {
  status: "processing",
  payment_status: "paid",
  shipping_methods: SHIPPABLE_METHODS,
} as const;
