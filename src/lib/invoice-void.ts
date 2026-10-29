/**
 * 後台「作廢發票」的判斷與流程 —— **純函式，零 import。**（業主 2026-10-29）
 *
 * 資料庫與 Amego 都從參數注入（VoidDeps），所以 scripts/invoice-void-selftest.mjs
 * 可以直接 import 這一份產線程式，用假的 deps 驗每一種情況，**一次都不會真的打 Amego**。
 * 真正的接線在 src/server/invoice-void.ts。
 *
 * ── 流程（runInvoiceVoid）────────────────────────────────────────────────
 *   1. 檢查作廢原因：去頭尾空白後 1–20 字（Amego CancelReason 上限 20 字）。
 *   2. claim：資料庫重新讀那一列、for update 鎖住，確認仍是 issued、號碼相符、沒有別人
 *      正在作廢（0047 claim_invoice_void）。拿不到就停，**不打 Amego**。
 *   3. 帶原發票開立日期（invoices.issued_at 換算成台北日期，不是今天）呼叫作廢。
 *   4. 依 Amego 回應：
 *        成功                         → finish（status=voided＋原因／時間／操作者）
 *        3050131 等待作廢／「已作廢」  → 視為成功，同步 DB
 *        其他業務錯誤                  → release，DB 其餘欄位不動，原樣回錯誤碼與訊息
 *        逾時／連不上／回應看不懂      → 不重送。改用 OrderId 向 Amego 查詢實際狀態：
 *                                        查到等待作廢 → finish；查到仍有效 → release；
 *                                        查不到／查詢失敗 → release，告訴使用者結果不確定
 *   5. 任何沒走到 finish 的路徑都 release（try/finally）。
 *
 * 為什麼「結果不確定」可以讓使用者再按一次：再按會重新 claim、重新送作廢。如果上一次
 * 其實成功了，Amego 對同一張發票回 3050131（等待作廢，amego-live-test.mjs 實測），
 * 這裡把它當成功、只同步 DB——不會產生第二筆作廢，也不會把有效的發票誤記成作廢。
 */

/** Amego CancelReason 上限。 */
export const VOID_REASON_MAX = 20;

/** 作廢鎖多久算過期，與 0047 claim_invoice_void 的 p_stale_after 預設值一致。 */
export const VOID_STALE_AFTER = "3 minutes";

/** 已經送過作廢（實測：同一張再作廢一次回這個）。視為成功。 */
export const AMEGO_VOID_CODE_PENDING = 3050131;
/** 作廢時發票不存在（號碼或開立日期對不上）。 */
export const AMEGO_VOID_CODE_NOT_FOUND = 3050125;
/** 來源 IP 未被允許（沒走到中繼，或中繼 IP 不在白名單）。 */
export const AMEGO_CODE_IP = 14;
export const AMEGO_CODE_TIME = 15;
export const AMEGO_CODE_SIGN = 16;

/**
 * Amego 訊息裡像是「這張已經作廢過了」的字樣。**只當線索，不當結論**：錯誤碼不是
 * 3050131 時，字樣符合也要先向 Amego 查詢確認（訊息可能是「發票不存在或已作廢」這種
 * 合併句，直接當成功會把一張仍有效的發票記成作廢）。
 */
const ALREADY_VOIDED_MSG = /已作廢|已經作廢|已被作廢|重複作廢|等待作廢/;
/** 跨期／超過作廢期限。 */
const CROSS_PERIOD_MSG = /跨期|期限|逾期|已過.{0,6}期|申報|期別|不同期/;

// -----------------------------------------------------------------------------
// 1. 輸入
// -----------------------------------------------------------------------------

export function normalizeVoidReason(
  raw: unknown,
): { ok: true; reason: string } | { ok: false; message: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) return { ok: false, message: "請填寫作廢原因" };
  if (s.length > VOID_REASON_MAX) {
    return { ok: false, message: `作廢原因最多 ${VOID_REASON_MAX} 個字（目前 ${s.length} 字）` };
  }
  return { ok: true, reason: s };
}

/** 發票號碼：2 碼英文字軌＋8 碼數字。 */
export function isInvoiceNumber(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}\d{8}$/.test(value);
}

/**
 * 「作廢發票」按鈕要不要出現。只看狀態與號碼；授權（只有 admin）在 server fn 的
 * adminFnMiddleware，不在這裡。伺服器 claim 會再擋一次，這裡只是不讓使用者點出一個
 * 注定被拒的按鈕。
 */
export function canVoidInvoice(
  invoice: { status: string; invoice_number: string | null } | null | undefined,
): boolean {
  return Boolean(invoice && invoice.status === "issued" && isInvoiceNumber(invoice.invoice_number));
}

/** 原發票開立日期（Ymd，台北）。issued_at 沒有或解析不了回 undefined。 */
export function invoiceDateForVoid(issuedAt: string | null | undefined): string | undefined {
  if (!issuedAt) return undefined;
  const at = new Date(issuedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(at)
    .replace(/-/g, "");
}

// -----------------------------------------------------------------------------
// 2. Amego 回應的分類
// -----------------------------------------------------------------------------

/** 與 src/server/amego.ts 的 AmegoResult 同形（這裡不 import，以免拉進 server 模組）。 */
export type VoidCallResult =
  | { ok: true }
  | { ok: false; kind: "business"; code: number; msg: string }
  | { ok: false; kind: "transport"; code: null; msg: string };

export type RejectHint = "cross_period" | "not_found" | "ip" | "clock" | "other";

export type VoidCallClass =
  | { kind: "voided" }
  | { kind: "already_voided"; code: number; msg: string }
  /** 錯誤碼不是 3050131，但訊息看起來像已作廢 → 查詢確認後才下結論。 */
  | { kind: "maybe_voided"; code: number; msg: string }
  | { kind: "rejected"; code: number; msg: string; hint: RejectHint }
  | { kind: "uncertain"; msg: string };

export function classifyVoidCall(result: VoidCallResult): VoidCallClass {
  if (result.ok) return { kind: "voided" };
  if (result.kind === "transport") return { kind: "uncertain", msg: result.msg };
  const { code, msg } = result;
  if (code === AMEGO_VOID_CODE_PENDING) return { kind: "already_voided", code, msg };
  if (ALREADY_VOIDED_MSG.test(msg)) return { kind: "maybe_voided", code, msg };
  let hint: RejectHint = "other";
  if (CROSS_PERIOD_MSG.test(msg)) hint = "cross_period";
  else if (code === AMEGO_VOID_CODE_NOT_FOUND) hint = "not_found";
  else if (code === AMEGO_CODE_IP) hint = "ip";
  else if (code === AMEGO_CODE_TIME || code === AMEGO_CODE_SIGN) hint = "clock";
  return { kind: "rejected", code, msg, hint };
}

/** 與 src/server/amego.ts 的 findInvoiceByOrderId 回傳同形。 */
export type VoidQueryResult =
  | {
      ok: true;
      hit: { invoiceNumber: string; invoiceType: string; pendingVoid: boolean } | null;
    }
  | { ok: false; msg: string };

export type VoidQueryClass =
  | { kind: "confirmed_voided" }
  | { kind: "confirmed_valid" }
  | { kind: "unknown"; msg: string };

/**
 * 逾時之後向 Amego 查詢的結果怎麼解讀。只有「查得到、號碼相同」才下結論：
 * wait 裡有 C0501（等待作廢）或發票類別已是 C0501 → 已作廢；否則 → 仍有效。
 */
export function classifyVoidQuery(query: VoidQueryResult, invoiceNumber: string): VoidQueryClass {
  if (!query.ok) return { kind: "unknown", msg: `查詢失敗：${query.msg}` };
  if (!query.hit) return { kind: "unknown", msg: "光貿查不到這張訂單的發票" };
  if (query.hit.invoiceNumber !== invoiceNumber) {
    return {
      kind: "unknown",
      msg: `光貿查到的發票號碼是 ${query.hit.invoiceNumber || "（空）"}，與 ${invoiceNumber} 不同`,
    };
  }
  if (query.hit.pendingVoid || query.hit.invoiceType === "C0501") {
    return { kind: "confirmed_voided" };
  }
  return { kind: "confirmed_valid" };
}

// -----------------------------------------------------------------------------
// 3. 流程
// -----------------------------------------------------------------------------

export type VoidClaimReason =
  | "claimed"
  | "order_not_found"
  | "invoice_not_found"
  | "already_voided"
  | "not_issued"
  | "number_mismatch"
  | "locked"
  | "db_error";

export type VoidClaim =
  | {
      claimed: true;
      invoiceId: string;
      orderNo: string;
      invoiceNumber: string;
      issuedAt: string | null;
      total: number | null;
      /** claim 設下的 locked_at；release 只放掉相符的那一把（0047）。 */
      lockToken: string;
    }
  | { claimed: false; reason: Exclude<VoidClaimReason, "claimed">; status: string | null };

export type VoidDeps = {
  claim: (orderId: string, invoiceNumber: string) => Promise<VoidClaim>;
  /** 回 'voided'／'already_voided'／'not_issued'；資料庫錯誤請丟例外。 */
  finish: (p: {
    invoiceId: string;
    invoiceNumber: string;
    reason: string;
    actorId: string;
  }) => Promise<"voided" | "already_voided" | "not_issued">;
  release: (invoiceId: string, lockToken: string) => Promise<void>;
  callVoid: (p: {
    invoiceNumber: string;
    invoiceDate: string | undefined;
    reason: string;
  }) => Promise<VoidCallResult>;
  queryByOrderNo: (orderNo: string) => Promise<VoidQueryResult>;
  log?: (line: string) => void;
};

export type VoidOutcome =
  | {
      ok: true;
      kind: "voided";
      /** amego：Amego 直接回成功；already：Amego 說早就作廢了；query：逾時後查詢確認。 */
      via: "amego" | "already" | "query";
      orderNo: string;
      invoiceNumber: string;
    }
  | { ok: false; kind: "invalid_input"; message: string }
  | {
      ok: false;
      kind: "claim_rejected";
      reason: Exclude<VoidClaimReason, "claimed">;
      status: string | null;
    }
  | {
      ok: false;
      kind: "amego_rejected";
      code: number;
      msg: string;
      hint: RejectHint;
      orderNo: string;
      invoiceNumber: string;
    }
  | { ok: false; kind: "not_voided"; detail: string; orderNo: string; invoiceNumber: string }
  | { ok: false; kind: "missing_issue_date"; orderNo: string; invoiceNumber: string }
  | { ok: false; kind: "uncertain"; detail: string; orderNo: string; invoiceNumber: string }
  | {
      ok: false;
      kind: "db_write_failed";
      detail: string;
      orderNo: string;
      invoiceNumber: string;
    };

export async function runInvoiceVoid(
  input: { orderId: string; invoiceNumber: string; reason: unknown; actorId: string },
  deps: VoidDeps,
): Promise<VoidOutcome> {
  const log = deps.log ?? (() => {});
  const reason = normalizeVoidReason(input.reason);
  if (!reason.ok) return { ok: false, kind: "invalid_input", message: reason.message };
  if (!isInvoiceNumber(input.invoiceNumber)) {
    return { ok: false, kind: "invalid_input", message: "發票號碼格式不正確" };
  }

  const claim = await deps.claim(input.orderId, input.invoiceNumber);
  if (!claim.claimed) {
    log(`void claim rejected order=${input.orderId} reason=${claim.reason}`);
    return { ok: false, kind: "claim_rejected", reason: claim.reason, status: claim.status };
  }

  const { invoiceId, orderNo, invoiceNumber } = claim;
  let finished = false;
  try {
    const finishNow = async (via: "amego" | "already" | "query"): Promise<VoidOutcome> => {
      let r: Awaited<ReturnType<VoidDeps["finish"]>>;
      try {
        r = await deps.finish({
          invoiceId,
          invoiceNumber,
          reason: reason.reason,
          actorId: input.actorId,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`void finish failed order=${orderNo} invoice=${invoiceNumber} via=${via} ${detail}`);
        return { ok: false, kind: "db_write_failed", detail, orderNo, invoiceNumber };
      }
      if (r === "not_issued") {
        log(`void finish not_issued order=${orderNo} invoice=${invoiceNumber} via=${via}`);
        return {
          ok: false,
          kind: "db_write_failed",
          detail: "資料庫裡這張發票的狀態已經不是已開立",
          orderNo,
          invoiceNumber,
        };
      }
      finished = true;
      log(`void ok order=${orderNo} invoice=${invoiceNumber} via=${via} actor=${input.actorId}`);
      return { ok: true, kind: "voided", via, orderNo, invoiceNumber };
    };

    // 原發票開立日期一定要有；抓不到就不送（amego.ts 的 voidInvoice 會退回今天，那不對）。
    const invoiceDate = invoiceDateForVoid(claim.issuedAt);
    if (!invoiceDate) {
      log(`void refused order=${orderNo} invoice=${invoiceNumber} 沒有開立時間`);
      return { ok: false, kind: "missing_issue_date", orderNo, invoiceNumber };
    }

    const call = classifyVoidCall(
      await deps.callVoid({ invoiceNumber, invoiceDate, reason: reason.reason }),
    );

    if (call.kind === "voided") return await finishNow("amego");
    if (call.kind === "already_voided") return await finishNow("already");
    if (call.kind === "rejected") {
      log(`void rejected order=${orderNo} invoice=${invoiceNumber} code=${call.code} ${call.msg}`);
      return {
        ok: false,
        kind: "amego_rejected",
        code: call.code,
        msg: call.msg,
        hint: call.hint,
        orderNo,
        invoiceNumber,
      };
    }

    // 訊息像已作廢、但錯誤碼不是 3050131：查詢確認才算數，否則照業務錯誤回報。
    if (call.kind === "maybe_voided") {
      log(
        `void maybe_voided order=${orderNo} invoice=${invoiceNumber} code=${call.code} ${call.msg}，查詢確認`,
      );
      const q = classifyVoidQuery(await deps.queryByOrderNo(orderNo), invoiceNumber);
      if (q.kind === "confirmed_voided") return await finishNow("already");
      if (q.kind === "unknown") {
        return {
          ok: false,
          kind: "uncertain",
          detail: `光貿回覆（錯誤碼 ${call.code}：${call.msg}），但${q.msg}`,
          orderNo,
          invoiceNumber,
        };
      }
      return {
        ok: false,
        kind: "amego_rejected",
        code: call.code,
        msg: call.msg,
        hint: "other",
        orderNo,
        invoiceNumber,
      };
    }

    // 不確定：不重送，先問 Amego 實際狀態。
    log(`void uncertain order=${orderNo} invoice=${invoiceNumber} ${call.msg}，改查詢確認`);
    const q = classifyVoidQuery(await deps.queryByOrderNo(orderNo), invoiceNumber);
    if (q.kind === "confirmed_voided") return await finishNow("query");
    if (q.kind === "confirmed_valid") {
      // 查到的是「仍有效」，但作廢可能還在光貿那邊處理中——不說「沒有作廢」，免得業主
      // 跑去光貿後台再作廢一次。DB 沒動；再按一次是安全的（已送過會回 3050131）。
      return {
        ok: false,
        kind: "not_voided",
        detail: `作廢請求沒有回應（${call.msg}），向光貿查詢時這張發票仍顯示有效`,
        orderNo,
        invoiceNumber,
      };
    }
    return {
      ok: false,
      kind: "uncertain",
      detail: `作廢請求沒有回應（${call.msg}），${q.msg}`,
      orderNo,
      invoiceNumber,
    };
  } finally {
    if (!finished) {
      try {
        await deps.release(invoiceId, claim.lockToken);
      } catch (err) {
        // 放不掉也沒關係：鎖 3 分鐘後過期，下一次按就能接手。
        log(
          `void release failed invoice=${invoiceNumber} ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 4. 給業主看的話
// -----------------------------------------------------------------------------

export function describeVoidOutcome(o: VoidOutcome): {
  tone: "success" | "info" | "error";
  text: string;
} {
  switch (o.kind) {
    case "voided":
      return {
        tone: "success",
        text:
          o.via === "already"
            ? `發票 ${o.invoiceNumber} 在光貿已經是作廢狀態，已同步標記為「已作廢」`
            : o.via === "query"
              ? `發票 ${o.invoiceNumber} 已作廢（作廢請求逾時，向光貿查詢確認已作廢）`
              : `發票 ${o.invoiceNumber} 已作廢`,
      };
    case "invalid_input":
      return { tone: "error", text: o.message };
    case "claim_rejected":
      switch (o.reason) {
        case "already_voided":
          return { tone: "info", text: "這張發票已經作廢，沒有重複處理" };
        case "locked":
          return {
            tone: "info",
            text: "這張發票正在作廢中（可能是另一個分頁或剛剛按過），請稍後重新整理查看結果",
          };
        case "not_issued":
          return {
            tone: "error",
            text: `這張發票目前的狀態是「${o.status ?? "未知"}」，只有已開立的發票可以作廢`,
          };
        case "number_mismatch":
          return { tone: "error", text: "發票號碼與系統紀錄不符，請重新整理頁面再試" };
        case "order_not_found":
          return { tone: "error", text: "找不到這張訂單，可能已被刪除" };
        case "invoice_not_found":
          return { tone: "error", text: "這張訂單沒有發票資料" };
        default:
          return { tone: "error", text: "讀取發票狀態失敗，沒有送出作廢，請稍後再試" };
      }
    case "amego_rejected": {
      const head = `光貿拒絕作廢（錯誤碼 ${o.code}：${o.msg || "無訊息"}）。系統資料沒有變動。`;
      const tail: Record<RejectHint, string> = {
        cross_period:
          "這張發票已超過可作廢的期間（跨期）。電子發票只能在開立的同一期、申報截止前作廢；" +
          "跨期的發票不能作廢，請改開立折讓單，或請會計／光貿協助處理。",
        not_found: "光貿查不到這張發票（號碼或開立日期對不上），請先到光貿後台確認這張發票的狀態。",
        ip: "連線沒有經過固定 IP 中繼或中繼 IP 未被允許，請聯絡技術人員。",
        clock: "簽章或時間驗證失敗，請稍後再試；持續發生請聯絡技術人員。",
        other: "請依錯誤訊息處理，或聯絡技術人員。",
      };
      return { tone: "error", text: head + tail[o.hint] };
    }
    case "not_voided":
      return {
        tone: "error",
        text:
          `${o.detail}（作廢可能還在光貿處理中）。系統資料沒有變動。請不要到光貿後台另外作廢；` +
          "稍等一分鐘再按一次「作廢發票」——若作廢其實已送達，光貿會回覆「等待作廢」，系統只會同步狀態，不會重複作廢。",
      };
    case "missing_issue_date":
      return {
        tone: "error",
        text: `系統沒有發票 ${o.invoiceNumber} 的開立時間，無法帶正確的開立日期，沒有送出作廢。請聯絡技術人員。`,
      };
    case "uncertain":
      return {
        tone: "error",
        text:
          `${o.detail}。無法確認是否已作廢，系統資料沒有變動。請不要到光貿後台另外作廢；` +
          "稍等一分鐘再按一次「作廢發票」——若上一次其實成功了，光貿會回覆「已作廢」，系統只會同步狀態，不會重複作廢。",
      };
    case "db_write_failed":
      return {
        tone: "error",
        text:
          `光貿已作廢發票 ${o.invoiceNumber}，但寫回系統失敗（${o.detail}）。` +
          "請再按一次「作廢發票」同步狀態（光貿會回覆已作廢，不會重複作廢）；仍失敗請聯絡技術人員。",
      };
  }
}
