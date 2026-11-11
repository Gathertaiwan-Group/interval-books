/**
 * 後台「Google 日曆同步」（/admin/google-calendar）的 server functions。只有 admin
 * （adminFnMiddleware，見 src/lib/admin/middleware.ts）。
 *
 * OAuth 連結流程：
 *   1. startGoogleCalendarConnect：產生 state + PKCE verifier，簽章後放進 httpOnly cookie
 *      （綁定發起的管理員、10 分鐘到期），回傳 Google 同意畫面網址。
 *   2. Google 導回 /admin/google-calendar/callback?code&state（後台頁面，_shell 的守門照常）。
 *   3. completeGoogleCalendarConnect：再驗一次 admin session（middleware）、驗 cookie 簽章、
 *      state 常數時間比對、管理員必須是同一位 → 用 code + verifier 換 token → 加密存檔。
 *      cookie 用過即刪（code 只能用一次，state 也是）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

const STATE_COOKIE = "ib_gcal_oauth";
const STATE_TTL_SECONDS = 600;

export const getGoogleCalendarStatus = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { getGoogleCalendarStatus } = await import("@/server/google-calendar");
    return await getGoogleCalendarStatus();
  });

export const startGoogleCalendarConnect = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .handler(async ({ context }) => {
    const { googleCalendarConfig } = await import("@/server/google-calendar");
    const { GOOGLE_CALENDAR_SCOPES } = await import("@/server/google-calendar-config");
    const { randomToken, pkceChallenge, signState } =
      await import("@/server/google-calendar-crypto");
    const { buildAuthorizeUrl } = await import("@/server/google-calendar-api");
    const { setCookie, getRequestHost } = await import("@tanstack/react-start/server");
    const cfg = googleCalendarConfig();
    if (!cfg.enabled) throw new Error("Google 日曆同步尚未設定（缺環境變數）。");
    // state cookie 只屬於發起的網域；Google 會導回 redirectUri 的網域。兩者不同（例如在
    // intervalbooks.tw 或 *.vercel.app 的後台按）callback 一定讀不到 cookie，先擋下來講清楚。
    const redirectHost = new URL(cfg.redirectUri).host;
    const host = getRequestHost({ xForwardedHost: true });
    if (host && host !== redirectHost && process.env.NODE_ENV === "production") {
      throw new Error(`請到 https://${redirectHost}/admin/google-calendar 再按一次「連結」。`);
    }

    const state = randomToken();
    const verifier = randomToken(48);
    setCookie(
      STATE_COOKIE,
      signState(
        {
          s: state,
          v: verifier,
          u: context.admin.userId,
          exp: Date.now() + STATE_TTL_SECONDS * 1000,
        },
        cfg.keys[0],
      ),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: STATE_TTL_SECONDS,
      },
    );
    return {
      url: buildAuthorizeUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        scopes: GOOGLE_CALENDAR_SCOPES,
        state,
        codeChallenge: pkceChallenge(verifier),
        loginHint: cfg.expectedAccount,
      }),
    };
  });

export const completeGoogleCalendarConnect = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      code: z.string().trim().min(1).max(2048),
      state: z.string().trim().min(1).max(256),
    }),
  )
  .handler(async ({ data, context }) => {
    const { googleCalendarConfig, saveGoogleCalendarConnection } =
      await import("@/server/google-calendar");
    const { verifyState, safeEqual } = await import("@/server/google-calendar-crypto");
    const { exchangeCode } = await import("@/server/google-calendar-api");
    const { getCookie, deleteCookie } = await import("@tanstack/react-start/server");
    const cfg = googleCalendarConfig();
    if (!cfg.enabled) throw new Error("Google 日曆同步尚未設定（缺環境變數）。");

    const raw = getCookie(STATE_COOKIE);
    deleteCookie(STATE_COOKIE, { path: "/" });
    const st = verifyState(raw, cfg.keys[0], Date.now());
    if (!st || !safeEqual(st.s, data.state)) {
      throw new Error("連結驗證失敗或已逾時（state 不符），請回到 Google 日曆頁重新按「連結」。");
    }
    if (st.u !== context.admin.userId) {
      throw new Error("發起連結與完成連結的不是同一位管理員，請重新按「連結」。");
    }
    const tok = await exchangeCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
      code: data.code,
      codeVerifier: st.v,
    });
    if (!tok.refresh_token) {
      throw new Error(
        "Google 沒有給 refresh token。請到 Google 帳戶「第三方存取權」移除小時光後再連結一次。",
      );
    }
    const saved = await saveGoogleCalendarConnection({
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      scope: tok.scope ?? "",
      connectedBy: context.admin.email,
    });
    return { account: saved.account, calendarCount: saved.calendars.length };
  });

export const listGoogleCalendars = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listGoogleCalendars } = await import("@/server/google-calendar");
    return await listGoogleCalendars();
  });

export const setGoogleCalendarTarget = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ calendarId: z.string().trim().min(1).max(512) }))
  .handler(async ({ data }) => {
    const { setGoogleCalendarTarget } = await import("@/server/google-calendar");
    return await setGoogleCalendarTarget(data.calendarId);
  });

export const syncGoogleCalendarNow = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { runGoogleCalendarSync } = await import("@/server/google-calendar");
    return await runGoogleCalendarSync("manual");
  });

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ removeEvents: z.boolean() }))
  .handler(async ({ data }) => {
    const { disconnectGoogleCalendar } = await import("@/server/google-calendar");
    return await disconnectGoogleCalendar(data.removeEvents);
  });
