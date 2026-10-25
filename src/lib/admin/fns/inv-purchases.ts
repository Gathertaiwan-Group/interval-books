/**
 * 進貨的 server functions —— 店員記錄進貨的唯一入口。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 *   staffFnMiddleware()                     新增、編輯、刪除、匯入（店員日常作業）
 *   staffFnMiddleware() + 細權限檢查         審核（approve_purchases）
 *
 * ⚠️ **側欄隱藏不是授權**。/admin/_shell 的 NAV_GROUPS 與頁面上的 canApprove
 *    旗標只決定畫面長什麼樣。擋住 `curl -X POST /_serverFn/…` 的只有下面每一行
 *    `.middleware([...])` —— requireStaff() 每一次都重讀 profiles 與
 *    staff_permissions，所以把權限收回去，下一個請求就被擋。
 *
 * ⚠️ 一個字都沒有動到 adminFnMiddleware 與 requireAdmin()。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import {
  approveRecordSchema,
  importPurchasesSchema,
  invPurchaseSchema,
  purchaseBatchUpdateSchema,
  purchaseFilterSchema,
} from "@/lib/admin/schemas";

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export const listAdminPurchases = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(purchaseFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminPurchases } = await import("@/server/repos/inv-purchases");
    return await listAdminPurchases(data);
  });

export const getPurchaseSummary = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(purchaseFilterSchema)
  .handler(async ({ data }) => {
    const { getPurchaseSummary } = await import("@/server/repos/inv-purchases");
    return await getPurchaseSummary(data);
  });

/** 分類／供應商／審核設定 —— 表單開一次要的三份參考資料。 */
export const listPurchaseFormOptions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => {
    const { listPurchaseFormOptions } = await import("@/server/repos/inv-purchases");
    return await listPurchaseFormOptions();
  });

/**
 * 整份商品清單。只給進貨表單的商品選擇器與 Excel 匯入的比對用。
 *
 * 清單頁**不要**呼叫這一支 —— 它會把上千列搬到瀏覽器。清單的篩選與分頁在
 * listAdminPurchases 那邊已經下推到資料庫了。
 */
export const listProductPickerRows = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => {
    const { listProductPickerRows } = await import("@/server/repos/inv-purchases");
    return await listProductPickerRows();
  });

export const getAdminPurchase = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminPurchase } = await import("@/server/repos/inv-purchases");
    return await getAdminPurchase(data.id);
  });

// ---------------------------------------------------------------------------
// 寫
// ---------------------------------------------------------------------------

export const savePurchase = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(invPurchaseSchema)
  .handler(async ({ data, context }) => {
    const { savePurchase } = await import("@/server/repos/inv-purchases");
    const { id, product_id, ...rest } = data;

    return await savePurchase({
      userId: context.staff.userId,
      id: id ?? null,
      // 編輯時不送 product_id：換商品等於整批貨連同 FIFO 批次一起搬家。
      // inv_save_purchase() 在 UPDATE 分支根本不讀這個 key，這裡不送只是讓
      // payload 誠實一點。
      payload: id ? rest : { ...rest, product_id },
    });
  });

export const deletePurchase = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { deletePurchase } = await import("@/server/repos/inv-purchases");
    // 「已經賣掉 N 件的批次不能刪」的判斷在 trigger 裡，不在這裡先查一次再決定
    // —— 先查後刪中間有窗口，而且那個判斷會變成兩份。
    return await deletePurchase(data.id);
  });

export const batchUpdatePurchases = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(purchaseBatchUpdateSchema)
  .handler(async ({ data, context }) => {
    const { batchUpdatePurchases } = await import("@/server/repos/inv-purchases");
    return await batchUpdatePurchases({
      userId: context.staff.userId,
      ids: data.ids,
      patch: data.patch,
    });
  });

/**
 * Excel 匯入。
 *
 * 解析留在瀏覽器（xlsx 那包有 Node 專屬分支，SSR 端靜態 import 會炸），送進來的
 * 是已經對好欄位、驗過型別的陣列。**寫入一律走這裡** —— 來源是在瀏覽器跑一個
 * for 迴圈逐筆 insert，建了商品但進貨失敗就留下孤兒商品，沒有人會發現。
 */
export const importPurchases = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(importPurchasesSchema)
  .handler(async ({ data, context }) => {
    const { importPurchases } = await import("@/server/repos/inv-purchases");
    return await importPurchases({
      userId: context.staff.userId,
      rows: data.rows,
      options: data.options,
    });
  });

/**
 * 審核／退回。
 *
 * ── 為什麼權限查兩次而不是一次 ────────────────────────────────────────────
 * middleware 只能在建立時綁死一種權限，但這一支要處理多個 module。所以
 * middleware 先擋掉「連 staff 都不是」的人，再依 module 查對應的 approve_*。
 * 兩次都是 server 端，兩次都重讀 staff_permissions。
 *
 * ⚠️ module 只是一個代號，表名在 inv_approve_record() 的 CASE 裡寫死。zod enum
 *    擋一次、PL/pgSQL 的 CASE 再擋一次，兩層都不認得的字串連 UPDATE 都不會發生。
 */
export const approveRecord = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(approveRecordSchema)
  .handler(async ({ data, context }) => {
    const permission = `approve_${data.module}` as const;

    if (!context.staff.permissions.includes(permission)) {
      const { NotAuthorizedError } = await import("@/server/auth");
      throw new NotAuthorizedError(`需要「${permission}」權限`);
    }

    const { approveRecord } = await import("@/server/repos/inv-purchases");
    return await approveRecord({
      userId: context.staff.userId,
      module: data.module,
      id: data.id,
      approved: data.approved,
    });
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------
// 頁面進場時原本平行打好幾支 fn —— 每一支都各自驗一次身分（重讀 profiles），正式站上每一支
// 還是一趟獨立的 HTTP。這裡改成一支：身分只驗一次，查詢在伺服器上平行跑。
// 權限與原本那幾支**完全一樣**（都是 staffFnMiddleware()，不帶細權限）；原本那幾支保留給
// 頁面上的換頁／篩選／重抓使用。

export const getInventoryPurchasesPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ filter: purchaseFilterSchema }))
  .handler(async ({ data }) => {
    const repo = await import("@/server/repos/inv-purchases");
    const [page, summary, options, products] = await Promise.all([
      repo.listAdminPurchases(data.filter),
      repo.getPurchaseSummary(data.filter),
      repo.listPurchaseFormOptions(),
      repo.listProductPickerRows(),
    ]);
    return { page, summary, options, products };
  });
