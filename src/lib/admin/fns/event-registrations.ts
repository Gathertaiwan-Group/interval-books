/**
 * event_registrations server functions —— 名單的四個入口。
 *
 *   listSessionRoster           整場名單（明文）            ✗ 不寫 log（業主 2026-10-26）
 *   countRegistrationsBySession 每場幾人（給列表頁）        ✗ 不寫 log
 *   exportSessionRoster         整場明文，回一份 CSV 字串   ✗ 不寫 log（業主 2026-10-26）
 *   deleteAdminRegistration     移除單筆報名、名額自動還    0035，見下方獨立說明
 *
 * 業主 2026-10-26：「報名名單每打開一次就記一筆查看紀錄 >> 這功能移除」。名單頁與 CSV
 * 匯出都改成 service role 直接讀，不再呼叫 pii_log_access()／export_event_roster()；
 * 權限（staffFnMiddleware＋event.roster.read）一個字都沒放寬。單筆揭露
 * （revealRegistrationContact）早就沒有畫面在用，一併移除。資料庫裡的那兩支 SQL 函式
 * 還在、只是沒人呼叫。廠商身分證／匯款帳戶的查閱紀錄（fns/inv-vendors.ts）照舊。
 *
 * ── 為什麼 deleteAdminRegistration 掛 adminFnMiddleware，不是 staffFnMiddleware ──
 * 上面三支都下放到 staffFnMiddleware() + event.roster.read（見下一段），移除是
 * 唯一的例外。理由與 src/lib/admin/fns/orders.ts 整份檔案一致：這是一個會永久
 * 改變資料的動作（刪這一列、扣那個場次的名額），與「查看」不是同一個授權層級。
 * 被授權看簽到表的工讀生看得到「移除」這顆按鈕出現在畫面上，但按下去會在
 * requireAdmin() 那一關被擋——側欄與按鈕的顯示邏輯只是不要給他一個一按就跳錯誤頁
 * 的連結，見 src/routes/admin/_shell.tsx 檔頭。
 *
 * ── 為什麼三支都不是 adminFnMiddleware ───────────────────────────────────
 * Phase 1 四支之中的兩支掛的是 adminFnMiddleware，那是「在 event.roster.read 這個
 * 權限存在之前，admin only 是比較安全的那一邊」的暫時處置，而且當時就寫明了。
 * 0021 §4 把那個權限加進 staff_permissions 的 CHECK 了，所以現在改成
 * staffFnMiddleware() + requirePermission("event.roster.read")，與 0019 的
 * readVendorSensitive 同一個形狀。
 *
 * 這不是放寬：admin 一律通過細權限檢查（requireStaff 對 admin 不查表），所以
 * admin 的行為一個字都沒變；改變的是「一個負責活動現場的工讀生可以被授權看簽到
 * 表，而不必連帶拿到整個 CMS」。
 *
 * ⚠️ 權限是從 context.staff.permissions 重讀出來的（每一次請求都重讀 profiles 與
 *    staff_permissions），不看前端送什麼。畫面把按鈕藏起來不是授權。
 *
 * ── 為什麼 CSV 是 server fn 而不是 HTTP 路由 ─────────────────────────────
 * 快樂手的 CSV 是 `app/admin/sessions/[id]/roster.csv/route.ts`，而它踩過一個坑：
 * 權限不足時 Next 的中介層會 **redirect 到登入頁**，瀏覽器照樣把回應存下來 ——
 * 於是店員拿到一個叫 roster.csv、內容是登入頁 HTML 的檔案。他們的修法是「權限
 * 不足回 403 JSON 不 redirect」。
 *
 * 改成 server fn 讓那件事**在結構上不可能發生**：這一支的回傳型別是
 * `{ filename, csv }`，沒有任何路徑可以讓它變成一份 HTML。授權失敗就是一個
 * throw，前端接到的是 toast，不是一個檔案。
 *
 * 附帶避開一個這個 codebase 真實存在的坑：`readAdminSession()` 依賴 TanStack 的
 * request context，而 `src/server.ts` 攔下的請求還沒進到 `createStartHandler`，
 * 那個 context 不一定成立 —— 現有三條自訂路徑（invoice / tasks / vendor webhook）
 * 全都用共享密鑰而不是 cookie，正是繞過了這件事。一條需要 cookie 授權的 CSV 路由
 * 會是第一個撞上它的。
 *
 * 代價是整份名單進記憶體。書店一場 20–60 人，可以忽略。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware, staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";

const uuid = z.string().trim().uuid();

/** 需要 event.roster.read 時的統一講法（與 fns/inv-vendors.ts#requirePermission 同形）。 */
async function requireRosterRead(permissions: readonly string[]): Promise<void> {
  if (permissions.includes("event.roster.read")) return;
  const { NotAuthorizedError } = await import("@/server/auth");
  throw new NotAuthorizedError("需要「查看活動報名名單」權限");
}

// ---------------------------------------------------------------------------
// 名單（明文，業主 2026-10-25）—— 只讀，不寫 log（業主 2026-10-26）
// ---------------------------------------------------------------------------

// GET：只讀，可以放進 route loader（30 秒快取、滑過預載）。POST 會被 src/start.ts 當成
// 寫入、每次載入都把後台快取清掉。
export const listSessionRoster = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ sessionId: uuid }))
  .handler(async ({ data, context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listSessionRoster } = await import("@/server/repos/event-registrations");
    return await listSessionRoster(data.sessionId);
  });

export const countRegistrationsBySession = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    return await countRegistrationsBySession();
  });

/**
 * 整場簽到表，回一份 CSV **字串**（不是檔案、不是 URL）。前端拿它包成 Blob 下載。
 *
 * 只含已付款的列 —— 那個條件在 0021 §3 的 view 裡（on_roster），這裡與畫面、
 * 與 Phase 3 的提醒信共用同一份定義。不寫 pii_access_log（業主 2026-10-26）。
 *
 * 仍是 POST（按鈕觸發的下載，不給瀏覽器／代理重送），但只讀，掛 readOnlyFnMiddleware
 * 讓它不清後台快取。
 */
export const exportSessionRoster = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ sessionId: uuid }))
  .handler(async ({ data, context }) => {
    await requireRosterRead(context.staff.permissions);

    const { loadRosterExport } = await import("@/server/repos/event-registrations");
    const result = await loadRosterExport(data.sessionId);

    const { toCsv } = await import("@/lib/csv");
    const { ROSTER_CSV_COLUMNS, rosterFilename } = await import("@/lib/admin/roster-csv");

    return {
      filename: rosterFilename(result.session_title?.zh ?? "", result.starts_at),
      csv: toCsv(result.rows, ROSTER_CSV_COLUMNS),
      count: result.rows.length,
    };
  });

// ---------------------------------------------------------------------------
// 移除 —— admin only（0035）
// ---------------------------------------------------------------------------

/**
 * 移除單筆報名、名額自動還回去（呼叫 public.admin_delete_registration()）。
 *
 * 已付款的報名也允許刪（user 決定）。這支不做「是不是已付款」的判斷、也不多回傳
 * 一個欄位讓前端事後才知道——名單頁在彈出確認對話框「之前」就已經從
 * listSessionRoster() 的結果知道這一列的 payment_status／on_roster，警告文案在
 * 那裡顯示。
 */
export const deleteAdminRegistration = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ registrationId: uuid }))
  .handler(async ({ data, context }) => {
    const { deleteAdminRegistration } = await import("@/server/repos/event-registrations-admin");
    return await deleteAdminRegistration({
      registrationId: data.registrationId,
      actorId: context.admin.userId,
    });
  });
