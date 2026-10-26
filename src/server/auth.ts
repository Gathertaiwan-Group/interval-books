/**
 * Back-office authentication.
 *
 * Password verification is delegated to Supabase Auth (so we never store or
 * compare password hashes ourselves), but authorization is ours: a valid
 * Supabase account proves identity, not access.
 *
 * ── 兩個門，不是一個 ───────────────────────────────────────────────────────
 * requireAdmin() —— role 必須是 'admin'。守著既有的 15 支後台函式，行為與
 *                   0009 之前一模一樣，一個字都沒有放寬。
 * requireStaff() —— role 是 'staff' 或 'admin'。門市 POS、銷售紀錄、賣超告警
 *                   走這一支；admin 一律通過（對應來源系統 has_permission()
 *                   裡的 `IF (isAdmin) RETURN true`）。
 *
 * 0010 把 profiles.role 的值域放寬成 customer/pending/staff/vendor/admin，
 * 所以「能不能登入」與「能做什麼」從這一版起是兩個問題：
 *   admin / staff → 發 cookie，進得去（能看到什麼由 role 決定）
 *   pending       → 發 cookie，但只看得到「等待管理員開通」那一頁
 *   customer / vendor / 沒有 profiles 列 → 連 cookie 都不發
 *
 * Accounts are created by hand in the Supabase dashboard — there is no public
 * sign-up, and nothing here creates users.
 */
import "@tanstack/react-start/server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";
import { supabaseAdmin } from "./supabase-admin";
import {
  destroyAdminSession,
  readAdminSession,
  writeAdminSession,
  type AdminSessionData,
} from "./session";

/** Thrown when a caller is not a signed-in admin. Callers map this to a 401. */
export class NotAuthorizedError extends Error {
  constructor(message = "需要管理員權限") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/**
 * 身分是對的，但還沒有人放行。
 *
 * 刻意與 NotAuthorizedError 分開：pending 不是「你不該在這裡」，是「等一下」。
 * 前者該被踢回登入頁，後者該看到一頁說明 —— 把兩者混成同一個 401，內部同事
 * 只會不斷重試登入，然後來問為什麼帳號壞了。來源系統的 PendingApproval.tsx
 * 就是在講這件事，這裡把那個語意搬過來。
 */
export class PendingApprovalError extends Error {
  constructor(message = "帳號尚未開通，請等待管理員放行") {
    super(message);
    this.name = "PendingApprovalError";
  }
}

/** 後台認得的角色。vendor 是 0010 為 Phase 2 保留的，目前不給進。 */
export type BackOfficeRole = "admin" | "staff" | "pending";

/**
 * 0010 的七種 approve_*，加上 0019 §3.7 的 inv.vendor.pii.read 與 0021 §4 的
 * event.roster.read。與 staff_permissions 的 CHECK 逐字對齊 —— **那條 CHECK 才是
 * 真正的值域**，這裡是鏡射。
 *
 * ⚠️ 三個維度，不是一個清單：
 *
 *      approve_*            能不能簽核（七種）
 *      inv.vendor.pii.read  能不能看廠商的完整識別碼／匯款帳號
 *      event.roster.read    能不能看活動報名名單
 *
 *    後兩種都是「能不能看」，但看的是不同人的個資：廠商是合作對象，參加者是客人。
 *    一個負責活動現場的工讀生需要簽到表，沒有理由看到廠商的身分證字號；一個管
 *    收貨的店員兩個都不需要。名字用點分格式就是要讓它們在清單裡一眼看得出不同類。
 */
export const STAFF_PERMISSIONS = [
  "approve_products",
  "approve_purchases",
  "approve_price_changes",
  "approve_vendors",
  "approve_combo_sets",
  "approve_stock_adjustments",
  "approve_inventory_adjustments",
  "inv.vendor.pii.read",
  "event.roster.read",
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export type BackOfficeUser = {
  userId: string;
  email: string;
  role: BackOfficeRole;
  /** admin 恆為完整九種；staff 是 staff_permissions 裡實際有的列。 */
  permissions: StaffPermission[];
};

/**
 * Anon-key client used purely to verify a password. The service role key cannot
 * do this — it bypasses auth rather than performing it. persistSession is off
 * because this client is per-call and must not touch any shared storage.
 */
function authClient() {
  return createClient(supabaseUrl(), import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Looks up the profiles row. Returns null unless the role is one the back
 * office recognises. `null` here always means "no back-office identity" —
 * customer, vendor, or no row at all.
 */
async function loadBackOfficeProfile(userId: string) {
  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("id, email, role")
    .eq("id", userId)
    .maybeSingle();

  // Fail closed: a lookup error must never be read as "probably fine".
  if (error) throw new Error(`無法讀取管理員資料：${error.message}`);
  if (!data) return null;
  if (data.role !== "admin" && data.role !== "staff" && data.role !== "pending") return null;
  return { ...data, role: data.role as BackOfficeRole };
}

/** Looks up the profiles row. Returns null when absent or not an admin. */
async function loadAdminProfile(userId: string) {
  const profile = await loadBackOfficeProfile(userId);
  if (!profile || profile.role !== "admin") return null;
  return profile;
}

/**
 * 這個人實際有哪幾種權限。
 *
 * admin 不查表、一律視為全有 —— 來源系統的 inv.has_permission() 第一句就是
 * `IF is_admin() THEN RETURN true`，這裡照抄那個語意。管理員身上沒有
 * staff_permissions 列是正常的，不是缺資料。
 *
 * ⚠️ 0019 的 inv.vendor.pii.read 與 0021 的 event.roster.read 也適用這一條。這家店
 *    的 admin 就是老闆，也就是那批個資的持有人，讓他先授權給自己是儀式而不是控制。
 *    真正的控制是 public.pii_access_log —— admin 讀了一樣留紀錄，而且他刪不掉那筆
 *    紀錄（0019 §1.3 的 trigger 連 table owner 都擋）。
 */
async function loadStaffPermissions(userId: string, role: BackOfficeRole) {
  if (role === "admin") return [...STAFF_PERMISSIONS];
  if (role !== "staff") return [];

  const { data, error } = await supabaseAdmin()
    .from("staff_permissions")
    .select("permission")
    .eq("user_id", userId);

  if (error) throw new Error(`無法讀取員工權限：${error.message}`);
  return (data ?? []).map((row) => row.permission as StaffPermission);
}

/**
 * Verifies credentials and, if the account has any back-office identity at
 * all, issues the session cookie. The error message is deliberately identical
 * for "wrong password" and "not staff" so it cannot be used to enumerate which
 * accounts exist.
 *
 * ⚠️ pending 也會拿到 cookie。那不是漏洞 —— 沒有 cookie 就沒有辦法讓他看到
 *    「等待開通」那一頁，而每一支 server fn 都會再擋一次（見 requireStaff）。
 */
export async function signInAdmin(
  email: string,
  password: string,
): Promise<AdminSessionData & { role: BackOfficeRole }> {
  const { data, error } = await authClient().auth.signInWithPassword({ email, password });

  if (error || !data.user) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const profile = await loadBackOfficeProfile(data.user.id);
  if (!profile) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const session: AdminSessionData = { userId: data.user.id, email: data.user.email ?? email };
  await writeAdminSession(session);
  // role 一起回傳，讓登入頁知道要把人送去哪裡。店員被送去 /admin（儀表板）會撞上
  // adminFnMiddleware，看到一頁「需要管理員權限」—— 那是對的行為，但不該是他
  // 每天上班第一眼看到的東西。
  return { ...session, role: profile.role };
}

export async function signOutAdmin(): Promise<void> {
  await destroyAdminSession();
}

/**
 * The authorization boundary. Every admin server function must run this before
 * touching the service role client — route guards only hide UI and cannot stop
 * a direct POST to /_serverFn/…
 *
 * Re-reads profiles on every call so revoking `role` takes effect on the next
 * request rather than whenever the cookie happens to expire.
 */
export async function requireAdmin() {
  const session = await readAdminSession();
  if (!session) throw new NotAuthorizedError();

  const profile = await loadAdminProfile(session.userId);
  if (!profile) {
    // Cookie is cryptographically valid but access was revoked — drop it so the
    // browser stops presenting it.
    await destroyAdminSession();
    throw new NotAuthorizedError();
  }

  return { userId: profile.id, email: profile.email ?? session.email };
}

/**
 * MCP OAuth（src/server/mcp/oauth*.ts、http.ts）用：這個 user id **現在**還是不是 admin。
 *
 * 沒有 cookie 可讀 —— token 裡只有 user id —— 所以直接查 profiles。與 requireAdmin() 同一條
 * 規矩：每次都重查，role 被改掉的下一個請求就失效。查詢出錯一律丟例外（fail closed），
 * 呼叫端不可以把錯誤當成「大概是 admin」。
 */
export async function isActiveAdmin(
  userId: string,
): Promise<{ userId: string; email: string } | null> {
  const profile = await loadAdminProfile(userId);
  if (!profile) return null;
  return { userId: profile.id, email: profile.email ?? "" };
}

/** Non-throwing variant for UI concerns (nav state, redirect decisions). */
export async function getAdminOrNull() {
  try {
    return await requireAdmin();
  } catch {
    return null;
  }
}

/**
 * 門市那一側的授權邊界。POS、銷售紀錄、賣超告警的每一支 server fn 都要跑這個。
 *
 * 與 requireAdmin() 一樣**每次都重讀 profiles** —— 那個 kill-switch 不是巧合：
 * 把某個人從 staff 改回 customer，下一個請求就該被擋，而不是等 8 小時後 cookie
 * 自己過期。cookie 是身分，profiles 是權限，權限每次都要重問。
 *
 * @param permission 帶了就再查一次 staff_permissions。admin 一律跳過這一查。
 */
export async function requireStaff(permission?: StaffPermission): Promise<BackOfficeUser> {
  const session = await readAdminSession();
  if (!session) throw new NotAuthorizedError();

  const profile = await loadBackOfficeProfile(session.userId);
  if (!profile) {
    // 與 requireAdmin() 同一條規矩：cookie 在密碼學上有效，但權限已經被撤掉，
    // 就把它丟掉，別讓瀏覽器繼續拿它來敲門。
    await destroyAdminSession();
    throw new NotAuthorizedError();
  }

  // pending 的 cookie **不銷毀**：他的身分是對的，只是還沒被放行。銷毀等於
  // 每次進來都被登出，然後他會一直重試登入。
  if (profile.role === "pending") throw new PendingApprovalError();

  const permissions = await loadStaffPermissions(profile.id, profile.role);

  if (permission && !permissions.includes(permission)) {
    throw new NotAuthorizedError(`需要「${permission}」權限`);
  }

  return {
    userId: profile.id,
    email: profile.email ?? session.email,
    role: profile.role,
    permissions,
  };
}

/**
 * Non-throwing variant for UI concerns —— /admin/_shell 的 beforeLoad 用這支。
 *
 * ⚠️ 不能用 getAdminOrNull() 代替：那支內部會呼叫 requireAdmin()，而
 *    requireAdmin() 對非 admin **會銷毀 cookie**。店員一登入就會被登出。
 *
 * pending 會回一個 role='pending' 的物件而不是 null，這樣 shell 才能把他導向
 * 待審核頁，而不是踢回登入頁。
 */
export async function getBackOfficeUserOrNull(): Promise<BackOfficeUser | null> {
  const session = await readAdminSession();
  if (!session) return null;

  try {
    const profile = await loadBackOfficeProfile(session.userId);
    if (!profile) {
      await destroyAdminSession();
      return null;
    }
    return {
      userId: profile.id,
      email: profile.email ?? session.email,
      role: profile.role,
      permissions: await loadStaffPermissions(profile.id, profile.role),
    };
  } catch {
    return null;
  }
}
