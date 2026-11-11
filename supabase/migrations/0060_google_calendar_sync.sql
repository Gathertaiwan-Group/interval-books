-- 0060_google_calendar_sync.sql —— 活動自動同步進業主自己的 Google 日曆
--
-- 前一支是 0059_roster_ticket_price.sql。
--
-- 業主 2026-11：/calendar.ics 用「透過網址訂閱」會出現在 Google 日曆的「其他日曆」，她要的是
-- 直接寫進「我的日曆」裡書店自己的那個日曆。所以改成網站用 OAuth（業主一次性授權）直接呼叫
-- Google Calendar API 新增／更新／刪除事件。程式在 src/server/google-calendar.ts。
--
-- ## 這支建了什麼
--
--   §1  public.google_calendar_sync —— 單列表（id = 1）：加密後的 refresh token、要寫入的日曆、
--       同步鎖、最後一次同步的結果。**沒有對照表**：每個事件的 Google event id 由場次 id 雜湊
--       得出（固定 id），並在事件上帶 extendedProperties.private 標記，現況直接問 Google，
--       不在我們這邊另存一份會跟 Google 對不起來的副本。
--   §2  claim／finish 兩支函式：同一時間只跑一輪；跑的期間有人又要求同步 → 跑完再補一輪。
--   §3  request_google_calendar_sync()：cron 與後台存檔都呼叫它。**沒連結（沒 token 或沒選日曆）
--       就直接 return null，不送任何 HTTP**——功能停用時 Vercel 一次都不會被打到。
--   §4  排程：每 15 分鐘（分鐘 9,24,39,54）。
--
-- ## refresh token 的保護
--
-- refresh_token_enc 是 AES-256-GCM 密文，金鑰只在 Vercel env（GOOGLE_CALENDAR_TOKEN_KEY），
-- 資料庫裡沒有。表開 RLS、沒有任何 policy、anon／authenticated 一個權限都沒有，只有
-- service_role 讀寫。
--
-- ## 排程分鐘數
--
-- 既有三支：*/5（0,5,…）、3-53/10（3,13,…）、6-56/10（6,16,…）。這支 9-54/15 → 9,24,39,54：
-- 都不是 5 的倍數，個位數也不是 3 或 6，四支永遠不撞在同一個 tick。
--
-- ## Vault
--
-- 沿用 0008 的 tasks_secret（不重建）。端點網址存在新的 google_calendar_sync_endpoint_url；
-- 網址不是秘密，所以這支在它不存在時直接建（用 vercel.app 網域，理由同 0022 §0.8）。

begin;

-- ---------------------------------------------------------------------------
-- §1  public.google_calendar_sync
-- ---------------------------------------------------------------------------
create table if not exists public.google_calendar_sync (
  id                    smallint primary key default 1 check (id = 1),
  refresh_token_enc     text,
  granted_scopes        text,
  google_account        text,
  calendar_id           text,
  calendar_summary      text,
  connected_at          timestamptz,
  connected_by          text,
  sync_requested_at     timestamptz,
  sync_locked_until     timestamptz,
  last_sync_started_at  timestamptz,
  last_sync_finished_at timestamptz,
  last_sync_ok          boolean,
  last_sync_trigger     text,
  last_sync_summary     jsonb,
  last_sync_error       text,
  updated_at            timestamptz not null default now()
);

alter table public.google_calendar_sync enable row level security;
revoke all on table public.google_calendar_sync from public, anon, authenticated;
grant select, insert, update, delete on table public.google_calendar_sync to service_role;

-- ---------------------------------------------------------------------------
-- §2  同步鎖
-- ---------------------------------------------------------------------------
-- claim：鎖空著（或過期）才拿得到，回傳這一輪的開始時間；拿不到回 null。
create or replace function public.claim_google_calendar_sync(p_ttl_seconds integer default 300)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update public.google_calendar_sync
     set sync_locked_until    = now() + make_interval(secs => greatest(p_ttl_seconds, 30)),
         last_sync_started_at = now(),
         updated_at           = now()
   where id = 1
     and refresh_token_enc is not null
     and (sync_locked_until is null or sync_locked_until < now())
  returning last_sync_started_at;
$$;

-- finish：寫結果、放鎖。回傳 true = 這一輪跑的期間又有人要求同步，呼叫端應該再跑一輪。
create or replace function public.finish_google_calendar_sync(
  p_started timestamptz,
  p_ok      boolean,
  p_trigger text,
  p_summary jsonb,
  p_error   text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.google_calendar_sync
     set sync_locked_until     = null,
         last_sync_finished_at = now(),
         last_sync_ok          = p_ok,
         last_sync_trigger     = p_trigger,
         last_sync_summary     = p_summary,
         last_sync_error       = p_error,
         updated_at            = now()
   where id = 1
     and last_sync_started_at = p_started
  returning coalesce(sync_requested_at > p_started, false);
$$;

-- ---------------------------------------------------------------------------
-- §3  request_google_calendar_sync —— 排程與後台存檔共用的入口
-- ---------------------------------------------------------------------------
create or replace function public.request_google_calendar_sync()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_req_id bigint;
begin
  -- 沒連結就什麼都不做（不送 HTTP、不報錯）：功能停用是正常狀態，不是故障。
  update public.google_calendar_sync
     set sync_requested_at = now()
   where id = 1
     and refresh_token_enc is not null
     and calendar_id is not null;
  if not found then
    return null;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'google_calendar_sync_endpoint_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'tasks_secret';
  if v_url is null or v_secret is null then
    raise exception
      'MISSING_VAULT_SECRET: 需要 vault secret google_calendar_sync_endpoint_url 與 tasks_secret（見 0060_google_calendar_sync.sql）';
  end if;

  select net.http_post(
           url                  := v_url || '?k=' || v_secret,
           body                 := '{}'::jsonb,
           headers              := '{"content-type": "application/json"}'::jsonb,
           timeout_milliseconds := 120000
         )
    into v_req_id;
  return v_req_id;
end;
$$;

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.claim_google_calendar_sync(integer)',
    'public.finish_google_calendar_sync(timestamptz, boolean, text, jsonb, text)',
    'public.request_google_calendar_sync()'
  ] loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- §4  Vault 端點網址＋排程（本機測試庫沒有 vault／pg_cron → 印 warning 跳過）
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('vault.create_secret(text,text,text)') is null then
    raise warning '[0060] 這個資料庫沒有 vault，跳過端點網址（本機測試庫是正常的）';
  elsif not exists (select 1 from vault.secrets where name = 'google_calendar_sync_endpoint_url') then
    perform vault.create_secret(
      'https://interval-books.vercel.app/api/tasks/google-calendar',
      'google_calendar_sync_endpoint_url',
      'Google 日曆同步排程要打的端點（不含 ?k=）');
  end if;

  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise warning '[0060] 這個資料庫沒有 pg_cron，跳過 sync-google-calendar 的排程（本機測試庫是正常的）';
    return;
  end if;
  if not exists (select 1 from cron.job where jobname = 'sync-google-calendar') then
    perform cron.schedule(
      'sync-google-calendar',
      '9-54/15 * * * *',
      $cron$select public.request_google_calendar_sync()$cron$
    );
  end if;
end $$;
