/**
 * Data layer for public.curated_themes + public.curated_items — used
 * exclusively by admin server functions.
 *
 * Every Supabase error is thrown, never swallowed — see src/server/repos/news.ts
 * for the full rationale (this file otherwise mirrors its shape). Rows are
 * returned exactly as Supabase returns them — snake_case columns, no
 * camelCase renaming.
 *
 * curated_items belongs to curated_themes (theme_id references
 * curated_themes.id on delete cascade — supabase/migrations/0001_init.sql:309-322),
 * so it is intentionally kept in this one file rather than split out: an item
 * never makes sense outside the context of its theme.
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const THEME_COLUMNS = "id, title, description, is_published, sort_order, created_at, updated_at";
const ITEM_COLUMNS = "id, theme_id, name, note, is_published, sort_order, created_at, updated_at";

export type CuratedThemeRow = {
  id: string;
  title: Localized;
  description: Localized;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertCuratedTheme. `id` omitted (or empty) means "create". */
export type CuratedThemeUpsertInput = {
  id?: string;
  title: Localized;
  description: Localized;
  is_published: boolean;
  sort_order: number;
};

export type CuratedItemRow = {
  id: number;
  theme_id: string;
  name: Localized;
  note: Localized;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertCuratedItem. `id` omitted means "create". */
export type CuratedItemUpsertInput = {
  id?: number;
  theme_id: string;
  name: Localized;
  note: Localized;
  is_published: boolean;
  sort_order: number;
};

export async function listCuratedThemes(): Promise<CuratedThemeRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("curated_themes")
    .select(THEME_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/curated] listThemes 失敗：${error.message}`);
  return (data ?? []) as CuratedThemeRow[];
}

export async function getCuratedThemeById(id: string): Promise<CuratedThemeRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("curated_themes")
    .select(THEME_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/curated] getThemeById 失敗：${error.message}`);
  return (data as CuratedThemeRow | null) ?? null;
}

/**
 * Creates or updates a theme. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. curated_themes.id has no DB default
 * (plain `text primary key`, not identity — supabase/migrations/0001_init.sql:295-305),
 * so id generation happens here, same as news.ts.
 */
export async function upsertCuratedTheme(input: CuratedThemeUpsertInput): Promise<CuratedThemeRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("curated_themes")
    .upsert(
      {
        id,
        title: input.title,
        description: input.description,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(THEME_COLUMNS)
    .single();

  if (error) throw new Error(`[repo/curated] upsertTheme 失敗：${error.message}`);
  return data as CuratedThemeRow;
}

/**
 * Deletes a theme. curated_items.theme_id has `on delete cascade`, so every
 * item under this theme is removed by Postgres in the same statement — no
 * separate item cleanup needed here.
 */
export async function removeCuratedTheme(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("curated_themes").delete().eq("id", id);
  if (error) throw new Error(`[repo/curated] removeTheme 失敗：${error.message}`);
}

export async function listCuratedItemsByTheme(themeId: string): Promise<CuratedItemRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("curated_items")
    .select(ITEM_COLUMNS)
    .eq("theme_id", themeId)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/curated] listItems 失敗：${error.message}`);
  return (data ?? []) as CuratedItemRow[];
}

/** Supabase PostgREST 的 db-max-rows 預設值。 */
const SUPABASE_MAX_ROWS = 1000;

/**
 * 好幾個主題的選品一次讀回來（後台商品頁用；原本是每個主題各打一支 fn，N+1）。
 * 回傳順序跟「照 themeIds 的順序逐一呼叫 listCuratedItemsByTheme() 再接起來」完全一樣：
 * 主題照傳入順序，主題內 sort_order、id 由小到大。
 */
export async function listCuratedItemsByThemes(
  themeIds: readonly string[],
): Promise<CuratedItemRow[]> {
  if (themeIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("curated_items")
    .select(ITEM_COLUMNS)
    .in("theme_id", [...themeIds])
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .limit(5000);

  if (error) throw new Error(`[repo/curated] listItems 失敗：${error.message}`);
  const rows = (data ?? []) as CuratedItemRow[];
  // PostgREST 的 db-max-rows（Supabase 預設 1000）會蓋過 .limit()。合併成一次查詢之後，上限從
  // 「每個主題 1000」變成「全部加起來 1000」——碰到上限就退回原本一個主題一次，不靜默截斷。
  if (rows.length >= SUPABASE_MAX_ROWS) {
    return (await Promise.all(themeIds.map((id) => listCuratedItemsByTheme(id)))).flat();
  }
  const byTheme = new Map<string, CuratedItemRow[]>();
  for (const row of rows) {
    const key = String(row.theme_id);
    const list = byTheme.get(key);
    if (list) list.push(row);
    else byTheme.set(key, [row]);
  }
  return themeIds.flatMap((id) => byTheme.get(String(id)) ?? []);
}

export async function getCuratedItemById(id: number): Promise<CuratedItemRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("curated_items")
    .select(ITEM_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/curated] getItemById 失敗：${error.message}`);
  return (data as CuratedItemRow | null) ?? null;
}

/**
 * Creates or updates an item. Unlike curated_themes/news, curated_items.id is
 * `bigint generated always as identity` (supabase/migrations/0001_init.sql:309-322)
 * — it has no client-assignable default, and Postgres rejects an explicit id
 * on insert unless OVERRIDING SYSTEM VALUE is used. So this cannot be a single
 * upsert() the way the text-PK tables are: creation must omit `id` entirely
 * and let the identity sequence assign it, hence the branch below.
 *
 * `sort_order` is deliberately excluded from the update branch below and only
 * ever appears in the insert branch (appending past the current max for the
 * theme — see route: nextItemSortOrder). This is not just "accepted as-is":
 * curated_items has UNIQUE(theme_id, sort_order), and changing display order
 * after creation goes exclusively through
 * reorderCuratedItems/admin_reorder_curated_items — never a per-row UPDATE
 * here, which could collide with a sibling row mid-flight. Keeping
 * sort_order out of the UPDATE statement entirely (rather than "pass the
 * unchanged value through") means there is no code path in this file that
 * writes sort_order for an existing row outside that RPC.
 */
export async function upsertCuratedItem(input: CuratedItemUpsertInput): Promise<CuratedItemRow> {
  if (input.id != null) {
    const { data, error } = await supabaseAdmin()
      .from("curated_items")
      .update({
        theme_id: input.theme_id,
        name: input.name,
        note: input.note,
        is_published: input.is_published,
      })
      .eq("id", input.id)
      .select(ITEM_COLUMNS)
      .single();

    if (error) throw new Error(`[repo/curated] updateItem 失敗：${error.message}`);
    return data as CuratedItemRow;
  }

  const { data, error } = await supabaseAdmin()
    .from("curated_items")
    .insert({
      theme_id: input.theme_id,
      name: input.name,
      note: input.note,
      is_published: input.is_published,
      sort_order: input.sort_order,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error) throw new Error(`[repo/curated] insertItem 失敗：${error.message}`);
  return data as CuratedItemRow;
}

export async function removeCuratedItem(id: number): Promise<void> {
  const { error } = await supabaseAdmin().from("curated_items").delete().eq("id", id);
  if (error) throw new Error(`[repo/curated] removeItem 失敗：${error.message}`);
}

/**
 * Reorders items within a theme via the admin_reorder_curated_items RPC —
 * NEVER a per-row UPDATE sort_order. curated_items has
 * UNIQUE(theme_id, sort_order) (supabase/migrations/0001_init.sql:321);
 * updating rows one at a time toward their final positions collides with that
 * constraint mid-flight (23505), most obviously when swapping two adjacent
 * rows. The RPC parks affected rows at negative sort_order first and writes
 * final positions in one transaction — see
 * supabase/migrations/0002_admin.sql:102-125. Already verified against six
 * fully-reversed rows with no violation.
 *
 * `ids` is the full list of item ids for the theme in the desired display
 * order; array position becomes the new sort_order (1-based).
 */
export async function reorderCuratedItems(themeId: string, ids: number[]): Promise<void> {
  const { error } = await supabaseAdmin().rpc("admin_reorder_curated_items", {
    p_theme_id: themeId,
    p_ids: ids,
  });

  if (error) throw new Error(`[repo/curated] reorderItems 失敗：${error.message}`);
}
