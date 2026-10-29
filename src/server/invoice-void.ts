/**
 * 後台「作廢發票」的接線（業主 2026-10-29）。判斷與流程全部在 src/lib/invoice-void.ts
 * 的 runInvoiceVoid()（純函式，有自檢）；這裡只把真的資料庫與 Amego 接上去。
 *
 * 🔴 Amego 一律經過 src/server/amego.ts 的 voidInvoice() → amegoRequest()，目的地由
 *    amegoTransport() 決定（Railway 固定 IP 中繼）。這裡不另開連線。中繼沒設定就不打：
 *    直連會被 Amego 的 IP 白名單擋下（code 14），而且違反「必須走中繼」。
 * 🔴 呼叫端只有 src/lib/admin/fns/invoices.ts 的 voidInvoiceAdmin（adminFnMiddleware），
 *    actorId 只從 context.admin.userId 來。
 */
import "@tanstack/react-start/server-only";
import {
  amegoConfigured,
  amegoRelayConfigured,
  findInvoiceByOrderId,
  voidInvoice,
} from "@/server/amego";
import { claimInvoiceVoid, finishInvoiceVoid, releaseInvoiceVoid } from "@/server/repos/invoices";
import { describeVoidOutcome, runInvoiceVoid, type VoidOutcome } from "@/lib/invoice-void";

export type VoidInvoiceResponse = {
  outcome: VoidOutcome | { ok: false; kind: "not_configured" };
  tone: "success" | "info" | "error";
  message: string;
};

export async function voidInvoiceForOrder(input: {
  orderId: string;
  invoiceNumber: string;
  reason: string;
  actorId: string;
}): Promise<VoidInvoiceResponse> {
  if (!amegoConfigured() || !amegoRelayConfigured()) {
    console.warn("[invoice-void] Amego 金鑰或固定 IP 中繼未設定，不送出作廢");
    return {
      outcome: { ok: false, kind: "not_configured" },
      tone: "error",
      message: "發票服務尚未設定（光貿金鑰或固定 IP 中繼），沒有送出作廢，請聯絡技術人員",
    };
  }

  const outcome = await runInvoiceVoid(input, {
    claim: claimInvoiceVoid,
    finish: finishInvoiceVoid,
    release: releaseInvoiceVoid,
    callVoid: async ({ invoiceNumber, invoiceDate, reason }) => {
      const r = await voidInvoice({ invoiceNumber, invoiceDate, reason });
      if (r.ok) return { ok: true };
      return r.kind === "business"
        ? { ok: false, kind: "business", code: r.code, msg: r.msg }
        : { ok: false, kind: "transport", code: null, msg: r.msg };
    },
    queryByOrderNo: findInvoiceByOrderId,
    log: (line) => console.warn(`[invoice-void] ${line}`),
  });
  const { tone, text } = describeVoidOutcome(outcome);
  return { outcome, tone, message: text };
}
