/**
 * 後台首頁「今日待辦」的資料 —— **只讀**，全部是 count 或小範圍 select。
 *
 * 每一個數字的條件都刻意與「點下去會到的那一頁」的預設篩選逐字相同，卡片上寫 3
 * 筆、點進去也要剛好看到 3 筆：
 *
 *   transferPending     ↔ repos/orders-admin.ts listAdminOrders({ scope: "transfer_pending" })
 *                          payment_method = 'transfer' and payment_status <> 'paid'
 *                          and archived_at is null
 *   stockAlertsOpen     ↔ repos/inv-sales.ts listStockAlerts("open")：resolved_at is null
 *   productsPending     ↔ repos/inv-products.ts approvalStatus = 'pending'
 *   priceChangesPending ↔ repos/inv-products.ts priceChange = 'pending'
 *   purchasesPending    ↔ repos/inv-purchases.ts approvalStatus = 'pending'
 *
 * ⚠️ 單一項查詢失敗**不讓整個首頁掛掉**（這是後台的落地頁），但也不吞成 0：
 *    回 null，畫面顯示「讀取失敗」。錯誤只印 code + message（同 orders-admin.ts：
 *    PostgREST 的 DETAIL 可能帶整列客人資料）。
 *
 * 授權在 src/lib/admin/fns/dashboard.ts 的 adminFnMiddleware，這一層假設呼叫端已檢查。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { AdminTodoCounts } from "@/lib/admin/todo";
import type { Localized } from "@/i18n/types";

type CountResult = PromiseLike<{
  count: number | null;
  error: { code?: string; message: string } | null;
}>;

async function safeCount(label: string, query: CountResult): Promise<number | null> {
  try {
    const { count, error } = await query;
    if (error) {
      console.error(`[repo/admin-todo] ${label} 失敗：${error.code ?? ""} ${error.message}`);
      return null;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[repo/admin-todo] ${label} 例外：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function getAdminTodoCounts(): Promise<AdminTodoCounts> {
  const db = supabaseAdmin();
  const head = { count: "exact" as const, head: true };

  const [transferPending, stockAlertsOpen, productsPending, priceChangesPending, purchasesPending] =
    await Promise.all([
      safeCount(
        "transferPending",
        db
          .from("orders")
          .select("id", head)
          .eq("payment_method", "transfer")
          .neq("payment_status", "paid")
          .is("archived_at", null),
      ),
      safeCount(
        "stockAlertsOpen",
        db.from("inv_stock_alerts").select("*", head).is("resolved_at", null),
      ),
      safeCount(
        "productsPending",
        db.from("inv_admin_products").select("*", head).eq("approval_status", "pending"),
      ),
      safeCount(
        "priceChangesPending",
        db.from("inv_admin_products").select("*", head).eq("price_change_status", "pending"),
      ),
      safeCount(
        "purchasesPending",
        db.from("inv_admin_purchases").select("*", head).eq("approval_status", "pending"),
      ),
    ]);

  return {
    transferPending,
    stockAlertsOpen,
    productsPending,
    priceChangesPending,
    purchasesPending,
  };
}

export type UpcomingSession = {
  id: string;
  title: string;
  productTitle: string;
  starts_at: string;
  capacity: number;
  seats_taken: number;
  status: string;
  /** 名單上已付款的人數；名單讀取失敗時為 null。 */
  paid: number | null;
  /** 名單上全部（含未付款）的人數；名單讀取失敗時為 null。 */
  total: number | null;
};

/**
 * [fromIso, toIso) 之間開始的場次，依開始時間排序，附上報名人數。
 *
 * 失敗回 null（同上，不讓首頁整頁掛掉、也不假裝「這週沒有場次」）。
 */
export async function listUpcomingSessions(
  fromIso: string,
  toIso: string,
): Promise<UpcomingSession[] | null> {
  const db = supabaseAdmin();
  try {
    const { data, error } = await db
      .from("event_sessions")
      .select("id, product_id, title, starts_at, capacity, seats_taken, status")
      .gte("starts_at", fromIso)
      .lt("starts_at", toIso)
      .order("starts_at", { ascending: true })
      .limit(50);
    if (error) {
      console.error(`[repo/admin-todo] sessions 失敗：${error.code} ${error.message}`);
      return null;
    }
    const sessions = (data ?? []) as {
      id: string;
      product_id: string;
      title: Localized;
      starts_at: string;
      capacity: number;
      seats_taken: number;
      status: string;
    }[];
    if (sessions.length === 0) return [];

    const productIds = [...new Set(sessions.map((s) => s.product_id))];
    // 報名人數直接借用 /admin/registrations 那一支（同一個 on_roster 定義，不自己再判斷
    // 一次付款狀態——見 scripts/roster-csv-selftest.mjs「誰在簽到表上只定義一次」）。
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    const [productsRes, counts] = await Promise.all([
      db.from("products").select("id, title").in("id", productIds),
      countRegistrationsBySession().catch((err: unknown) => {
        console.error(
          `[repo/admin-todo] 報名人數失敗：${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }),
    ]);

    const productTitle = new Map<string, string>();
    if (productsRes.error) {
      console.error(
        `[repo/admin-todo] products 失敗：${productsRes.error.code} ${productsRes.error.message}`,
      );
    } else {
      for (const p of (productsRes.data ?? []) as { id: string; title: Localized }[]) {
        productTitle.set(p.id, p.title?.zh ?? "");
      }
    }

    return sessions.map((s) => ({
      id: s.id,
      title: s.title?.zh ?? "",
      productTitle: productTitle.get(s.product_id) ?? "",
      starts_at: s.starts_at,
      capacity: s.capacity,
      seats_taken: s.seats_taken,
      status: s.status,
      paid: counts ? (counts[s.id]?.paid ?? 0) : null,
      total: counts ? (counts[s.id]?.total ?? 0) : null,
    }));
  } catch (err) {
    console.error(`[repo/admin-todo] sessions 例外：${err instanceof Error ? err.message : err}`);
    return null;
  }
}
