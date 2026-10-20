-- 0039_mcp_audit_log.sql
--
-- 遠端 MCP server（/api/mcp，src/server/mcp/）寫入的稽核紀錄。
--
-- ── 為什麼是新表 ─────────────────────────────────────────────────────────────
-- 這個站的後台從來沒有 CMS 寫入的稽核表：後台的每一支 server fn 直接呼叫
-- src/server/repos/*，沒有任何一處記「誰改了什麼」。MCP 是第一個「不是人在後台按」
-- 的寫入者，所以從它開始記。既有的個資讀取紀錄表語意不同（記的是讀、有 trigger
-- 擋刪除），不混用。
--
-- ── 形狀 ─────────────────────────────────────────────────────────────────────
--   · 沒有 actor_id、不指向 auth.users：機器身分不是使用者，塞假 UUID 進有外鍵的
--     欄位只會被擋下，而應用層的稽核函式永不 throw ＝ 操作成功、紀錄靜默消失
--     （快樂手踩過）。actor_role 由 CHECK 釘死成 'mcp'。
--   · changes 存 { 欄位: { before, after } }，與工具 dry_run 回給呼叫端的差異同一份。
--   · append-only：service_role 只有 select / insert，沒有 update / delete。
--
-- ── 權限 ─────────────────────────────────────────────────────────────────────
-- RLS 開著、零 policy；anon / authenticated 全部收回。只有伺服器端（service_role）
-- 寫得進去、讀得出來。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 程式碼**只 insert、從不 select** 這張表，而且 insert 失敗會退回「只寫伺服器 log」
-- 並在工具結果裡講出來（src/server/mcp/audit.ts）。所以這支 migration 晚於程式碼
-- 上線也不會弄壞任何頁面 —— 只是那段期間的稽核只在 Vercel log 裡。

create table if not exists public.mcp_audit_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_role  text not null default 'mcp',
  tool        text not null,
  entity      text not null,
  entity_id   text not null,
  action      text not null,
  changes     jsonb not null default '{}'::jsonb,
  constraint mcp_audit_log_actor_role_valid check (actor_role = 'mcp'),
  constraint mcp_audit_log_action_valid check (action in ('create', 'update', 'delete', 'upload'))
);

create index if not exists mcp_audit_log_created_idx
  on public.mcp_audit_log (created_at desc);

create index if not exists mcp_audit_log_entity_idx
  on public.mcp_audit_log (entity, entity_id, created_at desc);

alter table public.mcp_audit_log enable row level security;

revoke all on table public.mcp_audit_log from anon, authenticated;
revoke all on table public.mcp_audit_log from service_role;
grant select, insert on table public.mcp_audit_log to service_role;

comment on table public.mcp_audit_log is
  '遠端 MCP server 的寫入稽核（append-only）。由 src/server/mcp/audit.ts 在每一次實際寫入後新增一列；changes 是 {欄位: {before, after}}。';
