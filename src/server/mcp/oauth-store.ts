/**
 * OAuthStore 的資料庫版（0043_mcp_oauth_state.sql 的三張表，service role）。
 *
 * 介面與語意見 oauth-core.ts 的 OAuthStore。這裡只負責「怎麼在 PostgREST 上做到」：
 *   · consumeOnce   insert mcp_oauth_used_codes；23505（主鍵衝突）＝看過 → false。
 *   · rotateRefresh 以 current_refresh_jti 為條件的 update … returning（compare-and-swap），
 *                   沒更新到再查一次那一列，分辨是「重用」還是「已撤銷／不存在」。
 *   · grantActive   update last_used_at … where 沒撤銷、沒過封頂 returning —— 一次往返同時
 *                   拿到「能不能用」與「最後使用時間」。每個 instance 快取 60 秒（撤銷最多晚
 *                   60 秒生效；同一個 instance 內撤銷會當場清快取）。
 *
 * 🔴 每一個查詢錯誤都丟例外（fail closed）。絕不把「查不到」當成「沒撤銷」。
 * 🔴 不記任何 token、jti 或 code。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import {
  REFRESH_REUSE_GRACE_SECONDS,
  type EpochInfo,
  type NewGrant,
  type OAuthStore,
  type RotateResult,
} from "./oauth-core";

const GRANTS = "mcp_oauth_grants";
const USED = "mcp_oauth_used_codes";
const EPOCHS = "mcp_oauth_user_epochs";

const CACHE_MS = 60_000;
const activeCache = new Map<string, { ok: boolean; at: number }>();
const epochCache = new Map<string, EpochInfo & { at: number }>();

const iso = (sec: number) => new Date(sec * 1000).toISOString();

function prune<T extends { at: number }>(m: Map<string, T>, now: number) {
  if (m.size < 2000) return;
  for (const [k, v] of m) if (now - v.at > CACHE_MS) m.delete(k);
}

/** 後台撤銷之後呼叫：同一個 instance 內立刻生效。 */
export function forgetOAuthCaches(opts: { grantId?: string; userId?: string } = {}) {
  if (opts.grantId) activeCache.delete(opts.grantId);
  if (opts.userId) epochCache.delete(opts.userId);
  if (!opts.grantId && !opts.userId) {
    activeCache.clear();
    epochCache.clear();
  }
}

function fail(what: string, message: string): never {
  throw new Error(`[mcp-oauth] ${what} failed: ${message}`);
}

export const dbOAuthStore: OAuthStore = {
  async consumeOnce(key: string, exp: number): Promise<boolean> {
    const { error } = await supabaseAdmin()
      .from(USED)
      .insert({ jti: key, expires_at: iso(exp) });
    if (!error) return true;
    if (error.code === "23505") return false;
    fail("consumeOnce", error.code ?? "error");
  },

  async createGrant(g: NewGrant): Promise<string> {
    const { data, error } = await supabaseAdmin()
      .from(GRANTS)
      .insert({
        user_id: g.userId,
        client_hash: g.clientHash,
        client_name: g.clientName.slice(0, 80) || "MCP client",
        redirect_uri: g.redirectUri.slice(0, 512),
        scope: g.scope,
        current_refresh_jti: g.refreshJti,
        expires_at: iso(g.expiresAt),
        last_used_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) fail("createGrant", error?.code ?? "no row");
    return (data as { id: string }).id;
  },

  async rotateRefresh(gid, userId, clientHash, oldJti, newJti, now): Promise<RotateResult> {
    const nowIso = iso(now);
    const { data, error } = await supabaseAdmin()
      .from(GRANTS)
      .update({
        current_refresh_jti: newJti,
        previous_refresh_jti: oldJti,
        rotated_at: nowIso,
        last_used_at: nowIso,
      })
      .eq("id", gid)
      .eq("user_id", userId)
      .eq("client_hash", clientHash)
      .eq("current_refresh_jti", oldJti)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (error) fail("rotateRefresh", error.code ?? "error");
    if (Array.isArray(data) && data.length === 1) return "ok";

    const { data: row, error: e2 } = await supabaseAdmin()
      .from(GRANTS)
      .select(
        "user_id, client_hash, current_refresh_jti, previous_refresh_jti, rotated_at, revoked_at, expires_at",
      )
      .eq("id", gid)
      .maybeSingle();
    if (e2) fail("rotateRefresh lookup", e2.code ?? "error");
    if (!row || row.user_id !== userId || row.client_hash !== clientHash) return "missing";
    if (row.revoked_at !== null || Date.parse(row.expires_at) <= now * 1000) return "revoked";
    if (row.current_refresh_jti === oldJti) return "revoked";
    const rotatedMs = row.rotated_at ? Date.parse(row.rotated_at) : NaN;
    const fresh =
      Number.isFinite(rotatedMs) && now * 1000 - rotatedMs < REFRESH_REUSE_GRACE_SECONDS * 1000;
    return row.previous_refresh_jti === oldJti && fresh ? "stale" : "reused";
  },

  async revokeGrant(gid, reason): Promise<void> {
    const { error } = await supabaseAdmin()
      .from(GRANTS)
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq("id", gid)
      .is("revoked_at", null);
    if (error) fail("revokeGrant", error.code ?? "error");
    activeCache.delete(gid);
  },

  async revokeMigratedChain(userId, clientHash, expiresAt, createdBefore): Promise<number> {
    const { data, error } = await supabaseAdmin()
      .from(GRANTS)
      .update({ revoked_at: new Date().toISOString(), revoked_reason: "refresh_reuse" })
      .eq("user_id", userId)
      .eq("client_hash", clientHash)
      .eq("expires_at", iso(expiresAt))
      .lt("created_at", iso(createdBefore))
      .is("revoked_at", null)
      .select("id");
    if (error) fail("revokeMigratedChain", error.code ?? "error");
    for (const r of data ?? []) activeCache.delete((r as { id: string }).id);
    return (data ?? []).length;
  },

  async userEpoch(userId: string, opts: { fresh?: boolean } = {}): Promise<EpochInfo> {
    const now = Date.now();
    const hit = epochCache.get(userId);
    if (!opts.fresh && hit && now - hit.at < CACHE_MS)
      return { epoch: hit.epoch, since: hit.since };
    const { data, error } = await supabaseAdmin()
      .from(EPOCHS)
      .select("epoch, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("userEpoch", error.code ?? "error");
    const epoch = typeof data?.epoch === "number" ? data.epoch : 0;
    const since = data?.updated_at ? Math.floor(Date.parse(data.updated_at) / 1000) : 0;
    prune(epochCache, now);
    epochCache.set(userId, { epoch, since, at: now });
    return { epoch, since };
  },

  async grantActive(gid: string, userId: string, nowSec: number): Promise<boolean> {
    const now = Date.now();
    const hit = activeCache.get(gid);
    if (hit && now - hit.at < CACHE_MS) return hit.ok;
    const nowIso = iso(nowSec);
    const { data, error } = await supabaseAdmin()
      .from(GRANTS)
      .update({ last_used_at: nowIso })
      .eq("id", gid)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (error) fail("grantActive", error.code ?? "error");
    const ok = Array.isArray(data) && data.length === 1;
    prune(activeCache, now);
    activeCache.set(gid, { ok, at: now });
    return ok;
  },
};
