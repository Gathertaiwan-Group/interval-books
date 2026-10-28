/**
 * public.partnership_inquiries（0042）—— 異業合作表單的收件匣。
 *
 * 兩種呼叫端：
 *   · src/server/partnership.ts（公開表單送出）：insertInquiry → 寄信 → recordEmailResult。
 *   · src/lib/admin/fns/partnerships.ts（後台，adminFnMiddleware 擋在前面）：其餘全部。
 *
 * 每一個 Supabase 錯誤都丟出去（同 repos/news.ts 的理由），由呼叫端決定要不要吞。
 * 回傳的列保持 snake_case，與其他 repo 一致。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { PartnershipFormValues } from "@/lib/partnership";
import type { InquiryStatus } from "@/lib/partnership-inbox";
import type { Lang } from "@/i18n/types";

const TABLE = "partnership_inquiries";

const LIST_COLUMNS =
  "id, created_at, updated_at, type, company, contact_name, email, phone, budget, timeframe, status, email_status";
const DETAIL_COLUMNS = `${LIST_COLUMNS}, website, message, lang, page_url, email_id, email_error, admin_note`;

/** 一次最多讀幾筆。合作邀約一個月幾筆到幾十筆；這是畫面提示用的上限，不是分頁。 */
export const INQUIRY_LIST_LIMIT = 500;

export type InquiryListRow = {
  id: string;
  created_at: string;
  updated_at: string;
  type: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  budget: string;
  timeframe: string;
  status: InquiryStatus;
  email_status: "pending" | "sent" | "failed";
};

export type InquiryDetailRow = InquiryListRow & {
  website: string;
  message: string;
  lang: Lang;
  page_url: string;
  email_id: string | null;
  email_error: string | null;
  admin_note: string;
};

export async function insertInquiry(
  values: PartnershipFormValues,
  meta: { lang: Lang; pageUrl: string },
): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .insert({
      type: values.type,
      company: values.company,
      contact_name: values.contactName,
      email: values.email,
      phone: values.phone,
      website: values.website,
      timeframe: values.timeframe,
      budget: values.budget,
      message: values.message,
      lang: meta.lang,
      page_url: meta.pageUrl.slice(0, 300),
    })
    .select("id")
    .single();
  if (error || !data)
    throw new Error(`[repo/partnership] insert 失敗：${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

export async function recordEmailResult(
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
  if (error) throw new Error(`[repo/partnership] 寫回寄信結果失敗：${error.message}`);
}

export async function listInquiries(status: InquiryStatus | "all"): Promise<InquiryListRow[]> {
  let q = supabaseAdmin().from(TABLE).select(LIST_COLUMNS);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(INQUIRY_LIST_LIMIT);
  if (error) throw new Error(`[repo/partnership] list 失敗：${error.message}`);
  return (data ?? []) as InquiryListRow[];
}

/** 各狀態的筆數（分頁籤上的數字；new 就是「未處理」徽章）。 */
export async function countInquiries(): Promise<Record<InquiryStatus, number>> {
  const out: Record<InquiryStatus, number> = { new: 0, replied: 0, archived: 0 };
  await Promise.all(
    (Object.keys(out) as InquiryStatus[]).map(async (s) => {
      const { count, error } = await supabaseAdmin()
        .from(TABLE)
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      if (error) throw new Error(`[repo/partnership] count 失敗：${error.message}`);
      out[s] = count ?? 0;
    }),
  );
  return out;
}

export async function getInquiry(id: string): Promise<InquiryDetailRow | null> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[repo/partnership] get 失敗：${error.message}`);
  return (data as InquiryDetailRow | null) ?? null;
}

export async function updateInquiry(
  id: string,
  patch: { status: InquiryStatus; admin_note: string },
): Promise<InquiryDetailRow> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(DETAIL_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`[repo/partnership] update 失敗：${error.message}`);
  if (!data) throw new Error("找不到這筆合作邀約，可能已被刪除。");
  return data as InquiryDetailRow;
}
