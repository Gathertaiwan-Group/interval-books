-- 0054 MCP 讀寫分級＋操作紀錄的正式欄位
-- =============================================================================
-- 業主 2026-11-03：MCP 要開放營運寫入（訂單狀態、名單、庫存、寄信、發票申請），所以
--   (1) 每一條 OAuth 連線分「唯讀」與「可寫入」，後台 /admin/mcp-connections 切換；
--   (2) 每一次 MCP 寫入（含 dry_run 預覽）都要能查到：誰、哪個 client、哪支工具、
--       哪一筆、改前改後摘要、是不是預覽。
--
-- §1 mcp_oauth_grants.access_level
--   · default 'write'：**既有與新授權的連線都是可寫入**。只有 admin 能授權，業主要的是全面
--     控制；重新授權後若突然變唯讀，連接器會壞（2026-11-03 審查）。要限制某條連線，由 admin
--     在後台降成唯讀。
--   · access token 本身不帶這個值（token 格式不變、舊 token 不失效）；每一次請求由
--     src/server/mcp/http.ts 經 oauth-store 重讀，切換後 ≤60 秒生效（同撤銷的快取）。
--
-- §2 mcp_audit_log 加正式欄位
--   0039 沒有 actor 欄位，audit.ts 一直把「是誰」塞在 changes._actor。這裡補上：
--   actor_via（static_token／readonly_token／oauth）、actor_user_id、actor_email、
--   client_name、dry_run。全部可為 null（舊列沒有值），沒有外鍵（機器身分不是使用者，
--   見 0039 檔頭）。action 的 CHECK 放寬，納入營運寫入的動作名稱。
--   仍是 append-only：service_role 只有 select／insert，不給 update／delete。
-- =============================================================================

begin;

-- §1 ---------------------------------------------------------------------------
alter table public.mcp_oauth_grants
  add column if not exists access_level text not null default 'write';

alter table public.mcp_oauth_grants
  drop constraint if exists mcp_oauth_grants_access_level_valid;
alter table public.mcp_oauth_grants
  add constraint mcp_oauth_grants_access_level_valid check (access_level in ('read', 'write'));

-- 後台切換要 update 這一欄（0043 已給 service_role update，這裡不另外授權）。

-- §2 ---------------------------------------------------------------------------
alter table public.mcp_audit_log add column if not exists actor_via     text;
alter table public.mcp_audit_log add column if not exists actor_user_id uuid;
alter table public.mcp_audit_log add column if not exists actor_email   text;
alter table public.mcp_audit_log add column if not exists client_name   text;
alter table public.mcp_audit_log add column if not exists dry_run       boolean not null default false;

alter table public.mcp_audit_log
  drop constraint if exists mcp_audit_log_actor_via_valid;
alter table public.mcp_audit_log
  add constraint mcp_audit_log_actor_via_valid
  check (actor_via is null or actor_via in ('static_token', 'readonly_token', 'oauth'));

alter table public.mcp_audit_log
  drop constraint if exists mcp_audit_log_action_valid;
alter table public.mcp_audit_log
  add constraint mcp_audit_log_action_valid
  check (action ~ '^[a-z][a-z_]{1,39}$');

create index if not exists mcp_audit_log_actor_idx
  on public.mcp_audit_log (actor_user_id, created_at desc);

commit;
