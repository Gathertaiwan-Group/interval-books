/**
 * 「已付款但發票開不出來」的判斷與告警去重 —— **純函式，零 server import。**
 *
 * 業主 2026-10-28 核准：「只要有已付款但發票開不出來的訂單，就寄信通知管理員」。
 *
 * ── 在補哪個洞 ────────────────────────────────────────────────────────────
 * 2026-09 有 5 張已付款訂單（IB-202600001191／1192／1193／1196／1197）開票失敗
 * （先是 Amego IP 白名單，後是中繼白名單錯字），retry_count 燒到上限
 * （INVOICE_MAX_RETRIES = 5）之後 claim 一律回 retries_exhausted、排程不再碰它們
 * ——而**沒有任何人被通知**。兩個月後才發現。資料都在 invoices 裡，只是沒有人看。
 *
 * ── 三個判斷，各自只定義一次 ─────────────────────────────────────────────
 *   isTerminalInvoiceFailure   自動重試已經停了（failed 且 retry_count ≥ 上限）
 *   needsInvoiceAttention      後台橫幅／每日彙整要列出來的那一組
 *   planTerminalAlert          這一輪排程要不要寄「開立失敗」信、寄哪幾張
 *
 * 後台橫幅（src/routes/admin/_shell.orders.tsx、_shell.index.tsx）、篩選後的訂單
 * 列表（?scope=invoice_problem）、每日彙整信用的是**同一支** needsInvoiceAttention，
 * 所以「橫幅說 5 張、點進去也剛好 5 張、彙整信也是 5 張」。
 *
 * ── 去重不靠 DDL ───────────────────────────────────────────────────────────
 * 這一期不加表、不加欄位。冪等鑰匙借 email_outbox.dedupe_key 的 unique
 * （0022 §0.6 / 0032 的 enqueue_admin_order_email() 本來就是 on conflict do nothing）：
 *
 *   · 開立失敗信：`invoice_failed_admin:<token>,<token>,…`。token = `<order_id>@<世代>`，
 *     世代是 invoices.updated_at 的毫秒數 —— 最後一次 fail_invoice_issue() 寫下的時間。
 *     同一次「停止重試」在每 10 分鐘的排程裡長得一模一樣（停了之後沒有任何路徑會再
 *     寫那一列，claim 在 retries_exhausted 就提早 return），所以只寄一次；業主按了
 *     「重新開立發票」又失敗到上限，updated_at 變了，是新的世代，會再寄一次——那正是
 *     該被通知的事。
 *     另加一道保險：同一張訂單 ALERT_COOLDOWN_MS（6 小時）內只寄一次，就算哪天有別的
 *     程式反覆碰 updated_at，也不會變成每 10 分鐘一封。
 *   · 每日彙整：`invoice_digest_admin:<台北日期>`，一天最多一封，且只在台北 09:00–09:59
 *     的排程裡排（09:03 那一輪失敗的話 09:13 會補，之後全部撞 unique）。只開一小時而
 *     不是「09:00 之後都行」：上線當天下午第一輪會先寄一封開立失敗信，不要同一刻再補一封
 *     內容一樣的彙整。一小時六輪都失敗的話那一天就不寄，隔天早上照常。
 *
 * 一輪排程最多寄**一封**開立失敗信（多張就合在一起，主旨寫「等 N 張」），一封最多列
 * MAX_ORDERS_PER_ALERT 張，其餘下一輪再寄——系統性故障（Amego 掛一整天）時不會一張
 * 單一封地灌爆信箱。
 *
 * ⚠️ 只寄給 site_settings.notify_emails（店家），**絕不寄給客人**。
 */

/** 每日彙整與橫幅的「卡太久」門檻：付款後 24 小時發票還沒開出來。 */
export const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

/** 同一張訂單兩封「開立失敗」信之間至少隔多久（防止 updated_at 被反覆碰觸時洗版）。 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** 一封開立失敗信最多列幾張；超過的下一輪（10 分鐘後）再寄。 */
export const MAX_ORDERS_PER_ALERT = 10;

/** 每日彙整最早從台北幾點開始排。 */
export const DIGEST_HOUR_TAIPEI = 9;

export const FAILED_ALERT_KEY_PREFIX = "invoice_failed_admin:";
export const DIGEST_KEY_PREFIX = "invoice_digest_admin:";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 一張「已付款、有金額」訂單的發票狀態。status = 'missing' 代表 invoices 沒有那一列
 * （claim 會補建，所以是暫態，但它同樣是「沒有發票」）。
 */
export type InvoiceProblemRow = {
  orderId: string;
  orderNo: string;
  paidAt: string | null;
  total: number;
  /** pending／issuing／failed／missing（issued／voided 不會進來，見 needsInvoiceAttention）。 */
  status: string;
  retryCount: number;
  errorMessage: string | null;
  /** invoices.updated_at；missing 時為 null。 */
  updatedAt: string | null;
};

/** 自動重試已經停了：failed 且 retry_count 到上限。與 0007 claim 的 retries_exhausted 同一個條件。 */
export function isTerminalInvoiceFailure(
  row: Pick<InvoiceProblemRow, "status" | "retryCount">,
  maxRetries: number,
): boolean {
  return row.status === "failed" && row.retryCount >= maxRetries;
}

/**
 * 後台橫幅／篩選列表／每日彙整共用的「需要人看」定義。
 *
 *   · 已開立（issued）、已作廢（voided）、金額 0（0028：免費訂單不開發票）→ 不算
 *   · 自動重試已停 → 算（不管付款多久）
 *   · 其餘（pending／issuing／failed 還在重試／missing）→ 付款超過 24 小時才算；
 *     paid_at 是 null 的已付款單（資料異常）直接算
 *
 * 24 小時內還在重試的不算：排程每 10 分鐘補一次，五次燒完大約 50 分鐘，那時它會以
 * 「自動重試已停」的身分進來——不需要在它還有救的時候就讓橫幅變紅。
 */
export function needsInvoiceAttention(
  row: InvoiceProblemRow,
  now: Date,
  maxRetries: number,
): boolean {
  if (row.status === "issued" || row.status === "voided") return false;
  if (!(row.total > 0)) return false;
  if (isTerminalInvoiceFailure(row, maxRetries)) return true;
  if (!row.paidAt) return true;
  const paid = Date.parse(row.paidAt);
  if (Number.isNaN(paid)) return true;
  return now.getTime() - paid >= STUCK_AFTER_MS;
}

/** 一次「停止重試」的身分：`<order_id>@<updated_at 毫秒>`。updated_at 讀不到時用 0。 */
export function alertToken(row: Pick<InvoiceProblemRow, "orderId" | "updatedAt">): string {
  const t = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
  return `${row.orderId}@${Number.isNaN(t) ? 0 : t}`;
}

export function failedAlertKey(tokens: string[]): string {
  return FAILED_ALERT_KEY_PREFIX + [...tokens].sort().join(",");
}

/** 從既有的 dedupe_key 拆回 token（不是這個前綴的回空陣列）。 */
export function tokensFromAlertKey(key: string): string[] {
  if (!key.startsWith(FAILED_ALERT_KEY_PREFIX)) return [];
  return key
    .slice(FAILED_ALERT_KEY_PREFIX.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type SentAlert = { dedupeKey: string; createdAt: string };

/**
 * 這一輪要不要寄開立失敗信。
 *
 * @param rows   目前所有「已付款、有金額、發票沒開成」的列（不用先過濾，這裡會挑 terminal）
 * @param sent   email_outbox 裡已經存在的 invoice_failed_admin:* 列
 * @returns      null＝這一輪什麼都不寄；否則是要列進信裡的訂單與 dedupe_key
 */
export function planTerminalAlert(
  rows: InvoiceProblemRow[],
  sent: SentAlert[],
  now: Date,
  maxRetries: number,
): { rows: InvoiceProblemRow[]; dedupeKey: string; remaining: number } | null {
  const sentTokens = new Set<string>();
  const lastSentByOrder = new Map<string, number>();
  for (const s of sent) {
    const created = Date.parse(s.createdAt);
    for (const token of tokensFromAlertKey(s.dedupeKey)) {
      sentTokens.add(token);
      const orderId = token.split("@")[0];
      if (!Number.isNaN(created) && created > (lastSentByOrder.get(orderId) ?? -Infinity)) {
        lastSentByOrder.set(orderId, created);
      }
    }
  }

  const fresh = rows
    .filter((r) => r.total > 0 && isTerminalInvoiceFailure(r, maxRetries))
    .filter((r) => !sentTokens.has(alertToken(r)))
    .filter((r) => {
      const last = lastSentByOrder.get(r.orderId);
      return last === undefined || now.getTime() - last >= ALERT_COOLDOWN_MS;
    })
    .sort((a, b) => a.orderNo.localeCompare(b.orderNo));

  if (fresh.length === 0) return null;
  const picked = fresh.slice(0, MAX_ORDERS_PER_ALERT);
  return {
    rows: picked,
    dedupeKey: failedAlertKey(picked.map(alertToken)),
    remaining: fresh.length - picked.length,
  };
}

/** 台北日期 YYYY-MM-DD。 */
export function taipeiDateKey(now: Date): string {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 台北時間落在 DIGEST_HOUR_TAIPEI 點這一個小時之內（09:00–09:59）。 */
export function inDigestWindow(now: Date): boolean {
  const hour = new Date(now.getTime() + TAIPEI_OFFSET_MS).getUTCHours();
  return hour === DIGEST_HOUR_TAIPEI;
}

export function digestKey(now: Date): string {
  return DIGEST_KEY_PREFIX + taipeiDateKey(now);
}

/**
 * 這一輪要不要排每日彙整。null＝不排（還沒到 09:00，或沒有需要人看的單）。
 * 一天一封由 dedupe_key 保證（同一天第二次排會撞 unique 變成 no-op）。
 */
export function planDigest(
  rows: InvoiceProblemRow[],
  now: Date,
  maxRetries: number,
): { rows: InvoiceProblemRow[]; dedupeKey: string } | null {
  if (!inDigestWindow(now)) return null;
  const attention = rows
    .filter((r) => needsInvoiceAttention(r, now, maxRetries))
    .sort((a, b) => a.orderNo.localeCompare(b.orderNo));
  if (attention.length === 0) return null;
  return { rows: attention, dedupeKey: digestKey(now) };
}

/**
 * 後台「重新開立發票」按鈕要不要出現。伺服器那一側（reissueInvoiceForOrder）會再
 * 擋一次，這裡只是不讓人按出一個注定被拒的按鈕。
 */
export function canReissueInvoice(
  order: { paymentStatus: string; total: number; paidAt: string | null },
  invoice: { status: string; retryCount: number; updatedAt: string | null } | null,
  now: Date,
  maxRetries: number,
): boolean {
  if (order.paymentStatus !== "paid" || !(order.total > 0)) return false;
  const status = invoice?.status ?? "missing";
  if (status === "failed") return true;
  return needsInvoiceAttention(
    {
      orderId: "",
      orderNo: "",
      paidAt: order.paidAt,
      total: order.total,
      status,
      retryCount: invoice?.retryCount ?? 0,
      errorMessage: null,
      updatedAt: invoice?.updatedAt ?? null,
    },
    now,
    maxRetries,
  );
}

/** 後台與信件共用的狀態中文。 */
export function invoiceStatusLabel(status: string, retryCount: number, maxRetries: number): string {
  if (status === "failed")
    return retryCount >= maxRetries ? "開立失敗（已停止自動重試）" : "開立失敗（自動重試中）";
  return (
    {
      pending: "待開立",
      issuing: "開立中",
      issued: "已開立",
      voided: "已作廢",
      missing: "尚無發票資料",
    }[status] ?? status
  );
}
