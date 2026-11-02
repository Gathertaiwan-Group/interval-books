/**
 * Data layer for public.journeys — used exclusively by admin server
 * functions. Same conventions as src/server/repos/news.ts: every Supabase
 * error is thrown, never swallowed, and rows are returned exactly as
 * Supabase returns them — snake_case columns, no camelCase renaming.
 *
 * Unlike exhibitions, journeys has no image_key column — the public site
 * renders every journey card with the same static bundled image, so the
 * admin form for this resource has no image field.
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import type { ListingStatus } from "@/lib/listing-status";

const COLUMNS =
  "id, title, summary, description, days, theme, external_url, registration_type, payment_enabled, is_published, status, sort_order, created_at, updated_at";

export type JourneyRow = {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** Short duration text, e.g. { zh: "3 天 2 夜", en: "3 days · 2 nights", ja: "2泊3日" }. */
  days: Localized;
  /** Short theme-keyword text, e.g. { zh: "山、海、人情", ... }. */
  theme: Localized;
  external_url: string;
  /** DB CHECK constraint limits this to exactly these two values (supabase/migrations/0001_init.sql:259). */
  registration_type: "external" | "internal";
  payment_enabled: boolean;
  /** 🔴 0052：衍生值（= status === "live"），trigger 維護，程式不寫。 */
  is_published: boolean;
  /**
   * 0052：卡片的上架狀態。連得上活動（external_url 指向 /events/<slug>）的卡片跟著
   * events.status（trigger 拉）；孤兒卡片才自己改（setJourneyStatus）。
   */
  status: ListingStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertJourney. `id` omitted (or empty) means "create". */
export type JourneyUpsertInput = {
  id?: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  days: Localized;
  theme: Localized;
  external_url: string;
  registration_type: "external" | "internal";
  payment_enabled: boolean;
  sort_order: number;
};

export async function listJourneys(): Promise<JourneyRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("journeys")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/journeys] list 失敗：${error.message}`);
  return (data ?? []) as JourneyRow[];
}

export async function getJourneyById(id: string): Promise<JourneyRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("journeys")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/journeys] getById 失敗：${error.message}`);
  return (data as JourneyRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. journeys.id has no DB default (a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:240-260), so id generation happens here,
 * same as src/server/repos/news.ts#upsertNews.
 */
export async function upsertJourney(input: JourneyUpsertInput): Promise<JourneyRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("journeys")
    .upsert(
      {
        id,
        title: input.title,
        summary: input.summary,
        description: input.description,
        days: input.days,
        theme: input.theme,
        external_url: input.external_url,
        registration_type: input.registration_type,
        payment_enabled: input.payment_enabled,
        // 0052：不寫 is_published／status。新增＝草稿；連得上活動的卡片由 trigger 跟著活動，
        //       孤兒卡片改狀態走 setJourneyStatus()。
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/journeys] upsert 失敗：${error.message}`);
  return data as JourneyRow;
}

export async function removeJourney(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("journeys").delete().eq("id", id);
  if (error) throw new Error(`[repo/journeys] remove 失敗：${error.message}`);
}

/** 0052：只給孤兒卡片（連不上任何活動）改狀態；連得上活動的卡片會被 RPC 拒絕。 */
export async function setJourneyStatus(
  journeyId: string,
  status: ListingStatus,
): Promise<{
  journey_id: string;
  status: ListingStatus;
  is_published: boolean;
  status_before: ListingStatus;
  changed: boolean;
}> {
  const { data, error } = await supabaseAdmin().rpc("admin_set_journey_status", {
    p_journey_id: journeyId,
    p_status: status,
  });
  if (error) throw new Error(`[repo/journeys] 改上架狀態失敗：${error.message}`);
  return data as {
    journey_id: string;
    status: ListingStatus;
    is_published: boolean;
    status_before: ListingStatus;
    changed: boolean;
  };
}
