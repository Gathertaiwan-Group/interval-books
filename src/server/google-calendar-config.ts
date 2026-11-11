/**
 * Google 日曆同步的設定（環境變數）—— 缺任何一項，整個功能安全停用：不碰資料庫、不打 Google，
 * 後台顯示「尚未設定」與缺哪幾個變數。
 *
 * ⚠️ 只 import 同目錄的 google-calendar-crypto.ts（它只 import node:crypto），自檢直接載入測。
 *
 *   GOOGLE_OAUTH_CLIENT_ID              Google Cloud Console 建的 OAuth client（Web application）
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_CALENDAR_TOKEN_KEY           refresh token 的 AES-256-GCM 金鑰（32 bytes，base64）
 *                                       產生：openssl rand -base64 32
 *   GOOGLE_CALENDAR_TOKEN_KEY_PREVIOUS  （選填）輪替金鑰時的舊鑰，見 google-calendar-crypto.ts
 *   GOOGLE_OAUTH_REDIRECT_URI           （選填）預設 https://www.intervalbooks.tw/admin/google-calendar/callback
 *   GOOGLE_CALENDAR_EXPECTED_ACCOUNT    （選填）同意畫面預先選好的帳號（login_hint），連結後
 *                                       帳號不同時後台會提示
 */
import { parseTokenKey } from "./google-calendar-crypto.ts";

export const GOOGLE_CALENDAR_CALLBACK_PATH = "/admin/google-calendar/callback";
export const DEFAULT_REDIRECT_URI = `https://www.intervalbooks.tw${GOOGLE_CALENDAR_CALLBACK_PATH}`;

/**
 * 權限範圍：只要兩個。
 *   calendar.events                 新增／修改／刪除事件（不能刪日曆、不能改分享設定）
 *   calendar.calendarlist.readonly  列出業主有哪些日曆，讓後台選要寫進哪一個
 * 不要 openid／email：連結的是哪個帳號，從 primary 日曆的 id（就是 Gmail 地址）就看得到。
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
export const REQUIRED_SCOPE = GOOGLE_CALENDAR_SCOPES[0];

export type GoogleCalendarConfig =
  | { enabled: false; missing: string[]; invalid: string[] }
  | {
      enabled: true;
      clientId: string;
      clientSecret: string;
      /** 第一把是現行金鑰，第二把（若有）是輪替中的舊鑰。 */
      keys: Buffer[];
      redirectUri: string;
      expectedAccount: string | null;
    };

export function readGoogleCalendarConfig(
  env: Record<string, string | undefined>,
): GoogleCalendarConfig {
  const missing: string[] = [];
  const invalid: string[] = [];
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
  if (!clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  const rawKey = env.GOOGLE_CALENDAR_TOKEN_KEY?.trim() ?? "";
  const key = parseTokenKey(rawKey);
  if (!rawKey) missing.push("GOOGLE_CALENDAR_TOKEN_KEY");
  else if (!key) invalid.push("GOOGLE_CALENDAR_TOKEN_KEY（必須是 32 bytes 的 base64）");
  const rawPrev = env.GOOGLE_CALENDAR_TOKEN_KEY_PREVIOUS?.trim() ?? "";
  const prev = parseTokenKey(rawPrev);
  if (rawPrev && !prev)
    invalid.push("GOOGLE_CALENDAR_TOKEN_KEY_PREVIOUS（必須是 32 bytes 的 base64）");
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
  if (!/^https:\/\/[^/]+\//.test(redirectUri))
    invalid.push("GOOGLE_OAUTH_REDIRECT_URI（必須是 https）");

  if (missing.length || invalid.length || !key) return { enabled: false, missing, invalid };
  return {
    enabled: true,
    clientId,
    clientSecret,
    keys: prev ? [key, prev] : [key],
    redirectUri,
    expectedAccount: env.GOOGLE_CALENDAR_EXPECTED_ACCOUNT?.trim().toLowerCase() || null,
  };
}
