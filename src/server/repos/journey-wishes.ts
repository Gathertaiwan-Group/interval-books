/**
 * public.journey_wishes（0046）—— 策旅願望表單的收件匣（通用，source 分辨來源頁）。
 *
 * 兩種呼叫端：
 *   · src/server/journey-wish.ts（公開表單送出）：insertWish → 寄信 → recordWishEmailResult。
 *   · src/lib/admin/fns/journey-wishes.ts（後台，adminFnMiddleware 擋在前面）：其餘全部。
 *
 * 每一個 Supabase 錯誤都丟出去，由呼叫端決定要不要吞。回傳的列保持 snake_case。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { WishFormValues } from "@/lib/journey-wish";
import type { WishStatus } from "@/lib/journey-wish-inbox";
import type { Lang } from "@/i18n/types";

const TABLE = "journey_wishes";

const LIST_COLUMNS =
  "id, created_at, updated_at, source, interests, wish, name, email, join_friends, notify_opt_in, status, email_status";
const DETAIL_COLUMNS = `${LIST_COLUMNS}, lang, page_url, email_id, email_error, admin_note`;

/** 一次最多讀幾筆。畫面提示用的上限，不是分頁。 */
export const WISH_LIST_LIMIT = 500;

export type WishListRow = {
  id: string;
  created_at: string;
  updated_at: string;
  source: string;
  interests: string[];
  wish: string;
  name: string;
  email: string;
  join_friends: boolean;
  notify_opt_in: boolean;
  status: WishStatus;
  email_status: "pending" | "sent" | "failed";
};

export type WishDetailRow = WishListRow & {
  lang: Lang;
  page_url: string;
  email_id: string | null;
  email_error: string | null;
  admin_note: string;
};

export async function insertWish(
  values: WishFormValues,
  meta: { lang: Lang; pageUrl: string },
): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .insert({
      source: values.source,
      interests: values.interests,
      wish: values.wish,
      name: values.name,
      email: values.email,
      join_friends: values.joinFriends,
      notify_opt_in: values.notifyOptIn,
      lang: meta.lang,
      page_url: meta.pageUrl.slice(0, 300),
    })
    .select("id")
    .single();
  if (error || !data)
    throw new Error(`[repo/journey-wishes] insert 失敗：${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

export async function recordWishEmailResult(
  id: string,
  result: { status: "sent" | "failed"; emailId: string | null; error: string | null },
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from(TABLE)
    .update({
      email_status: result.status,
      email_id: result.emailId,
      email_error: result.error ? result.error.slice(0, 500) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`[repo/journey-wishes] 寫回寄信結果失敗：${error.message}`);
}

export async function listWishes(status: WishStatus | "all"): Promise<WishListRow[]> {
  let q = supabaseAdmin().from(TABLE).select(LIST_COLUMNS);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(WISH_LIST_LIMIT);
  if (error) throw new Error(`[repo/journey-wishes] list 失敗：${error.message}`);
  return (data ?? []) as WishListRow[];
}

/** 各狀態的筆數（分頁籤上的數字；new 就是「未處理」徽章）。 */
export async function countWishes(): Promise<Record<WishStatus, number>> {
  const out: Record<WishStatus, number> = { new: 0, reviewed: 0, archived: 0 };
  await Promise.all(
    (Object.keys(out) as WishStatus[]).map(async (s) => {
      const { count, error } = await supabaseAdmin()
        .from(TABLE)
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      if (error) throw new Error(`[repo/journey-wishes] count 失敗：${error.message}`);
      out[s] = count ?? 0;
    }),
  );
  return out;
}

export async function getWish(id: string): Promise<WishDetailRow | null> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[repo/journey-wishes] get 失敗：${error.message}`);
  return (data as WishDetailRow | null) ?? null;
}

export async function updateWish(
  id: string,
  patch: { status: WishStatus; admin_note: string },
): Promise<WishDetailRow> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(DETAIL_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`[repo/journey-wishes] update 失敗：${error.message}`);
  if (!data) throw new Error("找不到這筆旅程願望，可能已被刪除。");
  return data as WishDetailRow;
}
