/**
 * /oauth/authorize 同意頁的伺服器端（由 src/lib/oauth-fns.ts 的 server fn 呼叫）。
 *
 * 為什麼在 server fn 裡而不是 src/server.ts：這一步要讀後台的 session cookie
 * （readAdminSession 靠 TanStack Start 的請求 context），而 server.ts 的攔截路徑在那個
 * context 之外。
 *
 * 兩個閘門，兩次都檢查：
 *   prepare —— 畫面要顯示什麼（登入／拒絕門市人員／錯誤／同意畫面）。
 *   decide  —— 使用者按下允許／拒絕。**重新**驗一次全部的參數、重新查一次角色、驗 CSRF
 *              token（綁這位 admin＋這一組參數＋15 分鐘），才簽出授權碼。
 *
 * 🔴 只有 role='admin' 可以授權。門市人員（staff）與待開通（pending）看到的是婉拒說明。
 * 🔴 用 getBackOfficeUserOrNull()，**不是** requireAdmin()：後者對非 admin 會銷毀 cookie，
 *    門市人員點到這個連結會被順手登出。
 */
import "@tanstack/react-start/server-only";
import { getRequest } from "@tanstack/react-start/server";
import {
  approvalRedirect,
  checkAuthorizeParams,
  clientHash,
  consentToken,
  denialRedirect,
  mintCode,
  oauthBaseUrl,
  oauthEnabled,
  redirectDisplay,
  verifyConsentToken,
} from "./oauth-core";

export type ConsentView =
  | { kind: "disabled" }
  | { kind: "login"; loginHref: string }
  | { kind: "error"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "refused"; email: string; role: string; loginHref: string }
  | {
      kind: "consent";
      email: string;
      clientName: string;
      redirectHost: string;
      loopback: boolean;
      csrf: string;
    };

function loginHrefFor(query: string): string {
  const back = `/oauth/authorize${query ? `?${query}` : ""}`;
  return `/admin/login?redirect=${encodeURIComponent(back)}`;
}

function stripQuestion(q: string): string {
  return q.startsWith("?") ? q.slice(1) : q;
}

function baseUrl(): string {
  try {
    return oauthBaseUrl(getRequest().url);
  } catch {
    return oauthBaseUrl("");
  }
}

export async function prepareAuthorize(rawQuery: string): Promise<ConsentView> {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) return { kind: "disabled" };
  const query = stripQuestion(rawQuery);
  const base = baseUrl();

  const check = checkAuthorizeParams(query, secret, base);
  if (!check.ok && check.fatal) return { kind: "error", message: check.message };
  if (!check.ok) return { kind: "redirect", url: check.redirectUrl };

  const { getBackOfficeUserOrNull } = await import("@/server/auth");
  const user = await getBackOfficeUserOrNull();
  if (!user) return { kind: "login", loginHref: loginHrefFor(query) };
  if (user.role !== "admin") {
    return { kind: "refused", email: user.email, role: user.role, loginHref: loginHrefFor(query) };
  }

  const shown = redirectDisplay(check.req.redirectUri);
  return {
    kind: "consent",
    email: user.email,
    clientName: check.req.client.client_name,
    redirectHost: shown.host,
    loopback: shown.loopback,
    csrf: consentToken(user.userId, query, secret),
  };
}

export async function decideAuthorize(
  rawQuery: string,
  csrf: string,
  allow: boolean,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) return { ok: false, message: "這個功能目前沒有開啟。" };
  const query = stripQuestion(rawQuery);
  const base = baseUrl();

  const check = checkAuthorizeParams(query, secret, base);
  if (!check.ok) {
    return {
      ok: false,
      message: check.fatal ? check.message : "授權參數不正確，請回到 Claude 重新連線。",
    };
  }

  const { getBackOfficeUserOrNull } = await import("@/server/auth");
  const user = await getBackOfficeUserOrNull();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "只有管理員可以授權。請以管理員帳號登入後再試一次。" };
  }
  if (!verifyConsentToken(csrf, user.userId, query, secret)) {
    return { ok: false, message: "這個授權畫面已經過期或不是由你開啟的，請重新整理頁面再試一次。" };
  }

  if (!allow) {
    console.info(`[mcp-oauth] consent denied by=${user.userId}`);
    return { ok: true, url: denialRedirect(check.req, base) };
  }
  const code = mintCode(check.req, user.userId, secret);
  console.info(
    `[mcp-oauth] consent granted by=${user.userId} client=${JSON.stringify(check.req.client.client_name)} cid=${clientHash(check.req.client.client_id)} redirect_host=${redirectDisplay(check.req.redirectUri).host}`,
  );
  return { ok: true, url: approvalRedirect(check.req, code, base) };
}
