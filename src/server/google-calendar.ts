/**
 * Google 日曆同步：連結狀態、OAuth 收尾、同步一輪、存檔後的即時觸發。
 *
 * 規則（哪些事件、怎麼組、只動自己的）在 src/lib/google-calendar-sync.ts；HTTP 在
 * google-calendar-api.ts；加密在 google-calendar-crypto.ts；env 在 google-calendar-config.ts。
 *
 * ── 停用時的保證 ────────────────────────────────────────────────────────────
 * env 沒設齊（readGoogleCalendarConfig().enabled === false）時，這裡的每一支都**不碰資料庫、
 * 不打 Google**：狀態直接回「尚未設定」，觸發與排程端點直接回 disabled。所以這份程式碼
 * 比 0060 先上線也不會讓後台掛掉（不會 select 不存在的表）。
 *
 * ── 觸發 ────────────────────────────────────────────────────────────────────
 *   · pg_cron 每 15 分鐘 → request_google_calendar_sync() → pg_net POST /api/tasks/google-calendar
 *   · 後台存檔／上下架 → nudgeGoogleCalendarSync() → 同一支 RPC（pg_net 非同步，存檔不等 Google）
 *   · 後台「立即同步」 → runGoogleCalendarSync("manual") 直接跑，畫面等結果
 * 同一時間只跑一輪（claim_google_calendar_sync 的鎖）；跑的期間又有人要求 → 跑完再補一輪。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import {
  readGoogleCalendarConfig,
  REQUIRED_SCOPE,
  type GoogleCalendarConfig,
} from "@/server/google-calendar-config";
import { decryptSecret, encryptSecret } from "@/server/google-calendar-crypto";
import {
  createCalendarClient,
  listWritableCalendars,
  refreshAccessToken,
  revokeToken,
  type CalendarListItem,
} from "@/server/google-calendar-api";
import {
  buildDesiredGoogleEvents,
  GoogleApiError,
  syncCalendar,
  type SyncResult,
} from "@/lib/google-calendar-sync";

const TABLE = "google_calendar_sync";

export function googleCalendarConfig(): GoogleCalendarConfig {
  return readGoogleCalendarConfig(process.env);
}

type Row = {
  refresh_token_enc: string | null;
  granted_scopes: string | null;
  google_account: string | null;
  calendar_id: string | null;
  calendar_summary: string | null;
  connected_at: string | null;
  connected_by: string | null;
  sync_locked_until: string | null;
  last_sync_started_at: string | null;
  last_sync_finished_at: string | null;
  last_sync_ok: boolean | null;
  last_sync_trigger: string | null;
  last_sync_summary: SyncSummary | null;
  last_sync_error: string | null;
};

export type SyncSummary = Omit<SyncResult, "errors"> & {
  errors: SyncResult["errors"];
  /** 換日曆／中斷連結時清掉的舊事件數。 */
  purged?: number;
};

export type GoogleCalendarStatus =
  | { configured: false; missing: string[]; invalid: string[] }
  | {
      configured: true;
      redirectUri: string;
      expectedAccount: string | null;
      connected: boolean;
      account: string | null;
      calendarId: string | null;
      calendarSummary: string | null;
      connectedAt: string | null;
      connectedBy: string | null;
      canListCalendars: boolean;
      running: boolean;
      lastSync: {
        startedAt: string | null;
        finishedAt: string | null;
        ok: boolean | null;
        trigger: string | null;
        summary: SyncSummary | null;
        error: string | null;
      };
      needsReconnect: boolean;
    };

async function readRow(): Promise<Row | null> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .select(
      "refresh_token_enc, granted_scopes, google_account, calendar_id, calendar_summary, connected_at, connected_by, sync_locked_until, last_sync_started_at, last_sync_finished_at, last_sync_ok, last_sync_trigger, last_sync_summary, last_sync_error",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`讀取 Google 日曆設定失敗：${error.message}`);
  return (data as Row | null) ?? null;
}

export async function getGoogleCalendarStatus(): Promise<GoogleCalendarStatus> {
  const cfg = googleCalendarConfig();
  if (!cfg.enabled) return { configured: false, missing: cfg.missing, invalid: cfg.invalid };
  const row = await readRow();
  const connected = !!row?.refresh_token_enc;
  return {
    configured: true,
    redirectUri: cfg.redirectUri,
    expectedAccount: cfg.expectedAccount,
    connected,
    account: row?.google_account ?? null,
    calendarId: row?.calendar_id ?? null,
    calendarSummary: row?.calendar_summary ?? null,
    connectedAt: row?.connected_at ?? null,
    connectedBy: row?.connected_by ?? null,
    canListCalendars: (row?.granted_scopes ?? "").includes("calendar.calendarlist.readonly"),
    running: !!row?.sync_locked_until && Date.parse(row.sync_locked_until) > Date.now(),
    lastSync: {
      startedAt: row?.last_sync_started_at ?? null,
      finishedAt: row?.last_sync_finished_at ?? null,
      ok: row?.last_sync_ok ?? null,
      trigger: row?.last_sync_trigger ?? null,
      summary: row?.last_sync_summary ?? null,
      error: row?.last_sync_error ?? null,
    },
    needsReconnect: connected && /invalid_grant/.test(row?.last_sync_error ?? ""),
  };
}

function requireConfig(): Extract<GoogleCalendarConfig, { enabled: true }> {
  const cfg = googleCalendarConfig();
  if (!cfg.enabled) throw new Error("Google 日曆同步尚未設定（缺環境變數）。");
  return cfg;
}

/** 解密 refresh token 換 access token；用舊金鑰解開的順手以現行金鑰重新加密寫回（輪替）。 */
async function accessTokenFor(
  cfg: Extract<GoogleCalendarConfig, { enabled: true }>,
  row: Row,
): Promise<string> {
  if (!row.refresh_token_enc) throw new Error("尚未連結 Google 日曆。");
  const dec = decryptSecret(row.refresh_token_enc, cfg.keys);
  const tok = await refreshAccessToken({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    refreshToken: dec.plaintext,
  });
  if (dec.stale) {
    const { error } = await supabaseAdmin()
      .from(TABLE)
      .update({
        refresh_token_enc: encryptSecret(dec.plaintext, cfg.keys[0]),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) console.warn(`[gcal] 金鑰輪替寫回失敗：${error.message}`);
  }
  return tok.access_token;
}

// =============================================================================
// 連結（OAuth callback 之後）
// =============================================================================

export async function saveGoogleCalendarConnection(p: {
  refreshToken: string;
  accessToken: string;
  scope: string;
  connectedBy: string;
}): Promise<{ account: string | null; calendars: CalendarListItem[] }> {
  const cfg = requireConfig();
  if (!p.scope.split(/\s+/).includes(REQUIRED_SCOPE)) {
    throw new Error(
      "Google 同意畫面沒有勾選「查看、編輯日曆中的活動」，網站無法寫入日曆。請重新連結並勾選。",
    );
  }
  let calendars: CalendarListItem[] = [];
  try {
    calendars = await listWritableCalendars(p.accessToken);
  } catch (err) {
    console.warn(`[gcal] 列不出日曆清單：${err instanceof Error ? err.message : String(err)}`);
  }
  const primary = calendars.find((c) => c.primary) ?? null;
  const previous = await readRow();
  // 帳號「確定換了」才清掉舊的日曆選擇；讀不到新帳號（沒給 calendarlist 權限）時當成同一個，
  // 保留原本的日曆，免得舊日曆裡的事件變成沒人管的孤兒。
  const accountChanged =
    !!previous?.google_account && !!primary && previous.google_account !== primary.id;
  if (accountChanged && previous?.refresh_token_enc) {
    // 換帳號：用舊帳號的授權把舊日曆裡網站建立的事件清掉、撤銷舊授權（盡力而為）。
    try {
      const dec = decryptSecret(previous.refresh_token_enc, cfg.keys);
      if (previous.calendar_id) {
        const r = await purgeOwnEvents(await accessTokenFor(cfg, previous), previous.calendar_id);
        if (r.errors.length) console.warn(`[gcal] 換帳號時清舊事件有 ${r.errors.length} 筆失敗`);
      }
      await revokeToken(dec.plaintext);
    } catch (err) {
      console.warn(
        `[gcal] 換帳號時清理舊授權失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const keep = !accountChanged;
  const { error } = await supabaseAdmin()
    .from(TABLE)
    .upsert({
      id: 1,
      refresh_token_enc: encryptSecret(p.refreshToken, cfg.keys[0]),
      granted_scopes: p.scope,
      google_account: primary?.id ?? previous?.google_account ?? null,
      calendar_id: keep ? (previous?.calendar_id ?? null) : null,
      calendar_summary: keep ? (previous?.calendar_summary ?? null) : null,
      connected_at: new Date().toISOString(),
      connected_by: p.connectedBy,
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`儲存 Google 日曆連結失敗：${error.message}`);
  return { account: primary?.id ?? previous?.google_account ?? null, calendars };
}

export async function listGoogleCalendars(): Promise<CalendarListItem[]> {
  const cfg = requireConfig();
  const row = await readRow();
  if (!row?.refresh_token_enc) throw new Error("尚未連結 Google 日曆。");
  return await listWritableCalendars(await accessTokenFor(cfg, row));
}

/** 只清掉我們建立的事件（換日曆、中斷連結）。 */
async function purgeOwnEvents(accessToken: string, calendarId: string): Promise<SyncResult> {
  return await syncCalendar(createCalendarClient(accessToken), calendarId, []);
}

const BUSY_MESSAGE = "同步正在進行中，請等半分鐘再試一次。";

/**
 * 換日曆／中斷連結也要拿同一把同步鎖：否則一輪同步正寫到一半（已經讀好舊的日曆 id 與 token），
 * 這邊把舊日曆清掉或把連結刪掉，那一輪仍會把事件寫回舊日曆，之後再也沒有人管得到。
 */
async function withSyncLock<T>(
  trigger: string,
  fn: () => Promise<{
    value: T;
    ok: boolean;
    summary: Record<string, unknown> | null;
    error: string | null;
  }>,
): Promise<T> {
  const db = supabaseAdmin();
  const { data: started, error: claimErr } = await db.rpc("claim_google_calendar_sync", {
    p_ttl_seconds: 300,
  });
  if (claimErr) throw new Error(`取得同步鎖失敗：${claimErr.message}`);
  if (!started) throw new Error(BUSY_MESSAGE);
  let out: Awaited<ReturnType<typeof fn>> | null = null;
  try {
    out = await fn();
    return out.value;
  } finally {
    const { error } = await db.rpc("finish_google_calendar_sync", {
      p_started: started,
      p_ok: out?.ok ?? false,
      p_trigger: trigger,
      p_summary: out?.summary ?? null,
      p_error: out ? out.error : "操作中斷",
    });
    if (error) console.warn(`[gcal] 放開同步鎖失敗：${error.message}`);
  }
}

/**
 * 選定要寫入的日曆。換日曆時先把舊日曆裡我們建立的事件清掉（只清自己的）；**清不乾淨就不換**
 * （否則那些事件從此沒人管），清完才改設定、觸發一輪同步。
 */
export async function setGoogleCalendarTarget(calendarId: string): Promise<{ purged: number }> {
  const cfg = requireConfig();
  const row = await readRow();
  if (!row?.refresh_token_enc) throw new Error("尚未連結 Google 日曆。");
  const token = await accessTokenFor(cfg, row);

  let summary = calendarId;
  try {
    const list = await listWritableCalendars(token);
    const hit = list.find((c) => c.id === calendarId);
    if (list.length && !hit) throw new Error("這個日曆不在你可以編輯的日曆清單裡。");
    summary = hit?.summary ?? calendarId;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("這個日曆")) throw err;
    // 沒有 calendarlist 權限：照管理員輸入的 id 用，由第一輪同步驗證寫不寫得進去。
  }

  const purged = await withSyncLock("switch", async () => {
    let removed = 0;
    if (row.calendar_id && row.calendar_id !== calendarId) {
      const r = await purgeOwnEvents(token, row.calendar_id);
      if (r.errors.length) {
        throw new Error(
          `舊日曆有 ${r.errors.length} 筆網站事件刪不掉，日曆先不換，請稍後再試：${r.errors[0].message}`,
        );
      }
      removed = r.removed;
    }
    const { error } = await supabaseAdmin()
      .from(TABLE)
      .update({
        calendar_id: calendarId,
        calendar_summary: summary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw new Error(`儲存日曆選擇失敗：${error.message}`);
    return { value: removed, ok: true, summary: { purged: removed }, error: null };
  });
  await nudgeGoogleCalendarSync();
  return { purged };
}

/**
 * 中斷連結：（可選）清掉我們建立的事件 → 向 Google 撤銷 → 刪掉這一列。
 *
 * 授權已失效（invalid_grant）或金鑰換掉解不開時，**照樣讓人中斷**（刪掉這一列），只是清不到
 * 事件也撤銷不了——回傳 warning 讓管理員知道。卡在「授權壞了所以連中斷都不行」最糟。
 * 授權正常、但有事件刪除失敗時才擋下（連結保留，稍後重試）。
 */
export async function disconnectGoogleCalendar(
  removeEvents: boolean,
): Promise<{ removed: number; revoked: boolean; warning: string | null }> {
  const cfg = requireConfig();
  const row = await readRow();
  let removed = 0;
  let revoked = false;
  let warning: string | null = null;

  const work = async () => {
    if (!row?.refresh_token_enc) return;
    let plaintext: string | null = null;
    let token: string | null = null;
    try {
      plaintext = decryptSecret(row.refresh_token_enc, cfg.keys).plaintext;
      if (removeEvents && row.calendar_id) token = await accessTokenFor(cfg, row);
    } catch (err) {
      warning = `授權已無法使用，沒有清掉日曆裡網站建立的事件（可在 Google 日曆手動刪除）：${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    if (token && row.calendar_id) {
      const r = await purgeOwnEvents(token, row.calendar_id);
      if (r.errors.length) {
        throw new Error(
          `有 ${r.errors.length} 筆事件刪除失敗，連結先保留，請稍後再試：${r.errors[0].message}`,
        );
      }
      removed = r.removed;
    }
    if (plaintext) revoked = await revokeToken(plaintext);
  };

  const deleteRow = async () => {
    const { error } = await supabaseAdmin().from(TABLE).delete().eq("id", 1);
    if (error) throw new Error(`清除連結失敗：${error.message}`);
  };
  if (row?.refresh_token_enc) {
    // 刪列也在鎖裡做：放鎖之後才刪，中間可能又被排程搶去跑一輪、寫進即將失聯的日曆。
    await withSyncLock("disconnect", async () => {
      await work();
      await deleteRow();
      return { value: null, ok: true, summary: null, error: null };
    });
  } else {
    await deleteRow();
  }
  return { removed, revoked, warning };
}

// =============================================================================
// 同步一輪
// =============================================================================

export type RunOutcome =
  | { status: "disabled" | "not_connected" | "busy" }
  | {
      status: "done";
      ok: boolean;
      summary: SyncSummary | null;
      error: string | null;
      passes: number;
    };

const MAX_PASSES = 3;

export async function runGoogleCalendarSync(
  trigger: "cron" | "manual" | "save",
): Promise<RunOutcome> {
  const cfg = googleCalendarConfig();
  if (!cfg.enabled) return { status: "disabled" };
  const db = supabaseAdmin();
  const row = await readRow();
  if (!row?.refresh_token_enc || !row.calendar_id) return { status: "not_connected" };

  let passes = 0;
  let last: { ok: boolean; summary: SyncSummary | null; error: string | null } | null = null;
  while (passes < MAX_PASSES) {
    const { data: started, error: claimErr } = await db.rpc("claim_google_calendar_sync", {
      p_ttl_seconds: 300,
    });
    if (claimErr) throw new Error(`取得同步鎖失敗：${claimErr.message}`);
    if (!started) return passes === 0 ? { status: "busy" } : { status: "done", passes, ...last! };
    passes++;

    let ok = false;
    let summary: SyncSummary | null = null;
    let errorText: string | null = null;
    try {
      const current = (await readRow()) ?? row;
      if (!current.refresh_token_enc || !current.calendar_id) throw new Error("連結已被中斷");
      const token = await accessTokenFor(cfg, current);
      const { collectCalendarInput } = await import("@/server/calendar");
      const desired = buildDesiredGoogleEvents(await collectCalendarInput());
      const result = await syncCalendar(createCalendarClient(token), current.calendar_id, desired);
      summary = result;
      ok = result.errors.length === 0;
      if (!ok) errorText = `${result.errors.length} 筆事件寫入失敗：${result.errors[0].message}`;
    } catch (err) {
      errorText =
        err instanceof GoogleApiError && err.reason === "invalid_grant"
          ? "invalid_grant：Google 授權已失效（被撤銷、過期或密碼變更），請到後台重新連結。"
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(`[gcal] 同步失敗（${trigger}）：${errorText}`);
    }
    last = { ok, summary, error: errorText };
    const { data: again, error: finErr } = await db.rpc("finish_google_calendar_sync", {
      p_started: started,
      p_ok: ok,
      p_trigger: trigger,
      p_summary: summary,
      p_error: errorText,
    });
    if (finErr) console.warn(`[gcal] 寫回同步結果失敗：${finErr.message}`);
    if (!again || !ok) break;
  }
  return { status: "done", passes, ...last! };
}

/**
 * 後台存檔／上下架後呼叫：請資料庫用 pg_net 非同步打一次同步端點。**永不 throw**、最多等
 * 3 秒——存檔已經成功了，日曆晚一點（最晚下一個 15 分鐘排程）跟上即可。
 */
export async function nudgeGoogleCalendarSync(): Promise<void> {
  try {
    if (!googleCalendarConfig().enabled) return;
    const call = supabaseAdmin().rpc("request_google_calendar_sync");
    const timeout = new Promise<{ error: { message: string } }>((resolve) =>
      setTimeout(() => resolve({ error: { message: "timeout" } }), 3000),
    );
    const { error } = await Promise.race([call, timeout]);
    if (error) console.warn(`[gcal] 觸發同步失敗（不影響存檔）：${error.message}`);
  } catch (err) {
    console.warn(
      `[gcal] 觸發同步失敗（不影響存檔）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
