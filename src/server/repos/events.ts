/**
 * Data layer for public.events — used exclusively by admin server functions.
 *
 * Mirrors src/server/repos/news.ts: every Supabase error is thrown, never
 * swallowed. A back office that silently returns null/empty on a permission
 * or connection error looks indistinguishable from "there is no data", and an
 * admin could believe a write succeeded when it never reached the database.
 * Callers (src/lib/admin/fns/events.ts) run behind adminFnMiddleware, which
 * already turns thrown errors into a rejected server-fn call the UI can show.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns,
 * no camelCase renaming — so what you see here matches
 * supabase/migrations/0001_init.sql:172-205 column-for-column, plus
 * `speaker_id`（0025）與 `slug` / `image_key`（0026）。
 *
 * ⚠️ **部署順序：0026 要先套上 live DB，才能推這個檔。** 下面的 COLUMNS 會 select
 *    slug 與 image_key；欄位還不存在時 PostgREST 回 42703，整個活動後台打不開。
 *    這個 repo 為了同一件事已經掛過一次（0025 的 speaker_id），那一次留下的降級
 *    程式碼在 0026 這一期連同它的護欄斷言一起刪掉了 —— 降級路徑會讓「migration
 *    沒套上」這件事變成一個安靜的次等狀態，而安靜正是上一次沒有人發現的原因。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import { EVENT_LIST_FIELDS } from "@/lib/event-blocks";
import type { Localized, LocalizedList } from "@/i18n/types";

/**
 * ⚠️ **部署順序（第二次）：0027 要先套上 live DB，才能推這一行。** 底下多出來的七個
 *    清單欄位是 0027 加的；欄位還不存在時 PostgREST 回 42703，整個活動後台打不開。
 *    與檔頭那一段（0026 的 slug / image_key）是同一件事，而且同樣**不做降級路徑** ——
 *    降級會讓「migration 沒套上」變成一個安靜的次等狀態。
 *
 * ⚠️ **部署順序（第三次）：0029 要先套上 live DB，才能推這一行。** 底下的
 *    show_seats_remaining 是 0029 加的，同一個 42703、同一個後果、同一個不做降級的
 *    決定。這是這個檔案第三次踩到同一條規則了 —— 加欄位的 migration 一律**先套庫、
 *    後推碼**。
 */
const COLUMNS =
  "id, slug, title, summary, description, display_date, iso_date, category, speaker_id, image_key, external_url, registration_type, payment_enabled, is_published, sort_order, highlights, suitable_for, not_suitable_for, takeaways, outline, includes, notes, show_seats_remaining, gallery_keys, created_at, updated_at";

/** products 的欄位，只取活動後台要顯示的那幾個。 */
const PRODUCT_COLUMNS = "id, slug, source_id, price, compare_at_price, status, sort_order";

export type EventRegistrationType = "external" | "internal";

export type EventRow = {
  id: string;
  /**
   * 網址代稱，/events/<slug>（supabase/migrations/0026_event_product_link.sql）。
   *
   * ⚠️ 0026 把它回填成 `id`，所以在那之前發出去的每一個網址仍然有效。**改這一欄
   *    會讓已經發出去的連結 404** —— /events/$slug 對「查無此活動」是真的回 404。
   */
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  /** Nullable in the DB and never populated by the original content (see
   * supabase/migrations/0001_init.sql:198) — phase-2 sorting field. */
  iso_date: string | null;
  /** FK -> event_categories.id, `on delete restrict` (see
   * supabase/migrations/0001_init.sql:182-183). */
  category: string;
  /**
   * 主講人。FK -> public.artists(id)，`on delete set null`（見
   * supabase/migrations/0025_event_speaker.sql）。NULL 代表這場沒有指定講者。
   *
   * ⚠️ 刪掉一位講者**不會**刪掉活動 —— 那個外鍵刻意不是 cascade。活動底下還掛著
   *    報名紀錄（0020）與訂單（0005），cascade 會把它們一起帶走。
   */
  speaker_id: string | null;
  /** 封面圖 key（0026）。NULL = 沒設，前台就不畫封面。會投影到 products.image_key。 */
  image_key: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
  /**
   * 前台要不要印出這場活動的「尚餘名額 N」（0029）。not null default true，所以讀
   * 出來永遠是一個 boolean；預設 true ＝ 維持 0029 之前的行為。
   *
   * 🔴 「已額滿」不受它影響 —— 那是「你報不了名」，跟「還剩幾位」不是同一件事。
   *
   * 這一欄會被投影到 products.show_seats_remaining（前台的讀取層只讀 products），
   * 兩邊由 0029 的兩個 trigger 保證不分岔。所以**不要**在商品後台再開一個同名欄位。
   */
  show_seats_remaining: boolean;
  /**
   * 活動頁的七個「一行一項」三語清單（0027）。**順序就是前台由上到下的順序**，
   * 唯一的名單在 src/lib/event-blocks.ts 的 EVENT_LIST_FIELDS。
   *
   * not null default 三個空陣列 —— 空陣列的意思是「前台這一塊不畫」，不是「還沒填」。
   * 所以這裡不是 `LocalizedList | null`，讀出來永遠是一個物件。
   */
  highlights: LocalizedList;
  suitable_for: LocalizedList;
  not_suitable_for: LocalizedList;
  takeaways: LocalizedList;
  outline: LocalizedList;
  includes: LocalizedList;
  notes: LocalizedList;
  /**
   * 活動相簿（0031）：一個有序的圖片 key 陣列，值的形狀與 image_key 同一個
   * 慣例。not null default 空陣列，讀出來永遠是一個陣列，不是
   * `string[] | null` —— 跟 highlights 等七個清單欄位同一條規則：空陣列＝
   * 前台這一塊不畫，不是「還沒填」。
   */
  gallery_keys: string[];
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertEvent. `id` omitted (or empty) means "create". */
export type EventUpsertInput = {
  id?: string;
  /** 省略／null 時用 id 當 slug —— 與 0026 的回填規則同一條。 */
  slug?: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  iso_date?: string | null;
  category: string;
  speaker_id?: string | null;
  image_key?: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
  /** 前台印不印「尚餘名額 N」（0029）。省略時：新增用 true，更新沿用舊值。 */
  show_seats_remaining?: boolean;
  /**
   * 活動相簿（0031）。省略＝這一欄不動（與 SQL 那一側 payload 沒帶
   * gallery_keys 時 coalesce 到 v_prev.gallery_keys 是同一條規則）；要清空
   * 相簿是一個看得見的動作，送一個空陣列。
   */
  gallery_keys?: string[];
  /**
   * 七個清單欄位（0027）。**省略某一欄 = 那一欄不動**，與 SQL 那一側的
   * `coalesce(v_ev -> '…', v_prev.…, c_empty_list)` 是同一條規則。要清空就送三個
   * 空陣列 —— 那是一個看得見的動作，跟「前端漏送一個 key」不是同一件事。
   *
   * ⚠️ **只有 upsertEventWithProduct() 寫得了這七欄。** upsertEvent() 只寫
   *    public.events 的固定欄位，刻意不碰它們（見那一支的檔頭）。
   */
  lists?: Partial<Record<EventListField, LocalizedList>>;
};

/** 0027 的七個清單欄位的欄位名。唯一的名單在 src/lib/event-blocks.ts。 */
export type EventListField = (typeof EVENT_LIST_FIELDS)[number];

export type ProductStatus = "draft" | "active" | "archived";

/** 一場活動對應到的那件商品，外加它有幾個場次。 */
export type EventProductRow = {
  id: string;
  slug: string;
  source_id: string;
  price: number;
  compare_at_price: number | null;
  status: ProductStatus;
  sort_order: number;
  /** public.event_sessions 掛在 products.id 上（0020），不是掛在 events.id 上。 */
  session_count: number;
};

/**
 * 一場場次，只取活動頁組裝器要顯示的那幾欄。
 *
 * ⚠️ 這是**唯讀的鏡子**。場次的新增／修改在報名那一頁（src/routes/admin/_shell.registrations.tsx），
 *    而 seats_taken 只由 0020 §7 的三支 RPC 在持有列鎖時維護 —— 從別的地方寫回一個
 *    幾分鐘前讀到的計數器就是超賣。
 */
export type EventSessionBrief = {
  id: string;
  title: Localized;
  location: Localized;
  starts_at: string;
  capacity: number;
  seats_taken: number;
  status: string;
};

/** 上架／改價時要送給 admin_upsert_event_with_session() 的那一段。 */
export type EventProductInput = {
  price: number;
  compare_at_price?: number | null;
  status: ProductStatus;
  sort_order?: number;
};

export async function listEvents(): Promise<EventRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/events] list 失敗：${error.message}`);
  return (data ?? []) as unknown as EventRow[];
}

export async function getEventById(id: string): Promise<EventRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/events] getById 失敗：${error.message}`);
  return (data as unknown as EventRow) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. events.id has no DB default (it is a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:175-176, same shape as news.id), so id
 * generation has to happen here rather than being left to Postgres.
 *
 * ⚠️ 這一支只寫 public.events，**不碰商品**。要同時上架，走
 *    upsertEventWithProduct() —— 那一條路是一個交易，而且投影規則
 *    （products.description ← events.summary）只住在 SQL 那一支函式裡。
 */
export async function upsertEvent(input: EventUpsertInput): Promise<EventRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();
  const isoDate = input.iso_date && input.iso_date.trim() ? input.iso_date.trim() : null;
  // slug 省略時回落到 id：與 0026 的回填規則同一條，所以新增的活動網址一開始就是
  // 它的 id，跟既有那六場長得一樣。
  const slug = input.slug && input.slug.trim() ? input.slug.trim() : id;

  const { data, error } = await supabaseAdmin()
    .from("events")
    .upsert(
      {
        id,
        slug,
        title: input.title,
        summary: input.summary,
        description: input.description,
        display_date: input.display_date,
        iso_date: isoDate,
        category: input.category,
        // 空字串（下拉選了「不指定」）與 undefined 一律寫回 NULL —— 空字串不是
        // 合法的 artists.id，送出去只會吃 23503。
        speaker_id: input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null,
        image_key: input.image_key && input.image_key.trim() ? input.image_key.trim() : null,
        external_url: input.external_url,
        registration_type: input.registration_type,
        payment_enabled: input.payment_enabled,
        is_published: input.is_published,
        sort_order: input.sort_order,
        // 0029：省略時 true（＝欄位預設）。這條路徑是 upsert 而不是 patch，漏掉這一欄
        // 會讓「沒送」變成 NULL 而撞上 NOT NULL，不是「沿用舊值」。
        // ⚠️ 這一支只寫 events；products 那一份由 0029 的
        //    events_seats_visibility_sync_product trigger 跟著改。
        show_seats_remaining: input.show_seats_remaining ?? true,
        // 0031：同一條「upsert 不是 patch」規則——省略時要用欄位預設（空陣列），
        // 不能讓「沒送」變成 NULL 撞上 NOT NULL。這一支不走 RPC，沒有 v_prev
        // 可以沿用，所以跟 show_seats_remaining 一樣落到欄位預設，不是「不動」。
        gallery_keys: input.gallery_keys ?? [],
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/events] upsert 失敗：${error.message}`);
  return data as unknown as EventRow;
}

/**
 * 建立／更新活動**並且**建立／更新它的商品，一個交易。
 *
 * 走 supabase/migrations/0026_event_product_link.sql 的
 * `admin_upsert_event_with_session(payload jsonb)`，而不是在這裡先寫 events 再寫
 * products。兩個理由：
 *
 *   1. **兩個 PostgREST 請求不是一個交易。** 第一個成功、第二個失敗，留下的是一場
 *      改好了但商品還是舊價格的活動，而畫面上會顯示「已儲存」。
 *   2. **投影規則只能有一個家。** products.description 取的是 events.summary（不是
 *      events.description），products.slug 是 `event-<events.slug>`。這兩條寫在 SQL
 *      函式裡，這裡就不會有第二份會分岔的抄本。
 *
 * payload 刻意是一個 jsonb 而不是二十個具名參數：`create or replace function` 不能
 * 改參數名或型別，加一個欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。理由的
 * 完整版在 0026 的檔頭。
 */
export async function upsertEventWithProduct(
  input: EventUpsertInput,
  product: EventProductInput | null,
): Promise<{ event: EventRow; product: EventProductRow | null }> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const payload = {
    event: {
      id,
      slug: input.slug && input.slug.trim() ? input.slug.trim() : id,
      title: input.title,
      summary: input.summary,
      description: input.description,
      display_date: input.display_date,
      iso_date: input.iso_date && input.iso_date.trim() ? input.iso_date.trim() : null,
      category: input.category,
      speaker_id: input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null,
      image_key: input.image_key && input.image_key.trim() ? input.image_key.trim() : null,
      external_url: input.external_url,
      registration_type: input.registration_type,
      payment_enabled: input.payment_enabled,
      is_published: input.is_published,
      sort_order: input.sort_order,
      // 0029。**沒給值的時候整個 key 都不放進去**（`...(cond ? {k:v} : {})`），與底下
      // 七個清單欄位同一條規則：SQL 那邊「payload 沒帶這個 key ＝ 這一欄不動」要在
      // 這裡就是字面上成立的，不是靠 JSON.stringify 順手丟掉 undefined 的副作用。
      ...(input.show_seats_remaining === undefined
        ? {}
        : { show_seats_remaining: input.show_seats_remaining }),
      // 0031：相簿。同一條「省略這個 key = SQL 那邊沿用 v_prev，不是清空」的
      // 規則，所以跟 show_seats_remaining 同一個寫法——沒給值時整個 key 都不
      // 放進去，不是放一個 undefined 讓 JSON.stringify 順手丟掉。
      ...(input.gallery_keys === undefined ? {} : { gallery_keys: input.gallery_keys }),
      // 0027 的七個清單欄位。**照 EVENT_LIST_FIELDS 逐欄展開，不是把整個 lists 物件
      // 攤進去** —— 攤進去的話，呼叫端多送一個不存在的 key 會安靜地跟著飛到 SQL 那邊，
      // 而那支 RPC 對它不認得的 key 是完全沉默的。
      //
      // ⚠️ 沒給值的那幾欄**整個 key 都不放進去**（不是放一個 undefined 讓
      //    JSON.stringify 順手丟掉）—— SQL 那邊的規則是「payload 沒帶這個 key ＝
      //    這一欄不動」，那句話要在這裡就是字面上成立的，而不是靠序列化的副作用。
      ...Object.fromEntries(
        EVENT_LIST_FIELDS.filter((f) => input.lists?.[f] !== undefined).map((f) => [
          f,
          input.lists?.[f],
        ]),
      ),
    },
    product: product
      ? {
          price: product.price,
          compare_at_price: product.compare_at_price ?? null,
          status: product.status,
          sort_order: product.sort_order ?? input.sort_order,
        }
      : null,
  };

  const { data, error } = await supabaseAdmin().rpc("admin_upsert_event_with_session", {
    payload,
  });

  if (error) throw new Error(`[repo/events] upsertEventWithProduct 失敗：${error.message}`);

  const result = (data ?? {}) as {
    event?: EventRow;
    product?: Omit<EventProductRow, "session_count"> | null;
    session_count?: number;
  };
  if (!result.event) {
    throw new Error("[repo/events] upsertEventWithProduct 失敗：RPC 沒有回傳 event");
  }

  return {
    event: result.event,
    product: result.product
      ? { ...result.product, session_count: result.session_count ?? 0 }
      : null,
  };
}

/**
 * 這場活動有幾個場次。
 *
 * ⚠️ 場次（public.event_sessions，0020）掛的是 **products.id**，不是 events.id。
 *    所以這裡是兩跳：先用 (source_type='event', source_id) 找到那件商品，再數它的
 *    場次。沒有商品就是 0 個場次 —— 不是錯誤，是「這場活動還沒上架」。
 *
 * maybeSingle() 在 0026 之後才是安全的：products 對活動來源有了唯一索引
 * （products_event_source_unique_idx），一場活動最多一件商品是資料庫層級的事實。
 * 在那之前這一行有可能吃 PGRST116。
 */
export async function countSessionsForEvent(eventId: string): Promise<number> {
  const { data: product, error: productError } = await supabaseAdmin()
    .from("products")
    .select("id")
    .eq("source_type", "event")
    .eq("source_id", eventId)
    .maybeSingle();

  if (productError) {
    throw new Error(`[repo/events] countSessionsForEvent 找商品失敗：${productError.message}`);
  }
  if (!product) return 0;

  const { count, error } = await supabaseAdmin()
    .from("event_sessions")
    .select("id", { count: "exact", head: true })
    .eq("product_id", (product as { id: string }).id);

  if (error) throw new Error(`[repo/events] countSessionsForEvent 失敗：${error.message}`);
  return count ?? 0;
}

/**
 * 這場活動目前排了哪幾場場次，**最近一場排在最前面**。
 *
 * 活動頁組裝器要用它回答一個問題：「這場活動的地點是哪裡」。地點不是 events 的欄位
 * （這個 schema 從 0001 起就沒有任何地址欄位），它是 **event_sessions.location** ——
 * 也就是說一場活動可以有兩個梯次辦在兩個地方，而組裝器上那一塊只是**鏡子**，顯示
 * 最近一場的地點，要改要去場次那一頁。
 *
 * 與 countSessionsForEvent() 同樣是兩跳（場次掛 products.id，不掛 events.id）。
 * 沒有商品 = 沒有場次，回空陣列，不是錯誤。
 */
export async function listSessionsForEvent(eventId: string): Promise<EventSessionBrief[]> {
  const { data: product, error: productError } = await supabaseAdmin()
    .from("products")
    .select("id")
    .eq("source_type", "event")
    .eq("source_id", eventId)
    .maybeSingle();

  if (productError) {
    throw new Error(`[repo/events] listSessionsForEvent 找商品失敗：${productError.message}`);
  }
  if (!product) return [];

  const { data, error } = await supabaseAdmin()
    .from("event_sessions")
    .select("id, title, location, starts_at, capacity, seats_taken, status")
    .eq("product_id", (product as { id: string }).id)
    .order("starts_at", { ascending: false });

  if (error) throw new Error(`[repo/events] listSessionsForEvent 失敗：${error.message}`);
  return (data ?? []) as unknown as EventSessionBrief[];
}

/**
 * 每一場活動對應到的那件商品，keyed by events.id。
 *
 * 活動列表那一欄要顯示「已上架／草稿／未上架」與場次數，一場一場問就是 N+1。
 * 這裡固定兩個查詢：一次撈完所有 source_type='event' 的商品，再一次撈完那些商品的
 * 場次然後在 JS 裡數。活動總數是個位數，這樣就夠了。
 */
export async function listEventProducts(): Promise<Record<string, EventProductRow>> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("source_type", "event");

  if (error) throw new Error(`[repo/events] listEventProducts 失敗：${error.message}`);

  const rows = (data ?? []) as unknown as Omit<EventProductRow, "session_count">[];
  const byEventId: Record<string, EventProductRow> = {};
  for (const row of rows) {
    if (!row.source_id) continue;
    byEventId[row.source_id] = { ...row, session_count: 0 };
  }

  const productIds = rows.map((r) => r.id);
  if (productIds.length === 0) return byEventId;

  const { data: sessions, error: sessionError } = await supabaseAdmin()
    .from("event_sessions")
    .select("product_id")
    .in("product_id", productIds);

  if (sessionError) {
    throw new Error(`[repo/events] listEventProducts 數場次失敗：${sessionError.message}`);
  }

  const counts: Record<string, number> = {};
  for (const s of (sessions ?? []) as { product_id: string }[]) {
    counts[s.product_id] = (counts[s.product_id] ?? 0) + 1;
  }
  for (const key of Object.keys(byEventId)) {
    byEventId[key].session_count = counts[byEventId[key].id] ?? 0;
  }
  return byEventId;
}

/**
 * 以 `prefix` 開頭、已經被用掉的代稱（活動的 slug，加上商品那一側 `event-` 之後的
 * 部分），給「一頁新增活動」挑一個不撞號的代稱用。
 *
 * 兩邊都查：events.slug 有唯一約束，products.slug 也有，而商品代稱是
 * `event-<活動代稱>` —— 只查活動那一側，撞到的會是一句看不懂的 23505。
 *
 * ⚠️ prefix 由呼叫端產生（YYYYMMDD），只含數字；這裡仍然把 LIKE 的萬用字元跳脫掉。
 */
export async function listTakenEventSlugs(prefix: string): Promise<string[]> {
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [events, products] = await Promise.all([
    supabaseAdmin().from("events").select("slug").ilike("slug", like),
    supabaseAdmin().from("products").select("slug").ilike("slug", `event-${like}`),
  ]);
  if (events.error)
    throw new Error(`[repo/events] listTakenEventSlugs 失敗：${events.error.message}`);
  if (products.error) {
    throw new Error(`[repo/events] listTakenEventSlugs 查商品失敗：${products.error.message}`);
  }
  return [
    ...((events.data ?? []) as { slug: string }[]).map((r) => r.slug),
    ...((products.data ?? []) as { slug: string }[]).map((r) => r.slug.replace(/^event-/, "")),
  ];
}

export async function removeEvent(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("events").delete().eq("id", id);
  if (error) throw new Error(`[repo/events] remove 失敗：${error.message}`);
}

/**
 * Returns how many events currently reference each category id (all events,
 * published or not — the DB's `on delete restrict` FK does not care about
 * is_published). Used by the event-categories admin page to disable "刪除"
 * up front on any category still in use, instead of letting an admin hit a
 * raw Postgres 23503 foreign-key-violation error after the fact.
 *
 * There is no cheap PostgREST "group by" query via supabase-js, and with a
 * handful of events total, fetching just the `category` column and counting
 * in JS is simpler and fast enough than adding an RPC function.
 */
export async function countEventsByCategory(): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin().from("events").select("category");
  if (error) throw new Error(`[repo/events] countEventsByCategory 失敗：${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { category: string }[]) {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
  }
  return counts;
}
