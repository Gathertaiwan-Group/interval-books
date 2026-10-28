/**
 * 開發票的編排層：claim → 打 Amego → 記結果。
 *
 * ── 為什麼 claim 一定要在打 Amego 之前 ──────────────────────────────────────
 * 發票開出去撤不回來。財政部那邊多一張就是多一張，只能再開一張作廢單去沖銷，而客人
 * 的信箱裡已經躺著兩份稅務憑證了。所以順序是硬性的：
 *
 *   1. claimInvoiceIssue()  —— 原子地宣告「這張由我開」（0007 的三道閘門）
 *   2. 呼叫 Amego           —— 只有拿到 claim 的人可以做這一步
 *   3. finish / fail        —— 一定要走到其中一個
 *
 * 反過來（先開再記）在任何一次重送、任何一次 instance 被回收時都會開出第二張。
 *
 * ── 重試前先問「是不是已經開過了」────────────────────────────────────────
 * 第 2 步與第 3 步之間如果程序被砍掉，狀態是「Amego 已經開了，我們沒記到」。這一種
 * 一定要用 findInvoiceByOrderId() 認回來，而不是重開一張。Amego 的 OrderId 唯一，
 * 所以我們用 orders.order_no 當 OrderId，它天然就是冪等鍵；就算沒查、直接重開，
 * Amego 也會回 3040171（OrderId 重複），那同樣被當成「已經開過」處理 —— 兩道保險。
 *
 * ── 為什麼失敗不會讓 webhook 失敗 ──────────────────────────────────────────
 * docs/alignment-audit.md 已經寫過：把開發票塞進金流 webhook 的同步流程，Amego 一掛
 * 就會讓 PayUni 收到 5xx 而不斷重送。所以 issueInvoiceForOrder() 從不 throw，
 * 呼叫端（webhook）拿到的永遠是一個可以忽略的結果物件，而失敗會留在 invoices 與
 * order_post_payment_log 裡等 backlog 收拾。
 */
import "@tanstack/react-start/server-only";
import {
  AMEGO_CODE_DUPLICATE_ORDER,
  amegoConfigured,
  findInvoiceByOrderId,
  isCarrierRejection,
  isPermanentAmegoError,
  isValidTaxId,
  issueInvoice,
  type InvoiceLine,
} from "@/server/amego";
import {
  claimInvoiceIssue,
  failInvoiceIssue,
  getInvoiceStateForReissue,
  resetInvoiceRetriesForReissue,
  finishInvoiceIssue,
  getInvoicePrefs,
  getOrderForInvoice,
  invoiceBacklog,
} from "@/server/repos/invoices";
import { isValidCarrier, isValidLoveCode } from "@/lib/invoice-format";

export type IssueOutcome =
  | { ok: true; invoiceNumber: string; adopted: boolean }
  | { ok: false; reason: string; permanent: boolean };

/** 發票品名的長度上限。超過 Amego 會擋，截斷比開不出來好。 */
const MAX_DESCRIPTION = 100;

/**
 * 把一張訂單攤成發票明細。
 *
 * 三條規則，每一條都有理由：
 *   * 運費是一列 —— 併進商品單價會讓明細對不上客人手上的訂單，國稅局查帳時也對不起來。
 *   * 折扣是**負數列**，不是另外的欄位。官方範例就是這樣做的
 *     （{"Description":"會員折抵","UnitPrice":"-2","Amount":"-2"}）。
 *   * 品名取中文 —— 發票是給國稅局看的，不跟著客人的介面語言走。
 *
 * 明細加總必須等於 orders.total，呼叫端會斷言這件事。
 */
export function buildInvoiceLines(
  order: { shippingFee: number; discount: number },
  items: { name: Record<string, string>; unitPrice: number; quantity: number; subtotal: number }[],
): InvoiceLine[] {
  const lines: InvoiceLine[] = items.map((item) => ({
    description: (item.name.zh || item.name.en || item.name.ja || "商品").slice(0, MAX_DESCRIPTION),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: item.subtotal,
  }));

  if (order.shippingFee > 0) {
    lines.push({
      description: "運費",
      quantity: 1,
      unitPrice: order.shippingFee,
      amount: order.shippingFee,
    });
  }
  if (order.discount > 0) {
    lines.push({
      description: "折扣",
      quantity: 1,
      unitPrice: -order.discount,
      amount: -order.discount,
    });
  }

  return lines;
}

/** 明細加總。與 orders.total 比對用。 */
export function sumInvoiceLines(lines: InvoiceLine[]): number {
  return lines.reduce((acc, l) => acc + l.amount, 0);
}

/**
 * 決定這張發票的買方資訊。
 *
 * 統編格式不對時**退回 B2C 開立**而不是失敗：一張抬頭不完美的發票，永遠好過一張
 * 因為客人打錯統編就永遠開不出來的發票（那個失敗是永久性的，只能人工介入）。
 * 客人要改抬頭可以走折讓／作廢重開，那是有補救路徑的；沒有發票沒有補救路徑。
 *
 * 載具與愛心碼適用同一條規則。它們的錯誤碼（3040132 載具號碼不存在、愛心碼不存在）
 * 都被 isPermanentAmegoError() 判為永久失敗，所以一個打錯的載具會讓 retry_count 一路
 * 燒到上限，而客人只是想把發票存進手機而已。這裡在送出前先驗一次格式，不合格就丟掉
 * 那個欄位照常開票，並把原因寫進 warning 讓 log 看得見。
 *
 * ⚠️ 前端（src/lib/checkout.ts 的 invoiceSchema）與寫入時（normalizeInvoiceChoice）
 * 都各驗過一次，所以這裡照理走不到。留著是因為 invoices 那一列也可能來自舊訂單、
 * 人工修改或 0007 補建的預設列 —— 開票是這條路徑的最後一關。
 */
export function resolveBuyer(
  prefs: {
    invoiceType: string;
    taxId: string | null;
    companyTitle: string | null;
    carrierType: string | null;
    carrierNumber: string | null;
    loveCode: string | null;
  } | null,
  order: { customerName: string; customerEmail: string },
): {
  taxId: string | null;
  buyerName: string;
  carrierType: string | null;
  carrierId: string | null;
  loveCode: string | null;
  warning: string | null;
} {
  const wantsCompany = prefs?.invoiceType === "company";
  const rawTaxId = (prefs?.taxId ?? "").trim();

  if (wantsCompany && rawTaxId) {
    if (isValidTaxId(rawTaxId)) {
      return {
        taxId: rawTaxId,
        buyerName: (prefs?.companyTitle ?? "").trim() || order.customerName || "消費者",
        carrierType: null,
        carrierId: null,
        loveCode: null,
        warning: null,
      };
    }
    return {
      taxId: null,
      buyerName: order.customerName || "消費者",
      carrierType: null,
      carrierId: null,
      loveCode: null,
      warning: `統編 ${rawTaxId} 檢核碼不正確，已改開個人發票`,
    };
  }

  if (prefs?.invoiceType === "donate") {
    const loveCode = (prefs.loveCode ?? "").trim();
    if (isValidLoveCode(loveCode)) {
      return {
        taxId: null,
        buyerName: order.customerName || "消費者",
        carrierType: null,
        carrierId: null,
        loveCode,
        warning: null,
      };
    }
    // 與統編同一個判斷：格式不對就退回個人發票。送出去只會拿到 Amego 的永久失敗，
    // 而那代表這張訂單再也開不出發票 —— 客人捐不成，也拿不到發票。
    return {
      taxId: null,
      buyerName: order.customerName || "消費者",
      carrierType: null,
      carrierId: null,
      loveCode: null,
      warning: `愛心碼 ${loveCode || "(空)"} 格式不正確，已改開個人發票`,
    };
  }

  const carrierType = (prefs?.carrierType ?? "").trim() || null;
  const carrierId = (prefs?.carrierNumber ?? "").trim() || null;
  if (carrierType && !isValidCarrier(carrierType, carrierId)) {
    // 載具號碼不存在會拿到 3040132，同樣是永久失敗。丟掉載具照 B2C 開，客人的發票
    // 仍然開得出來（只是沒歸到載具裡），這是有補救路徑的那一邊。
    return {
      taxId: null,
      buyerName: order.customerName || "消費者",
      carrierType: null,
      carrierId: null,
      loveCode: null,
      warning: `載具 ${carrierType}/${carrierId ?? "(空)"} 格式不正確，已改開一般個人發票`,
    };
  }

  return {
    taxId: null,
    buyerName: order.customerName || "消費者",
    carrierType,
    carrierId,
    loveCode: null,
    warning: null,
  };
}

/**
 * 開一張訂單的發票。永不 throw。
 *
 * 回傳 ok:false 時 reason 已經寫進資料庫（invoices.error_message 與
 * order_post_payment_log.error_message），所以呼叫端不需要另外記；它只需要決定要不要
 * 因此改變自己的回應（webhook 的答案是「不要」）。
 */
export type IssueOptions = {
  /**
   * 後台「重新開立發票」用：不管 attempt 是多少，打 Amego 之前**一定**先查一次這張
   * 訂單是不是已經開過；查詢本身失敗，**這一次**就不開（記一次可重試的失敗）。
   *
   * ⚠️ 這個保證只涵蓋按鈕那一次。之後排程接手時 attempt > 0，同樣會先查，但查詢失敗
   *    時排程照舊會開——那條路徑的最後一道保險是 Amego 的 OrderId 唯一性（3040171，
   *    見下面「OrderId 重複」那一段會認領回來），與按鈕之前的自動重試完全相同。
   *    自動路徑（webhook／排程）不帶這個選項，行為不變。
   */
  requireLookup?: boolean;
};

export async function issueInvoiceForOrder(
  orderId: string,
  options: IssueOptions = {},
): Promise<IssueOutcome> {
  if (!amegoConfigured()) {
    // 刻意不 claim：沒有設定不是這張訂單的問題，claim 下去只會把 retry_count 燒掉，
    // 讓設定補上之後反而開不出來。留在 backlog 裡等設定到位。
    console.warn(
      `[amego] 未設定 AMEGO_INVOICE_BAN / AMEGO_APP_KEY，訂單 ${orderId} 的發票留待補開`,
    );
    return { ok: false, reason: "amego_not_configured", permanent: false };
  }

  const claim = await claimInvoiceIssue(orderId);
  if (!claim.claimed) {
    if (claim.reason === "already_issued") {
      return { ok: true, invoiceNumber: claim.invoiceNumber ?? "", adopted: true };
    }
    // locked 是正常的併發結果，不值得吵；其餘都值得留紀錄。
    if (claim.reason !== "locked") {
      console.warn(`[amego] 未取得開票許可 order=${orderId} reason=${claim.reason}`);
    }
    return { ok: false, reason: claim.reason, permanent: claim.reason === "retries_exhausted" };
  }

  // 拿到 claim 之後，任何路徑都必須走到 finish 或 fail。
  try {
    return await issueWithClaim(orderId, claim.attempt, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[amego] 開票途中發生未預期例外 order=${orderId}`, err);
    await failInvoiceIssue({ orderId, error: `unexpected: ${message}`, permanent: false });
    return { ok: false, reason: "unexpected_error", permanent: false };
  }
}

async function issueWithClaim(
  orderId: string,
  attempt: number,
  options: IssueOptions = {},
): Promise<IssueOutcome> {
  const loaded = await getOrderForInvoice(orderId);
  if (!loaded) {
    await failInvoiceIssue({ orderId, error: "order_not_found", permanent: true });
    return { ok: false, reason: "order_not_found", permanent: true };
  }
  const { order, items } = loaded;

  if (items.length === 0) {
    await failInvoiceIssue({ orderId, error: "order_has_no_items", permanent: true });
    return { ok: false, reason: "order_has_no_items", permanent: true };
  }

  // ---- 重試前先問 Amego：上一次是不是其實開成功了 ----------------------------
  // attempt > 0 才問，第一次開票不需要多這一次往返。後台重新開立（requireLookup）一律問。
  if (attempt > 0 || options.requireLookup) {
    const found = await findInvoiceByOrderId(order.orderNo);
    if (found.ok && found.hit && found.hit.invoiceNumber) {
      console.warn(
        `[amego] order=${order.orderNo} 上一次其實已經開成功（${found.hit.invoiceNumber}），認回來不重開`,
      );
      await finishInvoiceIssue({
        orderId,
        invoiceNumber: found.hit.invoiceNumber,
        randomCode: found.hit.randomNumber || null,
      });
      return { ok: true, invoiceNumber: found.hit.invoiceNumber, adopted: true };
    }
    // 後台重新開立：查不到「有沒有開過」就不開。記一次可重試的失敗、釋放 claim，
    // 排程下一輪（attempt > 0）會先查再開。
    if (!found.ok && options.requireLookup) {
      const msg = `reissue_lookup_failed: ${found.msg}`;
      console.warn(`[amego] order=${order.orderNo} 重新開立前查詢失敗，這一次不開（${found.msg}）`);
      await failInvoiceIssue({ orderId, error: msg, permanent: false });
      return { ok: false, reason: msg, permanent: false };
    }
    // 查詢失敗不阻斷：真的重複開了，Amego 會用 3040171 擋下來，下面有處理。
    if (!found.ok) {
      console.warn(
        `[amego] order=${order.orderNo} 重試前查詢失敗（${found.msg}），改靠 OrderId 唯一性`,
      );
    }
  }

  const lines = buildInvoiceLines(order, items);
  const linesTotal = sumInvoiceLines(lines);

  // ---- 金額必須與訂單一致，否則不開 ------------------------------------------
  // 發票是稅務憑證：開一張金額跟訂單不符的，比不開更難收拾（要作廢重開，而且已經
  // 上傳到財政部）。這是永久失敗，等人查清楚為什麼對不起來。
  if (linesTotal !== order.total) {
    const msg = `amount_mismatch lines=${linesTotal} order_total=${order.total}`;
    console.error(`[amego] 🚨 ${msg} order=${order.orderNo} — 拒絕開立，需人工確認`);
    await failInvoiceIssue({ orderId, error: msg, permanent: true });
    return { ok: false, reason: "amount_mismatch", permanent: true };
  }

  const prefs = await getInvoicePrefs(orderId);
  const buyer = resolveBuyer(prefs, order);
  if (buyer.warning) console.warn(`[amego] order=${order.orderNo} ${buyer.warning}`);

  let result = await issueInvoice({
    orderId: order.orderNo,
    taxId: buyer.taxId,
    buyerName: buyer.buyerName,
    buyerEmail: order.customerEmail || null,
    carrierType: buyer.carrierType,
    carrierId: buyer.carrierId,
    loveCode: buyer.loveCode,
    lines,
  });

  // ---- 載具被 Amego 退回 → 拿掉載具再開一次 ---------------------------------
  // 「載具號碼不存在」（3040132）是本地驗不到的：格式再正確，號碼在財政部那邊查無
  // 此號就是查無此號。實測確認過這條路徑會發生（IB-202600000042，載具 /ABC1234
  // 格式完全合法）。
  //
  // 不處理的話結局是：isPermanentAmegoError(3040132) = true → retry_count 直接推到
  // 上限 → 這張訂單**永遠沒有發票**，而客人只是把手機條碼打錯一碼。所以這裡退一步
  // 重開一張沒有載具的 B2C 發票 —— 憑證開得出來，客人事後還能拿發票號碼去財政部
  // 平台自己歸戶；反過來則沒有任何補救路徑。
  //
  // 只退這一步，不再往下退（沒有載具的那一張再失敗就是真的失敗），所以不會變成迴圈。
  // 重開用的是同一個 OrderId，安全性由 Amego 的唯一性保證：第一次真的沒開成功（業務
  // 錯誤，沒有配號），萬一其實開了，第二次會拿到 3040171，而那條路徑在下面被當成
  // 「已經開過」認領回來，不會產生第二張。
  //
  // ⚠️ 這種情況下 invoices.carrier_type 仍然留著客人**當初要求**的載具，而實際開出去
  // 的那張沒有載具 —— 兩者不一致就是「被降級過」的痕跡。要清查的話：把
  // invoices.carrier_type is not null 的單拿去 invoice_query，回來的 carrier_type
  // 是空字串的就是這一類。
  if (
    !result.ok &&
    result.kind === "business" &&
    isCarrierRejection(result.code) &&
    (buyer.carrierType || buyer.carrierId)
  ) {
    console.warn(
      `[amego] order=${order.orderNo} 載具 ${buyer.carrierType}/${buyer.carrierId} 被 Amego 退回` +
        `（${result.code} ${result.msg}），改開無載具的個人發票`,
    );
    result = await issueInvoice({
      orderId: order.orderNo,
      taxId: buyer.taxId,
      buyerName: buyer.buyerName,
      buyerEmail: order.customerEmail || null,
      carrierType: null,
      carrierId: null,
      loveCode: buyer.loveCode,
      lines,
    });
  }

  if (result.ok && result.invoice?.invoiceNumber) {
    const finished = await finishInvoiceIssue({
      orderId,
      invoiceNumber: result.invoice.invoiceNumber,
      randomCode: result.invoice.randomNumber || null,
      issuedAt: result.invoice.invoiceTime
        ? new Date(result.invoice.invoiceTime * 1000).toISOString()
        : undefined,
    });
    if (!finished.ok) {
      // 發票真的開出去了，只是我們沒記成功。絕不可以標成 failed 讓它被重開。
      console.error(
        `[amego] 🚨 已開立但寫回資料庫失敗 order=${order.orderNo} invoice=${result.invoice.invoiceNumber} — ` +
          `不重試，需人工把號碼補進 invoices`,
      );
      return { ok: false, reason: "issued_but_not_recorded", permanent: true };
    }
    console.info(
      `[amego] 已開立 order=${order.orderNo} invoice=${result.invoice.invoiceNumber} total=${order.total}`,
    );
    return { ok: true, invoiceNumber: result.invoice.invoiceNumber, adopted: false };
  }

  // ---- 開立成功以外的每一種回應 ----------------------------------------------
  if (result.ok) {
    // code=0 但沒有發票號碼。不該發生；當成失敗，而不是當成成功放它過去。
    await failInvoiceIssue({ orderId, error: "ok_without_invoice_number", permanent: false });
    return { ok: false, reason: "ok_without_invoice_number", permanent: false };
  }

  // OrderId 重複 = 這張訂單已經開過了。查回來認領，而不是報錯，也絕不重開。
  if (result.kind === "business" && result.code === AMEGO_CODE_DUPLICATE_ORDER) {
    const found = await findInvoiceByOrderId(order.orderNo);
    if (found.ok && found.hit?.invoiceNumber) {
      console.warn(
        `[amego] order=${order.orderNo} OrderId 重複，認回既有發票 ${found.hit.invoiceNumber}`,
      );
      await finishInvoiceIssue({
        orderId,
        invoiceNumber: found.hit.invoiceNumber,
        randomCode: found.hit.randomNumber || null,
      });
      return { ok: true, invoiceNumber: found.hit.invoiceNumber, adopted: true };
    }
    await failInvoiceIssue({
      orderId,
      error: "duplicate_order_id_but_query_failed",
      permanent: false,
    });
    return { ok: false, reason: "duplicate_order_id_but_query_failed", permanent: false };
  }

  const code = result.kind === "business" ? result.code : null;
  const permanent = isPermanentAmegoError(code);
  const message = `amego code=${code ?? "transport"} msg=${result.msg}`;
  console.error(`[amego] 開立失敗 order=${order.orderNo} ${message} permanent=${permanent}`);
  await failInvoiceIssue({ orderId, error: message, permanent });
  return { ok: false, reason: message, permanent };
}

/**
 * 付款確認之後觸發開票，且**保證不會拖垮呼叫端**。
 *
 * webhook 的職責是「盡快告訴金流商我收到了」。Amego 慢一點沒關係（實測單次往返約
 * 200ms），但它掛掉時不能讓 PayUni 收到逾時或 5xx —— 那會換來無止盡的重送。所以這裡
 * 給一個上限，超時就當作沒開成，交給 backlog；claim 會在 p_stale_after 之後被接手。
 */
export async function triggerInvoiceAfterPayment(
  orderId: string,
  timeoutMs = 8_000,
): Promise<IssueOutcome> {
  const timeout = new Promise<IssueOutcome>((resolve) =>
    setTimeout(
      () => resolve({ ok: false, reason: "invoice_timeout", permanent: false }),
      timeoutMs,
    ).unref?.(),
  );
  try {
    const outcome = await Promise.race([issueInvoiceForOrder(orderId), timeout]);
    if (!outcome.ok && outcome.reason === "invoice_timeout") {
      console.error(`[amego] 開票逾時 order=${orderId} —— 已交給 backlog，webhook 照常回 200`);
    }
    return outcome;
  } catch (err) {
    console.error("[amego] triggerInvoiceAfterPayment 例外", err);
    return { ok: false, reason: "unexpected_error", permanent: false };
  }
}

export type BacklogRunResult = {
  scanned: number;
  issued: number;
  adopted: number;
  failed: number;
  details: { orderNo: string; outcome: string }[];
};

/**
 * 掃過待開清單，逐張補開。
 *
 * 這是「開立失敗不會就這樣算了」的那一半 —— webhook 當下失敗的、instance 被回收的、
 * Amego 當時掛掉的，全部從這裡補回來。目前由 /api/tasks/invoices 觸發
 * （src/server/task-endpoints.ts），排程還沒接（見那個檔案的 ⚠️）。
 *
 * 序列跑，不並行：同時打 Amego 好幾張並沒有比較快（瓶頸不在我們這邊），但併發會讓
 * 錯誤變得難以歸因，而這是一個「錯了就要人工去國稅局收拾」的流程。
 */
export async function runInvoiceBacklog(limit = 20): Promise<BacklogRunResult> {
  const rows = await invoiceBacklog(limit);
  const out: BacklogRunResult = {
    scanned: rows.length,
    issued: 0,
    adopted: 0,
    failed: 0,
    details: [],
  };

  for (const row of rows) {
    const outcome = await issueInvoiceForOrder(row.orderId);
    if (outcome.ok) {
      if (outcome.adopted) out.adopted += 1;
      else out.issued += 1;
      out.details.push({ orderNo: row.orderNo, outcome: `ok ${outcome.invoiceNumber}` });
    } else {
      out.failed += 1;
      out.details.push({ orderNo: row.orderNo, outcome: `fail ${outcome.reason}` });
    }
  }

  return out;
}

export type ReissueOutcome =
  | { reason: "issued" | "adopted"; orderNo: string; invoiceNumber: string }
  | { reason: "failed"; orderNo: string; message: string; permanent: boolean }
  /**
   * 發票**已經開出去了**，只是寫回資料庫失敗。絕不可以讓人以為「沒開成」而去光貿後台
   * 手動再開一張：這張單會停在 issuing，5 分鐘後被 reclaim 撥回 failed，排程重試時
   * attempt > 0 會先查到那張發票並補登號碼。
   */
  | { reason: "issued_unrecorded"; orderNo: string }
  | { reason: "locked"; orderNo: string }
  | {
      reason: "already_issued" | "voided" | "not_paid" | "zero_total";
      orderNo: string;
    }
  | { reason: "order_not_found" | "not_configured" | "db_error" };

/**
 * 後台「重新開立發票」——**只給 admin 按**（src/lib/admin/fns/invoices.ts 掛
 * adminFnMiddleware）。業主 2026-10-28 核准，用來補 2026-09 那 5 張停止重試的單。
 *
 * 做三件事，順序是固定的：
 *   1. 擋掉不該開的：未付款、金額 0（0028）、已開立、已作廢、正在開立中。
 *   2. failed 的把 retry_count 設回 **1**（不是 0）。設 1 的理由：之後不論是這一次、
 *      還是排程接手（排程在 attempt > 0 時也會先查），claim 拿到的 attempt 都 > 0，
 *      **每一條路徑在打 Amego 之前都會先問「是不是已經開過了」**。設 0 的話，排程若
 *      剛好搶先 claim，會跳過查詢直接開——那時只剩 Amego 的 OrderId 唯一性一道保險。
 *      自動重試額度因此是 4 次而不是 5 次，可以接受。
 *   3. 走跟排程**完全相同**的 issueInvoiceForOrder()（claim → 查詢 → 開立 → 記結果），
 *      只多帶 requireLookup：查不到有沒有開過就不開。
 *
 * 冪等：連按兩次、兩個分頁同時按——第二次在 claim 拿到 locked 或 already_issued，
 * 不會打第二次 Amego。已經開過的單（Amego 那邊有、我們沒記到）會被查詢認回來補登號碼。
 */
export async function reissueInvoiceForOrder(
  orderId: string,
  actorId: string,
): Promise<ReissueOutcome> {
  if (!amegoConfigured()) return { reason: "not_configured" };

  const state = await getInvoiceStateForReissue(orderId);
  if (state === "db_error") return { reason: "db_error" };
  if (!state) return { reason: "order_not_found" };
  const { orderNo } = state;

  if (state.paymentStatus !== "paid") return { reason: "not_paid", orderNo };
  if (!(state.total > 0)) return { reason: "zero_total", orderNo };
  if (state.invoiceStatus === "issued") return { reason: "already_issued", orderNo };
  if (state.invoiceStatus === "voided") return { reason: "voided", orderNo };

  console.warn(
    `[amego] 後台重新開立 order=${orderNo} actor=${actorId} status=${state.invoiceStatus} retry=${state.retryCount}`,
  );

  if (state.invoiceStatus === "failed") {
    const reset = await resetInvoiceRetriesForReissue(orderId);
    if (!reset) return { reason: "db_error" };
  }

  const outcome = await issueInvoiceForOrder(orderId, { requireLookup: true });
  if (outcome.ok) {
    return {
      reason: outcome.adopted ? "adopted" : "issued",
      orderNo,
      invoiceNumber: outcome.invoiceNumber,
    };
  }
  if (outcome.reason === "locked") return { reason: "locked", orderNo };
  if (outcome.reason === "issued_but_not_recorded") return { reason: "issued_unrecorded", orderNo };
  return { reason: "failed", orderNo, message: outcome.reason, permanent: outcome.permanent };
}
