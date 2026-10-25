/**
 * 廠商管理的 server functions（店家這一側）。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 *   staffFnMiddleware()                          日常維護（清單、表單、子表）
 *   staffFnMiddleware() + approve_vendors         審核廠商
 *   staffFnMiddleware() + approve_products        審核廠商送審的商品
 *   staffFnMiddleware() + inv.vendor.pii.read     看完整身分證／統編／匯款帳號
 *   adminFnMiddleware()                           看稽核軌跡、管入口帳號
 *
 * ⚠️ **側欄隱藏不是授權**。擋住直接打 `/_serverFn/…` 的只有 `.middleware([...])`
 *    加上 handler 裡那一次 permissions 檢查。
 * ⚠️ 一個字都沒有動到 adminFnMiddleware 與 requireAdmin() 的定義。
 *
 * ── 這個檔案裡最重要的兩件事 ──────────────────────────────────────────────
 *
 * 1. **readVendorSensitive 那一支是整個站唯一看得到完整號碼的入口**，而它一定
 *    留下 pii_access_log（0019 §4，資料庫在同一個交易裡先寫紀錄再組值）。這一層
 *    負責的是「有沒有權限走進那扇門」。
 *
 * 2. **稽核軌跡要 admin，不是 pii.read。** 看得到別人的查閱紀錄跟看得到廠商資料
 *    是兩種權限。綁在一起的話，每一個查得到身分證的人就同時查得到同事的查閱
 *    習慣 —— 那讓稽核從「保護廠商」變成「監視同事」，而且是免費附贈的。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware, staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import {
  piiAccessLogFilterSchema,
  vendorAttachmentSchema,
  vendorBankAccountSchema,
  vendorContactSchema,
  vendorFilterSchema,
  vendorSchema,
  vendorSensitiveRequestSchema,
  vendorSubmissionApprovalSchema,
} from "@/lib/admin/schemas";

const uuid = z.string().trim().uuid();

/** 需要某個細權限時的統一講法（與 fns/inv-combos.ts#approveComboSet 同一個形狀）。 */
async function requirePermission(
  permissions: readonly string[],
  needed: string,
  label: string,
): Promise<void> {
  if (permissions.includes(needed)) return;
  const { NotAuthorizedError } = await import("@/server/auth");
  throw new NotAuthorizedError(`需要「${label}」權限`);
}

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export const listAdminVendors = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(vendorFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminVendors } = await import("@/server/repos/inv-vendors");
    return await listAdminVendors(data);
  });

export const getAdminVendor = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ vendorId: uuid }))
  .handler(async ({ data }) => {
    const { getAdminVendor, listVendorContacts, listVendorBankAccounts, listVendorAttachments } =
      await import("@/server/repos/inv-vendors");

    const [vendor, contacts, bankAccounts, attachments] = await Promise.all([
      getAdminVendor(data.vendorId),
      listVendorContacts(data.vendorId),
      listVendorBankAccounts(data.vendorId),
      listVendorAttachments(data.vendorId),
    ]);

    return { vendor, contacts, bankAccounts, attachments };
  });

async function loadVendorFormOptions() {
  const { listVendorFormOptions } = await import("@/server/repos/inv-vendors");
  const { listApprovalSettings } = await import("@/server/repos/inv-products");
  const [options, approvalSettings] = await Promise.all([
    listVendorFormOptions(),
    listApprovalSettings(),
  ]);
  return { ...options, approvalSettings };
}

export const listVendorFormOptions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => await loadVendorFormOptions());

// ---------------------------------------------------------------------------
// 敏感欄位 —— 這一支是整個站唯一的那扇門
// ---------------------------------------------------------------------------

/**
 * 看某一家廠商的完整識別碼／匯款帳號。
 *
 * ⚠️ 三件事在這裡同時成立，缺一不可：
 *    1. 要有 `inv.vendor.pii.read`，而且是從 staff_permissions **重讀**出來的
 *       （context.staff.permissions），不是前端送來的。
 *    2. 呼叫成功就一定留下一筆 pii_access_log —— 那是資料庫在同一個交易裡做的，
 *       這一層沒有辦法跳過它。
 *    3. reason 是列舉，而且 `self_service` 在這裡**被擋掉** —— 那個值是廠商入口
 *       那一側專用的，店員用它會讓稽核紀錄看起來像是廠商自己查的。
 */
export const readVendorSensitive = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(vendorSensitiveRequestSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context.staff.permissions, "inv.vendor.pii.read", "查看廠商敏感資料");

    if (data.reason === "self_service") {
      const { NotAuthorizedError } = await import("@/server/auth");
      throw new NotAuthorizedError("「廠商自助入口」不是店員可以選的查閱事由");
    }

    const { readVendorSensitive } = await import("@/server/repos/inv-vendors");
    return await readVendorSensitive({
      actorUserId: context.staff.userId,
      actorEmail: context.staff.email,
      vendorId: data.vendor_id,
      fields: data.fields,
      reason: data.reason,
      accessKind: "staff",
    });
  });

/**
 * 稽核軌跡。
 *
 * ⚠️ adminFnMiddleware，**不是** staffFnMiddleware + pii.read。見檔頭第 2 點。
 */
export const listPiiAccessLog = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(piiAccessLogFilterSchema)
  .handler(async ({ data }) => {
    const { listPiiAccessLog } = await import("@/server/repos/inv-vendors");
    return await listPiiAccessLog(data);
  });

// ---------------------------------------------------------------------------
// 寫
// ---------------------------------------------------------------------------

export const saveVendor = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(vendorSchema)
  .handler(async ({ data, context }) => {
    const { saveVendor } = await import("@/server/repos/inv-vendors");
    const { id, ...payload } = data;
    // ⚠️ 這裡把整個 payload 傳下去是安全的，因為 zod schema 裡**沒有**
    //    approval_status / approved_by / created_by / vendor_code 這幾個 key，
    //    而 inv_save_vendor() 也只逐欄具名取它認得的那些。兩層都不靠自律。
    return await saveVendor({ userId: context.staff.userId, id, payload });
  });

export const approveVendor = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: uuid, approved: z.boolean() }))
  .handler(async ({ data, context }) => {
    await requirePermission(context.staff.permissions, "approve_vendors", "approve_vendors");

    const { approveRecord } = await import("@/server/repos/inv-products");
    // module 是寫死的 'vendors'，不是參數 —— 來源的 useApprovalMutation({ table })
    // 是讓呼叫端指定要更新哪張表（0016 檔頭有完整推導）。
    return await approveRecord({
      userId: context.staff.userId,
      module: "vendors",
      id: data.id,
      approved: data.approved,
    });
  });

export const deleteVendor = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ vendorId: uuid }))
  .handler(async ({ data }) => {
    const { deleteVendor } = await import("@/server/repos/inv-vendors");
    return await deleteVendor(data.vendorId);
  });

export const saveVendorBankAccount = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ vendorId: uuid, account: vendorBankAccountSchema }))
  .handler(async ({ data, context }) => {
    const { saveVendorBankAccount } = await import("@/server/repos/inv-vendors");
    const { id, ...payload } = data.account;
    return await saveVendorBankAccount({
      userId: context.staff.userId,
      vendorId: data.vendorId,
      id,
      payload,
    });
  });

export const saveVendorContact = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ vendorId: uuid, contact: vendorContactSchema }))
  .handler(async ({ data, context }) => {
    const { saveVendorContact } = await import("@/server/repos/inv-vendors");
    const { id, ...payload } = data.contact;
    return await saveVendorContact({
      userId: context.staff.userId,
      vendorId: data.vendorId,
      id,
      payload,
    });
  });

export const saveVendorAttachment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ vendorId: uuid, attachment: vendorAttachmentSchema }))
  .handler(async ({ data, context }) => {
    const { vendorIdFromAttachmentKey } = await import("@/server/storage");
    // 上傳時路徑第一段就是 vendorId，這裡再確認一次它與要掛的廠商一致 —— 擋的是
    // 「拿 A 家的 key 掛到 B 家底下」，那會讓 B 的附件清單長出 A 的合約。
    if (vendorIdFromAttachmentKey(data.attachment.file_path) !== data.vendorId) {
      throw new Error("附件路徑與廠商不符");
    }

    const { saveVendorAttachment } = await import("@/server/repos/inv-vendors");
    return await saveVendorAttachment({
      userId: context.staff.userId,
      vendorId: data.vendorId,
      payload: data.attachment,
    });
  });

/**
 * 刪一筆子項目。附件會連 storage 上的檔案一起刪。
 *
 * ⚠️ 順序是「先刪 DB 再刪檔案」。反過來的話，檔案刪掉但 DB 刪失敗，清單上會留下
 *    一筆點下去 404 的附件（來源系統就是反過來的）。這個順序最壞的結果是留下一個
 *    沒有人指得到的孤兒檔案，那比一筆壞掉的紀錄好處理。
 */
export const deleteVendorChild = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(
    z.object({
      kind: z.enum(["bank_account", "contact", "attachment"]),
      vendorId: uuid,
      id: uuid,
    }),
  )
  .handler(async ({ data }) => {
    const { deleteVendorChild } = await import("@/server/repos/inv-vendors");
    const result = await deleteVendorChild(data);

    if (data.kind === "attachment" && result.file_path) {
      const { deleteVendorAttachment } = await import("@/server/storage");
      await deleteVendorAttachment(result.file_path);
    }
    return { deleted: result.deleted };
  });

/** 給店員回看附件的短期網址。private bucket，所以沒有永久網址這種東西。 */
export const signVendorAttachment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ vendorId: uuid, filePath: z.string().trim().max(500) }))
  .handler(async ({ data }) => {
    const { signedVendorAttachmentUrl, vendorIdFromAttachmentKey } =
      await import("@/server/storage");
    // 授權：這個 key 必須屬於呼叫端指名的廠商。（店員對所有廠商都有權限，所以
    // 這一行擋的是形狀錯誤與跨廠商的 key 混用，不是跨店員的越權。）
    if (vendorIdFromAttachmentKey(data.filePath) !== data.vendorId) {
      throw new Error("附件路徑與廠商不符");
    }
    const url = await signedVendorAttachmentUrl(data.filePath);
    if (!url) throw new Error("附件網址產生失敗");
    return { url };
  });

export const uploadVendorAttachmentFile = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("請選擇檔案");
    const file = data.get("file");
    const vendorId = data.get("vendorId");
    if (!(file instanceof File)) throw new Error("請選擇檔案");
    if (typeof vendorId !== "string" || !/^[0-9a-f-]{36}$/.test(vendorId)) {
      throw new Error("廠商代碼不正確");
    }
    return { file, vendorId };
  })
  .handler(async ({ data }) => {
    const { uploadVendorAttachment } = await import("@/server/storage");
    return await uploadVendorAttachment(data.vendorId, data.file);
  });

// ---------------------------------------------------------------------------
// 廠商送審的商品（店家這一側）
// ---------------------------------------------------------------------------

export const listVendorSubmissions = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ approvalStatus: z.enum(["all", "pending", "approved", "rejected"]) }))
  .handler(async ({ data }) => {
    const { listVendorSubmissions } = await import("@/server/repos/inv-vendors");
    return await listVendorSubmissions(data.approvalStatus);
  });

/**
 * 核准／退回廠商送審的商品，可選同時上架。
 *
 * ⚠️ 需要 approve_products —— 那是商品的審核權，與 approve_vendors（廠商本身）
 *    是兩件事。一個能簽核廠商的人不見得該決定哪本書上架。
 */
export const approveVendorSubmission = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(vendorSubmissionApprovalSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context.staff.permissions, "approve_products", "approve_products");

    const { approveVendorProduct } = await import("@/server/repos/inv-vendors");
    return await approveVendorProduct({
      userId: context.staff.userId,
      id: data.id,
      approved: data.approved,
      listing: data.listing,
    });
  });

// ---------------------------------------------------------------------------
// 入口帳號（店家這一側）—— admin only
// ---------------------------------------------------------------------------
//
// ⚠️ 這裡**不建 auth 帳號**。auth.users 一律在 Supabase dashboard 手動建立，與
//    整個後台同一條規矩（auth.ts 檔頭「there is no public sign-up」）。廠商的
//    密碼從頭到尾不經過這個 codebase。

export const listVendorPortalAccounts = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware, readOnlyFnMiddleware])
  .inputValidator(z.object({ vendorId: uuid }))
  .handler(async ({ data }) => {
    const { listVendorPortalAccounts } = await import("@/server/repos/inv-vendors");
    return await listVendorPortalAccounts(data.vendorId);
  });

export const setVendorPortalAccountActive = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ vendorId: uuid, userId: uuid, isActive: z.boolean() }))
  .handler(async ({ data }) => {
    const { setVendorPortalAccountActive } = await import("@/server/repos/inv-vendors");
    await setVendorPortalAccountActive(data);
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------
// 頁面進場時原本平行打好幾支 fn —— 每一支都各自驗一次身分（重讀 profiles），正式站上每一支
// 還是一趟獨立的 HTTP。這裡改成一支：身分只驗一次，查詢在伺服器上平行跑。
// 權限與原本那幾支**完全一樣**（都是 staffFnMiddleware()，不帶細權限）；原本那幾支保留給
// 頁面上的換頁／篩選／重抓使用。

export const getInventoryVendorsPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(
    z.object({
      filter: vendorFilterSchema,
      approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
    }),
  )
  .handler(async ({ data }) => {
    const { listAdminVendors, listVendorSubmissions } = await import("@/server/repos/inv-vendors");
    const [vendors, options, submissions] = await Promise.all([
      listAdminVendors(data.filter),
      loadVendorFormOptions(),
      listVendorSubmissions(data.approvalStatus),
    ]);
    return { vendors, options, submissions };
  });
