/**
 * Google OAuth 與 Calendar API 的 HTTP 呼叫。fetch 由呼叫端注入（預設全域 fetch），自檢用假
 * fetch 驗請求形狀，不會真的連到 Google。
 *
 * ⚠️ 只 import 相對路徑（同 google-calendar-crypto.ts 的規約），自檢可直接載入。
 */
import {
  GoogleApiError,
  GCAL_MANAGED_PROP,
  type CalendarClient,
  type ExistingGoogleEvent,
  type GoogleEventResource,
} from "../lib/google-calendar-sync.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function buildAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  loginHint?: string | null;
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scopes.join(" "),
    // offline + consent：每一次連結都一定拿得到 refresh token。
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

async function readError(res: Response): Promise<GoogleApiError> {
  let reason = "";
  let message = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as {
      error?: string | { message?: string; errors?: Array<{ reason?: string }>; status?: string };
      error_description?: string;
    };
    if (typeof j.error === "string") {
      reason = j.error;
      message = `${j.error}${j.error_description ? `: ${j.error_description}` : ""}`;
    } else if (j.error) {
      reason = j.error.errors?.[0]?.reason ?? j.error.status ?? "";
      message = `HTTP ${res.status} ${reason}${j.error.message ? `: ${j.error.message}` : ""}`;
    }
  } catch {
    /* 非 JSON 的錯誤主體：只留狀態碼 */
  }
  return new GoogleApiError(res.status, reason, message);
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
};

async function tokenRequest(fetchImpl: FetchLike, body: URLSearchParams): Promise<TokenResponse> {
  const res = await call(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw await readError(res);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token)
    throw new GoogleApiError(500, "no_access_token", "Google 沒有回 access token");
  return j;
}

export function exchangeCode(
  p: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    fetchImpl,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    }),
  );
}

export function refreshAccessToken(
  p: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    fetchImpl,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    }),
  );
}

/** 向 Google 撤銷授權（盡力而為：失敗只回 false）。 */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await call(fetchImpl, GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type CalendarListItem = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
};

/** 業主可以寫入的日曆（writer／owner）。需要 calendar.calendarlist.readonly。 */
export async function listWritableCalendars(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CalendarListItem[]> {
  const out: CalendarListItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ minAccessRole: "writer", maxResults: "250" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await call(fetchImpl, `${CAL_BASE}/users/me/calendarList?${q}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw await readError(res);
    const j = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        summaryOverride?: string;
        primary?: boolean;
        accessRole?: string;
      }>;
      nextPageToken?: string;
    };
    for (const it of j.items ?? []) {
      out.push({
        id: it.id,
        summary: it.summaryOverride || it.summary || it.id,
        primary: it.primary === true,
        accessRole: it.accessRole ?? "",
      });
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** 真正的 Calendar client（實作 CalendarClient）。速率限制／暫時錯誤退避重試最多 3 次。 */
export function createCalendarClient(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): CalendarClient {
  async function req(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await call(fetchImpl, url, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
      if (res.ok) return res;
      const err = await readError(res);
      const rateLimited =
        err.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(err.reason);
      if ((RETRYABLE.has(err.status) || rateLimited) && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  const cal = (calendarId: string) =>
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    async listManaged(calendarId) {
      const out: ExistingGoogleEvent[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({
          privateExtendedProperty: `${GCAL_MANAGED_PROP}=1`,
          maxResults: "2500",
          showDeleted: "false",
          fields: "items(id,status,end,extendedProperties),nextPageToken",
        });
        if (pageToken) q.set("pageToken", pageToken);
        const res = await req(`${cal(calendarId)}?${q}`);
        const j = (await res.json()) as { items?: ExistingGoogleEvent[]; nextPageToken?: string };
        out.push(...(j.items ?? []));
        pageToken = j.nextPageToken;
      } while (pageToken);
      return out;
    },
    async get(calendarId, eventId) {
      try {
        const q = new URLSearchParams({ fields: "id,status,extendedProperties" });
        const res = await req(`${cal(calendarId)}/${encodeURIComponent(eventId)}?${q}`);
        return (await res.json()) as ExistingGoogleEvent;
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410))
          return null;
        throw err;
      }
    },
    async insert(calendarId, event: GoogleEventResource) {
      await req(`${cal(calendarId)}?sendUpdates=none`, {
        method: "POST",
        body: JSON.stringify(event),
      });
    },
    async patch(calendarId, eventId, event: GoogleEventResource) {
      const { id: _id, ...body } = event;
      await req(`${cal(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    async remove(calendarId, eventId) {
      await req(`${cal(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        method: "DELETE",
      });
    },
  };
}
