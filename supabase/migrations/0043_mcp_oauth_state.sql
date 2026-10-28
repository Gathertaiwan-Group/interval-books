-- 0043_mcp_oauth_state.sql
--
-- 讓 /api/mcp 的 OAuth（40c1fd0，src/server/mcp/oauth-core.ts）從「無狀態」升級成：
--   · 授權碼真正只能用一次（跨 serverless instance）；
--   · refresh token 輪替＋重用偵測（舊的那張再出現＝被偷了 → 整條授權鏈撤銷）；
--   · /oauth/revoke 與後台「Claude 連線授權」的「撤銷」真的撤得掉；
--   · access token 每次（有 60 秒快取）確認它所屬的授權鏈沒被撤銷。
--
-- ── 三張表 ───────────────────────────────────────────────────────────────────
--   mcp_oauth_grants       一次「允許」＝一列（一條 refresh 鏈）。current_refresh_jti 是
--                          這條鏈「現在有效」的那張 refresh token 的 jti；輪替時以它為條件
--                          做 compare-and-swap，不相符＝重用 → revoked_at=now()。剛被換掉的那張
--                          （previous_refresh_jti）在 rotated_at 之後 30 秒內再出現，視為網路
--                          重送或併發 refresh：只拒絕、不撤銷。
--   mcp_oauth_used_codes   用過的授權碼 jti（主鍵）。insert 撞主鍵＝重放 → invalid_grant。
--                          升級前簽發、沒有授權鏈的舊 refresh 第一次被用掉時，以「整條舊鏈」
--                          （sub＋client＋at0 的雜湊，前綴 'lrt:'）記一筆，讓每條舊鏈只能搬一次。
--   mcp_oauth_user_epochs  每位使用者一個整數。token 內帶簽發當下的 epoch；後台「全部撤銷」
--                          把它加一，連升級前簽發、沒有授權鏈可撤的舊 token 也一起失效。
--
-- ── 權限 ─────────────────────────────────────────────────────────────────────
-- RLS 開著、零 policy；anon／authenticated 全部收回；只有 service_role。
--
-- ── 排程 ─────────────────────────────────────────────────────────────────────
-- 過期的已用授權碼每天清一次。job 名稱加 ib_ 前綴（合併庫上還有別的站的排程）。
-- 沒有 pg_cron 的資料庫印 warning 而不是失敗。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 先上這一支、驗證，再推讀寫它的程式碼。

create table if not exists public.mcp_oauth_grants (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  client_hash          text not null,
  client_name          text not null,
  redirect_uri         text not null,
  scope                text not null default 'mcp',
  current_refresh_jti  text,
  previous_refresh_jti text,
  rotated_at           timestamptz,
  created_at           timestamptz not null default now(),
  last_used_at         timestamptz,
  expires_at           timestamptz not null,
  revoked_at           timestamptz,
  revoked_reason       text,
  constraint mcp_oauth_grants_client_name_len check (char_length(client_name) between 1 and 80),
  constraint mcp_oauth_grants_redirect_uri_len check (char_length(redirect_uri) <= 512),
  constraint mcp_oauth_grants_revoked_reason_valid check (
    revoked_reason is null
    or revoked_reason in ('admin', 'client', 'refresh_reuse', 'revoke_all')
  )
);

create index if not exists mcp_oauth_grants_user_idx
  on public.mcp_oauth_grants (user_id, created_at desc);

create index if not exists mcp_oauth_grants_created_idx
  on public.mcp_oauth_grants (created_at desc);

create table if not exists public.mcp_oauth_used_codes (
  jti         text primary key,
  expires_at  timestamptz not null,
  constraint mcp_oauth_used_codes_jti_len check (char_length(jti) between 8 and 80)
);

create index if not exists mcp_oauth_used_codes_exp_idx
  on public.mcp_oauth_used_codes (expires_at);

create table if not exists public.mcp_oauth_user_epochs (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  epoch       integer not null default 0,
  updated_at  timestamptz not null default now(),
  constraint mcp_oauth_user_epochs_epoch_nonneg check (epoch >= 0)
);

alter table public.mcp_oauth_grants      enable row level security;
alter table public.mcp_oauth_used_codes  enable row level security;
alter table public.mcp_oauth_user_epochs enable row level security;

revoke all on table public.mcp_oauth_grants      from anon, authenticated;
revoke all on table public.mcp_oauth_used_codes  from anon, authenticated;
revoke all on table public.mcp_oauth_user_epochs from anon, authenticated;

revoke all on table public.mcp_oauth_grants      from service_role;
revoke all on table public.mcp_oauth_used_codes  from service_role;
revoke all on table public.mcp_oauth_user_epochs from service_role;

grant select, insert, update on table public.mcp_oauth_grants      to service_role;
grant select, insert, delete on table public.mcp_oauth_used_codes  to service_role;
grant select, insert, update on table public.mcp_oauth_user_epochs to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise warning 'PG_CRON_NOT_INSTALLED —— 略過 ib_mcp_oauth_used_codes_purge 排程。';
  else
    perform cron.schedule(
      'ib_mcp_oauth_used_codes_purge',
      '17 3 * * *',
      $cmd$delete from public.mcp_oauth_used_codes where expires_at < now() - interval '1 day'$cmd$
    );
  end if;
end $$;
