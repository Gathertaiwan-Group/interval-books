-- 0052_event_listing_status.sql —— 活動與策旅的「單一上架狀態」：草稿／上架／下架
--
-- 業主（2026-11-02）：一場活動要正確上架，得分別打開「活動發布狀態」、把售票商品改成
-- 「已上架」、再到策旅列表打開卡片的發布——漏一個，客人就會看得到卻不能報名，或整個看不到。
-- 2026-11-02 當天就發生一次：「植生布植生牆｜布苔球」活動頁已發布，售票商品還是草稿。
--
-- ── 設計：新增 events.status 當唯一真相，其他三個欄位一律由資料庫推導 ─────────────
--   events.status   'draft'（草稿）／'live'（上架）／'archived'（下架）
--     ├─ events.is_published        = (status = 'live')              ← §4a BEFORE trigger
--     ├─ 票券商品 products.status    draft／active／archived          ← §4b AFTER trigger 推、§4c BEFORE trigger 拉
--     └─ 指向它的策旅卡片 journeys   status 同上、is_published 同上    ← §4b 推、§4d 拉
--
--   為什麼要新欄位、不是只寫一支 RPC 同步現有三欄：
--     1. 外部報名的活動**沒有**售票商品。只剩 is_published 一個 boolean，分不出「草稿」與
--        「下架」——下架的活動會被當成沒寫完的草稿。
--     2. 只靠 RPC 同步，任何繞過它的寫入（後台商品頁改狀態、舊的 update_event、Supabase
--        後台手改）都還是能把三欄改到不一致。trigger 讓「衍生欄位」在資料庫層就改不歪：
--        直接改 products.status／journeys.is_published／events.is_published 都會被拉回。
--     3. 前台、RLS（events/journeys 的 is_published、products 的 status='active'）、結帳
--        （priceLines 的 status='active'）、sitemap 全部照舊讀衍生欄位就對——不必一次改完
--        所有讀取端，也不會因為漏改一處而露出草稿。
--   代價：多一個欄位要維護，以及「直接改衍生欄位沒有用」這件事要寫清楚（見 comment）。
--
--   策旅卡片與活動之間沒有外鍵：卡片用 journeys.external_url 指向 /events/<slug>（或外部
--   報名時與活動相同的外部網址）。§3 的 journey_linked_event_id() 照抄
--   src/lib/journey-events.ts 的判準，連得上的卡片跟著活動走；連不上的（孤兒卡片）保有
--   自己的 status，由 admin_set_journey_status() 改。
--
--   活動改代稱／外部網址或被刪掉，原本跟著它、現在連不上的卡片收成草稿（§4b'），不會帶著
--   「上架」變成連到 404 的孤兒。
--
--   場次 event_sessions.status（open／closed）**不併入**，維持場次層級的開關。
--
-- ── §2 既有資料怎麼推定（依「客人現在實際看到的」）────────────────────────────────
--   活動  is_published=true                         → live（客人看得到）
--         is_published=false 且商品是 archived       → archived
--         is_published=false 其他                    → draft
--   卡片  連得上活動 → 跟活動；孤兒 → is_published ? live : draft
--   ⚠️ 推定後 §6 會把衍生欄位對齊。「活動已發布、商品還是草稿」的那一場會因此開放報名——
--      這是修正明顯的不一致（業主已經用 MCP 把它發布），回報裡逐筆列出。
--
-- ── §5 寫入入口（都只 grant service_role）─────────────────────────────────────
--   admin_set_event_status(event_id, status)      後台列表／MCP set_event_status／一頁新增「直接上架」
--   admin_set_journey_status(journey_id, status)  只給孤兒卡片；連得上活動的卡片會被拒絕
--   admin_upsert_event_with_session(payload)      後台活動編輯頁的「儲存」：payload.event.status
--                                                 （沒帶＝不動），與內容同一個交易
--   event_listing_snapshot(event_id)              唯讀：三個衍生欄位的現況＋是否一致（預覽與驗收用）
begin;

-- ═══ §1 欄位 ═══════════════════════════════════════════════════════════════
alter table public.events
  add column if not exists status text not null default 'draft';
alter table public.journeys
  add column if not exists status text not null default 'draft';

alter table public.events
  drop constraint if exists events_status_check,
  add constraint events_status_check check (status in ('draft', 'live', 'archived'));
alter table public.journeys
  drop constraint if exists journeys_status_check,
  add constraint journeys_status_check check (status in ('draft', 'live', 'archived'));

comment on column public.events.status is
  '0052：上架狀態的唯一真相。draft 草稿／live 上架／archived 下架。is_published 與票券商品的 status 由 trigger 從這一欄推導，直接改那兩欄沒有用。寫入走 admin_set_event_status 或 admin_upsert_event_with_session。';
comment on column public.journeys.status is
  '0052：卡片的上架狀態。連得上活動（external_url 指向 /events/<slug> 或與活動相同的外部網址）的卡片由 trigger 跟著 events.status；孤兒卡片才是自己的真相（admin_set_journey_status）。is_published 由它推導。';

-- ═══ §2 推定既有資料（trigger 建立前做，才不會被拉回）═══════════════════════
update public.events e
   set status = case
     when e.is_published then 'live'
     when exists (
       select 1 from public.products p
        where p.source_type = 'event' and p.source_id = e.id and p.status = 'archived'
     ) then 'archived'
     else 'draft'
   end;

-- ═══ §3 卡片 → 活動 ═══════════════════════════════════════════════════════
-- 與 src/lib/journey-events.ts#eventSlugFromJourneyUrl／journeyEventMatcher 同一套判準：
--   · `/events/<slug>` 或本站完整網址（intervalbooks.tw／www.intervalbooks.tw）→ 依 slug 找
--   · 其他 http(s) 網址 → 與活動的 external_url 比（去頭尾空白、去結尾斜線）
-- 差異：TS 會先 decodeURIComponent slug；這裡不解碼（現有代稱都是 ASCII，見 0026）。
-- 卡片網址 → 它指的活動代稱（`/events/<slug>` 或本站完整網址；其他回 null）。
create or replace function public.journey_url_slug(p_url text)
returns text
language plpgsql
immutable
as $$
declare
  v_url  text := btrim(coalesce(p_url, ''));
  v_path text;
  v_slug text;
begin
  if v_url = '' then
    return null;
  end if;
  if v_url ~* '^https?://' then
    if lower(substring(v_url from '^[A-Za-z]+://([^/?#:]+)')) in ('intervalbooks.tw', 'www.intervalbooks.tw') then
      v_path := coalesce(substring(v_url from '^[A-Za-z]+://[^/?#]+([^?#]*)'), '');
    end if;
  else
    v_path := v_url;
  end if;
  if v_path is null then
    return null;
  end if;
  v_path := regexp_replace(split_part(split_part(v_path, '?', 1), '#', 1), '/+$', '');
  if left(v_path, 8) <> '/events/' then
    return null;
  end if;
  v_slug := substring(v_path from 9);
  if v_slug = '' or position('/' in v_slug) > 0 then
    return null;
  end if;
  return v_slug;
end;
$$;

-- 卡片網址 → 拿來跟活動 external_url 比對的外部網址（代稱形狀的連結不比外部網址，與 TS 相同）。
create or replace function public.journey_url_external(p_url text)
returns text
language sql
immutable
as $$
  select case
    when public.journey_url_slug(p_url) is null and btrim(coalesce(p_url, '')) ~* '^https?://'
      then regexp_replace(btrim(p_url), '/+$', '')
    else null
  end;
$$;

create or replace function public.journey_linked_event_id(p_url text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slug text := public.journey_url_slug(p_url);
  v_ext  text := public.journey_url_external(p_url);
  v_id   text;
begin
  if v_slug is not null then
    -- 代稱形狀的連結只認代稱（查不到就是孤兒），與 TS 一樣不再比外部網址。
    select e.id into v_id from public.events e where e.slug = v_slug;
    return v_id;
  end if;
  if v_ext is not null then
    select e.id into v_id
      from public.events e
     where btrim(e.external_url) ~* '^https?://'
       and regexp_replace(btrim(e.external_url), '/+$', '') = v_ext
     order by e.sort_order, e.id
     limit 1;
    return v_id;
  end if;
  return null;
end;
$$;

-- 狀態 → 票券商品的 status。
create or replace function public.listing_status_to_product_status(p_status text)
returns text
language sql
immutable
as $$
  select case p_status when 'live' then 'active' when 'archived' then 'archived' else 'draft' end;
$$;

-- §2b 安全閥：除了「活動已發布、商品還是草稿」這一種（業主要修的那一筆），其他任何
--      「客人看得到的東西會因推定而改變」的組合都先停下來，不靜默改掉。正式庫套用前已查過
--      （2026-11-02：只有 20261220 這一筆屬於允許的那一種），出現別的就是資料在這之間變了。
do $$
declare
  v_bad text;
begin
  select string_agg(x, '；') into v_bad from (
    select format('活動 %s 已發布但票券商品是 %s', e.slug, p.status) x
      from public.events e
      join public.products p on p.source_type = 'event' and p.source_id = e.id
     where e.is_published and p.status = 'archived'
    union all
    select format('活動 %s 未發布但票券商品是 active（/shop 買得到）', e.slug)
      from public.events e
      join public.products p on p.source_type = 'event' and p.source_id = e.id
     where not e.is_published and p.status = 'active'
    union all
    select format('票券商品 %s 的活動 %s 不存在', p.slug, p.source_id)
      from public.products p
     where p.source_type = 'event'
       and not exists (select 1 from public.events e where e.id = p.source_id)
    union all
    select format('策旅卡片 %s 的發布（%s）與活動 %s（%s）不同', j.id, j.is_published, e.slug, e.is_published)
      from public.journeys j
      join public.events e on e.id = public.journey_linked_event_id(j.external_url)
     where j.is_published is distinct from e.is_published
    union all
    select format('有 source_type=journey 的票券商品 %s（不在同步範圍內）', p.slug)
      from public.products p
     where p.source_type = 'journey'
  ) t;
  if v_bad is not null then
    raise exception '0052 推定會改變客人目前看到的東西，先停下來人工確認：%', v_bad;
  end if;
end;
$$;

-- 卡片的推定（連得上活動 → 跟活動；孤兒 → 依現在是否發布）。
update public.journeys j
   set status = coalesce(
     (select e.status from public.events e where e.id = public.journey_linked_event_id(j.external_url)),
     case when j.is_published then 'live' else 'draft' end
   );

-- ═══ §4 trigger ════════════════════════════════════════════════════════════
-- 4a. events.is_published 是 status 的衍生值。
create or replace function public.events_derive_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.is_published := (new.status = 'live');
  return new;
end;
$$;

drop trigger if exists events_derive_published on public.events;
create trigger events_derive_published
  before insert or update on public.events
  for each row execute function public.events_derive_published();

-- 4b. 活動的狀態（或代稱／外部網址——會改變哪些卡片連得上它）變了 → 推給票券商品與卡片。
create or replace function public.events_sync_listing_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod_status text := public.listing_status_to_product_status(new.status);
begin
  update public.products p
     set status = v_prod_status
   where p.source_type = 'event'
     and p.source_id   = new.id
     and p.status is distinct from v_prod_status;

  update public.journeys j
     set status = new.status
   where public.journey_linked_event_id(j.external_url) = new.id
     and (j.status is distinct from new.status or j.is_published is distinct from (new.status = 'live'));
  return new;
end;
$$;

drop trigger if exists events_sync_listing_status on public.events;
create trigger events_sync_listing_status
  after insert or update of status, slug, external_url on public.events
  for each row execute function public.events_sync_listing_status();

-- 4b'. 活動改了代稱／外部網址、或被刪掉 → 原本跟著它、現在連不上任何活動的卡片收成草稿。
--      不收的話，卡片會帶著「上架」變成孤兒，在 /journeys 上連到一個 404。
create or replace function public.events_orphan_journeys()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.journeys j
     set status = 'draft'
   where j.status <> 'draft'
     and (
       public.journey_url_slug(j.external_url) = old.slug
       or (
         public.journey_url_external(j.external_url) is not null
         and public.journey_url_external(j.external_url) = regexp_replace(btrim(coalesce(old.external_url, '')), '/+$', '')
       )
     )
     and public.journey_linked_event_id(j.external_url) is null;
  return null;
end;
$$;

drop trigger if exists events_orphan_journeys on public.events;
create trigger events_orphan_journeys
  after update of slug, external_url or delete on public.events
  for each row execute function public.events_orphan_journeys();

-- 4c. 票券商品被寫入（後台商品頁、舊程式、手改）→ 狀態一律拉回活動推導的值。
create or replace function public.products_pull_listing_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if new.source_type = 'event' and new.source_id is not null then
    select e.status into v_status from public.events e where e.id = new.source_id;
    if found then
      new.status := public.listing_status_to_product_status(v_status);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_pull_listing_status on public.products;
create trigger products_pull_listing_status
  before insert or update on public.products
  for each row execute function public.products_pull_listing_status();

-- 4d. 卡片被寫入 → 連得上活動就跟活動；is_published 一律由 status 推導。
create or replace function public.journeys_pull_listing_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select e.status into v_status
    from public.events e
   where e.id = public.journey_linked_event_id(new.external_url);
  if found then
    new.status := v_status;
  end if;
  new.is_published := (new.status = 'live');
  return new;
end;
$$;

drop trigger if exists journeys_pull_listing_status on public.journeys;
create trigger journeys_pull_listing_status
  before insert or update on public.journeys
  for each row execute function public.journeys_pull_listing_status();

-- ═══ §5 寫入入口與唯讀快照 ═════════════════════════════════════════════════
create or replace function public.event_listing_snapshot(p_event_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ev   public.events%rowtype;
  v_prod jsonb;
  v_jour jsonb;
  v_ok   boolean;
begin
  select * into v_ev from public.events where id = p_event_id;
  if not found then
    return null;
  end if;
  select jsonb_build_object('id', p.id, 'status', p.status) into v_prod
    from public.products p
   where p.source_type = 'event' and p.source_id = v_ev.id;
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'status', j.status, 'is_published', j.is_published) order by j.sort_order, j.id), '[]'::jsonb)
    into v_jour
    from public.journeys j
   where public.journey_linked_event_id(j.external_url) = v_ev.id;

  v_ok := v_ev.is_published = (v_ev.status = 'live')
      and (v_prod is null or v_prod ->> 'status' = public.listing_status_to_product_status(v_ev.status))
      and not exists (
        select 1 from jsonb_array_elements(v_jour) x
         where x ->> 'status' <> v_ev.status
            or (x ->> 'is_published')::boolean <> (v_ev.status = 'live')
      );

  return jsonb_build_object(
    'event_id',     v_ev.id,
    'slug',         v_ev.slug,
    'status',       v_ev.status,
    'is_published', v_ev.is_published,
    'registration_type', v_ev.registration_type,
    'product',      v_prod,
    'journeys',     v_jour,
    'consistent',   v_ok
  );
end;
$$;

create or replace function public.admin_set_event_status(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before text;
begin
  if p_status is null or p_status not in ('draft', 'live', 'archived') then
    raise exception 'admin_set_event_status: status 必須是 draft／live／archived（收到 %）', p_status;
  end if;
  select e.status into v_before from public.events e where e.id = p_event_id for update;
  if not found then
    raise exception 'admin_set_event_status: 找不到活動 %', p_event_id;
  end if;
  if v_before is distinct from p_status then
    update public.events set status = p_status where id = p_event_id;
  end if;
  return public.event_listing_snapshot(p_event_id)
      || jsonb_build_object('status_before', v_before, 'changed', v_before is distinct from p_status);
end;
$$;

create or replace function public.admin_set_journey_status(p_journey_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.journeys%rowtype;
  v_before text;
  v_event  text;
begin
  if p_status is null or p_status not in ('draft', 'live', 'archived') then
    raise exception 'admin_set_journey_status: status 必須是 draft／live／archived（收到 %）', p_status;
  end if;
  select * into v_row from public.journeys where id = p_journey_id for update;
  if not found then
    raise exception 'admin_set_journey_status: 找不到策旅卡片 %', p_journey_id;
  end if;
  v_event := public.journey_linked_event_id(v_row.external_url);
  if v_event is not null then
    raise exception 'admin_set_journey_status: 這張卡片跟著活動 % 走，請改活動的狀態（admin_set_event_status）', v_event;
  end if;
  v_before := v_row.status;
  if v_before is distinct from p_status then
    update public.journeys set status = p_status where id = p_journey_id returning * into v_row;
  end if;
  return jsonb_build_object(
    'journey_id', v_row.id, 'status', v_row.status, 'is_published', v_row.is_published,
    'status_before', v_before, 'changed', v_before is distinct from p_status
  );
end;
$$;


-- ═══ §6 把衍生欄位對齊 §2 推定的狀態 ═══════════════════════════════════════
-- 只動真的不一致的列（updated_at 才不會被無謂地翻新——sitemap 的 lastmod 讀它）。
update public.events
   set status = status
 where is_published is distinct from (status = 'live');

update public.products p
   set status = public.listing_status_to_product_status(e.status)
  from public.events e
 where p.source_type = 'event'
   and p.source_id   = e.id
   and p.status is distinct from public.listing_status_to_product_status(e.status);

update public.journeys
   set status = status
 where is_published is distinct from (status = 'live');

-- ═══ §7 後台「儲存」那一支：payload.event.status 與內容同一個交易 ══════════════
-- 函式本體取自正式庫 pg_get_functiondef（最後一版是 0031），只加三處，標了 0052：
--   ① 驗 event.status（帶了就要是三個值之一；沒帶＝沿用舊值，新增＝草稿）
--   ② insert 多寫 status；is_published 直接寫推導結果（反正會被 4a 覆寫）
--   ③ on conflict 多更新 status
-- 簽章與回傳形狀不變（create or replace），security definer／search_path 不變。
-- 票券商品那一段照舊寫 payload.product.status，但 4c 會把它拉回活動推導的值。
create or replace function public.admin_upsert_event_with_session(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_ev        jsonb := payload -> 'event';
  v_prod      jsonb := payload -> 'product';
  v_sess      jsonb := payload -> 'session';

  v_event_id  text;
  v_slug      text;
  v_key       text;

  v_event     public.events%rowtype;
  v_product   public.products%rowtype;
  v_session   public.event_sessions%rowtype;

  v_prod_id   text;
  v_sess_id   uuid;
  v_count     integer;

  -- 0027：七個清單欄位。payload 沒帶就沿用舊值，兩邊都沒有才用空清單。
  -- 0029：show_seats_remaining 也靠 v_prev 做「沒帶就不動」。
  -- 0031：gallery_keys 同一條規則，但型別是 text[] 不是 jsonb，所以另外用
  --       v_gallery_keys 這個區域變數算好再放進 insert，不能沿用那一行
  --       coalesce(jsonb, jsonb, jsonb) 的寫法。
  v_prev      public.events%rowtype;
  c_empty_list constant jsonb := '{"zh": [], "en": [], "ja": []}'::jsonb;
  v_gallery_keys text[];
begin
  -- ── 驗 payload ─────────────────────────────────────────────────────────
  -- jsonb 換來的彈性要用執行期檢查付回去。每一句都點名那個 key。
  if v_ev is null or jsonb_typeof(v_ev) <> 'object' then
    raise exception 'admin_upsert_event_with_session: payload 缺少 "event" 物件';
  end if;

  -- is_localized(null) 回 false（見 0001_init.sql:56），所以「key 不存在」與
  -- 「key 在但形狀不對」走同一條路，不需要先分開判斷。
  foreach v_key in array array['title', 'summary', 'description'] loop
    if not public.is_localized(v_ev -> v_key) then
      raise exception 'admin_upsert_event_with_session: event.% 必須是 {zh,en,ja} 三語物件', v_key;
    end if;
  end loop;

  -- 🔴 0031：external_url 從這個迴圈拿掉了。它仍然是 events 的 NOT NULL 欄位，
  --    但「不可為空」是這支函式自己加的規則，不是資料庫的規則——而且這條規則
  --    擋住了 5 場已經把外部連結清空的活動（見檔頭）。display_date / category /
  --    registration_type 三個維持原樣：它們是真的不能省略的欄位。
  foreach v_key in array array['display_date', 'category', 'registration_type'] loop
    if coalesce(trim(v_ev ->> v_key), '') = '' then
      raise exception 'admin_upsert_event_with_session: event.% 不可為空', v_key;
    end if;
  end loop;

  -- 0027：七個清單欄位。**沒帶那個 key 是合法的**（等於「這一欄不動」），但只要帶了
  -- 就一定要是 {zh:[],en:[],ja:[]} 的形狀。這裡先擋，是為了讓錯誤訊息點名是哪一欄
  -- ——不擋的話下面的 INSERT 會撞上 CHECK，使用者拿到的是一個 23514 與一串約束名。
  foreach v_key in array array[
    'highlights', 'suitable_for', 'not_suitable_for', 'takeaways',
    'outline', 'includes', 'notes'
  ] loop
    if (v_ev ? v_key) and not public.is_localized_list(v_ev -> v_key) then
      raise exception
        'admin_upsert_event_with_session: event.% 必須是 {"zh":[…],"en":[…],"ja":[…]} 三語清單（每一項都要是字串）', v_key;
    end if;
  end loop;

  -- 0031：gallery_keys。**沒帶那個 key 是合法的**（等於「這一欄不動」），但帶了
  -- 就一定要是一個字串陣列——同一個「先擋、點名哪一欄」的理由。
  if (v_ev ? 'gallery_keys') then
    if jsonb_typeof(v_ev -> 'gallery_keys') <> 'array' then
      raise exception 'admin_upsert_event_with_session: event.gallery_keys 必須是字串陣列';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ev -> 'gallery_keys') as elem
       where jsonb_typeof(elem) <> 'string'
    ) then
      raise exception 'admin_upsert_event_with_session: event.gallery_keys 的每一項都必須是字串';
    end if;
  end if;

  -- 0052：上架狀態。**沒帶 status 這個 key 是合法的**（＝ 沿用舊值；新增則是草稿），
  -- 帶了就一定要是三個值之一。is_published 與票券商品的 status 一律由 0052 的 trigger
  -- 從這一欄推導，payload 裡的 is_published／product.status 不再有作用。
  if (v_ev ? 'status') and coalesce(v_ev ->> 'status', '') not in ('draft', 'live', 'archived') then
    raise exception 'admin_upsert_event_with_session: event.status 必須是 draft／live／archived（收到 %）', v_ev ->> 'status';
  end if;

  -- ── 活動 ───────────────────────────────────────────────────────────────
  -- events.id 沒有 DB default（text primary key，見 0001_init.sql:175），所以新增
  -- 時要自己產一個。與 src/server/repos/events.ts 用 randomUUID() 是同一件事。
  v_event_id := nullif(trim(coalesce(v_ev ->> 'id', '')), '');
  if v_event_id is null then
    v_event_id := gen_random_uuid()::text;
  end if;

  -- 0027：先把舊的那一列讀出來，下面七個清單欄位與 0031 的 gallery_keys
  -- 「payload 沒帶就沿用舊值」要用它。新增時查不到列，v_prev 的每一欄都是
  -- NULL，coalesce 就落到空清單／空陣列。
  select e.* into v_prev from public.events e where e.id = v_event_id;

  -- 0031：gallery_keys 從 jsonb 陣列轉成 text[]。空字串元素順手濾掉——跟這個
  -- repo 到處都在做的 `nullif(trim(...), '')` 是同一個防線，只是這裡是陣列
  -- 版本。
  if v_ev ? 'gallery_keys' then
    select coalesce(array_agg(x) filter (where length(trim(x)) > 0), '{}'::text[])
      into v_gallery_keys
      from jsonb_array_elements_text(v_ev -> 'gallery_keys') x;
  else
    v_gallery_keys := coalesce(v_prev.gallery_keys, '{}'::text[]);
  end if;

  -- slug 省略時：更新沿用舊值（不會因為前端漏送就把代稱洗掉），新增用 id
  -- （＝ 0026 回填規則，見檔頭）。
  v_slug := nullif(trim(coalesce(v_ev ->> 'slug', '')), '');
  if v_slug is null then
    select e.slug into v_slug from public.events e where e.id = v_event_id;
    v_slug := coalesce(v_slug, v_event_id);
  end if;

  insert into public.events (
    id, slug, title, summary, description, display_date, iso_date, category,
    speaker_id, image_key, external_url, registration_type, payment_enabled,
    is_published, status, sort_order,
    highlights, suitable_for, not_suitable_for, takeaways, outline, includes, notes,
    show_seats_remaining, gallery_keys
  )
  values (
    v_event_id,
    v_slug,
    v_ev -> 'title',
    v_ev -> 'summary',
    v_ev -> 'description',
    v_ev ->> 'display_date',
    -- iso_date 是 date（不是 text）。空字串要先變 NULL 再轉型，
    -- 因為 ''::date 是 22007 而不是 NULL。
    nullif(trim(coalesce(v_ev ->> 'iso_date', '')), '')::date,
    v_ev ->> 'category',
    nullif(trim(coalesce(v_ev ->> 'speaker_id', '')), ''),
    nullif(trim(coalesce(v_ev ->> 'image_key', '')), ''),
    -- 🔴 0031：coalesce 到空字串，不是任由 NULL 撞上 NOT NULL——見檔頭「順手修」。
    coalesce(v_ev ->> 'external_url', ''),
    v_ev ->> 'registration_type',
    coalesce((v_ev ->> 'payment_enabled')::boolean, false),
    -- 0052：is_published 是 status 的衍生值，由 events_derive_published trigger 覆寫；
    --       這裡寫什麼都會被蓋掉，所以直接寫推導結果，不再讀 payload。
    coalesce(nullif(v_ev ->> 'status', ''), v_prev.status, 'draft') = 'live',
    coalesce(nullif(v_ev ->> 'status', ''), v_prev.status, 'draft'),
    coalesce((v_ev ->> 'sort_order')::integer, 0),
    coalesce(v_ev -> 'highlights',       v_prev.highlights,       c_empty_list),
    coalesce(v_ev -> 'suitable_for',     v_prev.suitable_for,     c_empty_list),
    coalesce(v_ev -> 'not_suitable_for', v_prev.not_suitable_for, c_empty_list),
    coalesce(v_ev -> 'takeaways',        v_prev.takeaways,        c_empty_list),
    coalesce(v_ev -> 'outline',          v_prev.outline,          c_empty_list),
    coalesce(v_ev -> 'includes',         v_prev.includes,         c_empty_list),
    coalesce(v_ev -> 'notes',            v_prev.notes,            c_empty_list),
    -- 0029：沒帶就沿用舊值，新增才落到 true。
    coalesce((v_ev ->> 'show_seats_remaining')::boolean, v_prev.show_seats_remaining, true),
    -- 0031：上面算好的區域變數，理由見宣告處。
    v_gallery_keys
  )
  on conflict (id) do update set
    slug              = excluded.slug,
    title             = excluded.title,
    summary           = excluded.summary,
    description       = excluded.description,
    display_date      = excluded.display_date,
    iso_date          = excluded.iso_date,
    category          = excluded.category,
    speaker_id        = excluded.speaker_id,
    image_key         = excluded.image_key,
    external_url      = excluded.external_url,
    registration_type = excluded.registration_type,
    payment_enabled   = excluded.payment_enabled,
    is_published      = excluded.is_published,
    status            = excluded.status,
    sort_order        = excluded.sort_order,
    highlights        = excluded.highlights,
    suitable_for      = excluded.suitable_for,
    not_suitable_for  = excluded.not_suitable_for,
    takeaways         = excluded.takeaways,
    outline           = excluded.outline,
    includes          = excluded.includes,
    notes             = excluded.notes,
    show_seats_remaining = excluded.show_seats_remaining,
    gallery_keys      = excluded.gallery_keys
  returning * into v_event;

  -- ── 商品 ───────────────────────────────────────────────────────────────
  -- 先看這場活動已經有沒有商品（唯一索引保證最多一列）。有就更新那一列，沒有
  -- 而且 payload 帶了 "product" 才新建。
  select p.id into v_prod_id
    from public.products p
   where p.source_type = 'event'
     and p.source_id   = v_event.id;

  if v_prod is not null and jsonb_typeof(v_prod) = 'object' then
    if (v_prod ->> 'price') is null then
      raise exception 'admin_upsert_event_with_session: product.price 不可為空';
    end if;

    if v_prod_id is null then
      v_prod_id := gen_random_uuid()::text;
    end if;

    insert into public.products (
      id, slug, product_type, source_type, source_id,
      title, summary, description,
      price, compare_at_price, stock, capacity, image_key,
      requires_shipping, status, sort_order,
      show_seats_remaining
    )
    values (
      v_prod_id,
      public.event_product_slug(v_event.slug),
      'event',
      'event',
      v_event.id,
      v_event.title,
      v_event.summary,
      -- 🔴 summary，不是 description。理由見檔頭；這是這條規則唯一的家。
      v_event.summary,
      (v_prod ->> 'price')::integer,
      nullif(trim(coalesce(v_prod ->> 'compare_at_price', '')), '')::integer,
      null,                                   -- stock：報名不是實體庫存
      null,                                   -- capacity：0020 起一律 null（名額在場次）
      v_event.image_key,
      false,                                  -- requires_shipping：報名不寄東西
      coalesce(nullif(trim(coalesce(v_prod ->> 'status', '')), ''), 'active'),
      coalesce((v_prod ->> 'sort_order')::integer, v_event.sort_order),
      -- 0029：與 image_key 同一類 —— 從活動投影過來，不是商品自己的決定。
      v_event.show_seats_remaining
    )
    on conflict (id) do update set
      slug             = excluded.slug,
      title            = excluded.title,
      summary          = excluded.summary,
      description      = excluded.description,
      price            = excluded.price,
      compare_at_price = excluded.compare_at_price,
      image_key        = excluded.image_key,
      status           = excluded.status,
      sort_order       = excluded.sort_order,
      show_seats_remaining = excluded.show_seats_remaining
    returning * into v_product;

  elsif v_prod_id is not null then
    -- payload 沒帶 "product"，但這場活動已經有商品：文案仍然要跟著活動走，否則
    -- 改了活動標題，購物車裡還是舊的那一行。價格與上下架狀態**不動** —— 那兩個
    -- 是商品自己的決定，不是活動的屬性。
    update public.products p
       set slug        = public.event_product_slug(v_event.slug),
           title       = v_event.title,
           summary     = v_event.summary,
           description = v_event.summary,
           image_key   = v_event.image_key,
           show_seats_remaining = v_event.show_seats_remaining
     where p.id = v_prod_id
    returning * into v_product;
  end if;

  -- ── 場次 ───────────────────────────────────────────────────────────────
  if v_sess is not null and jsonb_typeof(v_sess) = 'object' then
    if v_product.id is null then
      raise exception 'admin_upsert_event_with_session: 要建場次就得先有商品 —— payload 缺少 "product"（場次掛在 products.id 上，見 0020）';
    end if;
    if (v_sess ->> 'capacity') is null then
      raise exception 'admin_upsert_event_with_session: session.capacity 不可為空（名額的唯一真相在場次上）';
    end if;

    v_sess_id := nullif(trim(coalesce(v_sess ->> 'id', '')), '')::uuid;

    if v_sess_id is null then
      insert into public.event_sessions (
        product_id, title, location, starts_at, ends_at, capacity, status, sort_order
      )
      values (
        v_product.id,
        v_sess -> 'title',
        v_sess -> 'location',
        (v_sess ->> 'starts_at')::timestamptz,
        nullif(trim(coalesce(v_sess ->> 'ends_at', '')), '')::timestamptz,
        (v_sess ->> 'capacity')::integer,
        coalesce(nullif(trim(coalesce(v_sess ->> 'status', '')), ''), 'closed'),
        coalesce((v_sess ->> 'sort_order')::integer, 0)
      )
      returning * into v_session;
    else
      -- ⚠️ seats_taken **不在**這裡更新。它由 reserve_session_seat() /
      --    release_session_seat() 在持有列鎖時維護（0020 §7），從表單寫回一個
      --    幾分鐘前讀到的計數器就是與那支 RPC 對撞。
      update public.event_sessions s
         set title      = v_sess -> 'title',
             location   = v_sess -> 'location',
             starts_at  = (v_sess ->> 'starts_at')::timestamptz,
             ends_at    = nullif(trim(coalesce(v_sess ->> 'ends_at', '')), '')::timestamptz,
             capacity   = (v_sess ->> 'capacity')::integer,
             status     = coalesce(nullif(trim(coalesce(v_sess ->> 'status', '')), ''), s.status),
             sort_order = coalesce((v_sess ->> 'sort_order')::integer, s.sort_order)
       where s.id = v_sess_id
         and s.product_id = v_product.id
      returning * into v_session;

      if v_session.id is null then
        raise exception 'admin_upsert_event_with_session: 找不到 session % （或它不屬於這場活動的商品）', v_sess_id;
      end if;
    end if;
  end if;

  select count(*)::integer into v_count
    from public.event_sessions s
   where v_product.id is not null
     and s.product_id = v_product.id;

  return jsonb_build_object(
    'event',         to_jsonb(v_event),
    'product',       case when v_product.id is null then null else to_jsonb(v_product) end,
    'session',       case when v_session.id is null then null else to_jsonb(v_session) end,
    'session_count', coalesce(v_count, 0)
  );
end;
$$;

-- ═══ §8 權限 ═══════════════════════════════════════════════════════════════
revoke execute on function public.journey_linked_event_id(text)            from public, anon, authenticated;
revoke execute on function public.journey_url_slug(text)                   from public, anon, authenticated;
revoke execute on function public.journey_url_external(text)               from public, anon, authenticated;
revoke execute on function public.events_orphan_journeys()                 from public, anon, authenticated;
revoke execute on function public.listing_status_to_product_status(text)   from public, anon, authenticated;
revoke execute on function public.events_derive_published()                from public, anon, authenticated;
revoke execute on function public.events_sync_listing_status()             from public, anon, authenticated;
revoke execute on function public.products_pull_listing_status()           from public, anon, authenticated;
revoke execute on function public.journeys_pull_listing_status()           from public, anon, authenticated;
revoke execute on function public.event_listing_snapshot(text)             from public, anon, authenticated;
revoke execute on function public.admin_set_event_status(text, text)       from public, anon, authenticated;
revoke execute on function public.admin_set_journey_status(text, text)     from public, anon, authenticated;
revoke execute on function public.admin_upsert_event_with_session(jsonb)   from public, anon, authenticated;

grant execute on function public.journey_linked_event_id(text)          to service_role;
grant execute on function public.journey_url_slug(text)                 to service_role;
grant execute on function public.journey_url_external(text)             to service_role;
grant execute on function public.listing_status_to_product_status(text) to service_role;
grant execute on function public.event_listing_snapshot(text)           to service_role;
grant execute on function public.admin_set_event_status(text, text)     to service_role;
grant execute on function public.admin_set_journey_status(text, text)   to service_role;
grant execute on function public.admin_upsert_event_with_session(jsonb) to service_role;

commit;

-- 驗證（套用後）：
--   select id, slug, status, is_published from public.events order by sort_order;
--   select public.event_listing_snapshot(id) from public.events;   -- consistent 全部 true
--   select id, status, is_published, public.journey_linked_event_id(external_url) from public.journeys;
