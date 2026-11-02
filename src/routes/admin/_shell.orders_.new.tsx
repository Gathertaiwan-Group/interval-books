/**
 * /admin/orders/new —— 新增電話報名（0050）。
 *
 * 業主：「有些活動客人會打電話進來直接匯款跟完成報名，但網站上會沒有紀錄。」這一頁把
 * 那種報名補成正式的訂單＋報名紀錄（占名額、進名單、計入營收、收到款後自動開發票）。
 *
 * 入口：訂單列表右上、活動報名列表右上、場次名單頁（?sessionId= 帶入場次）。
 * loader 讀表單選項（getPhoneOrderFormOptions，adminFnMiddleware）；送出是
 * createPhoneOrderAdmin（adminFnMiddleware）。建好之後 replace 到這張訂單的內頁。
 */
import { createFileRoute } from "@tanstack/react-router";
import { PhoneOrderForm } from "@/components/admin/PhoneOrderForm";
import { isUuid } from "@/lib/admin/order-labels";
import { taipeiToday } from "@/lib/taipei-time";

type NewSearch = { sessionId?: string; from?: "roster" | "registrations" };

export const Route = createFileRoute("/admin/_shell/orders_/new")({
  validateSearch: (search: Record<string, unknown>): NewSearch => {
    const out: NewSearch = {};
    if (isUuid(search.sessionId)) out.sessionId = search.sessionId;
    if (search.from === "roster" || search.from === "registrations") out.from = search.from;
    return out;
  },
  loader: async () => {
    const { getPhoneOrderFormOptions } = await import("@/lib/admin/fns/phone-orders");
    // 「今天」在伺服器算一次（台北時間），免得 SSR 與瀏覽器的預設匯款日期不同而 hydration mismatch。
    return { products: await getPhoneOrderFormOptions(), today: taipeiToday() };
  },
  head: () => ({ meta: [{ title: "新增電話報名｜訂單｜小時光風土誌書店後台" }] }),
  component: PhoneOrderNewPage,
});

function PhoneOrderNewPage() {
  const { products, today } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const back =
    search.from === "roster" && search.sessionId
      ? { to: `/admin/registrations/${search.sessionId}`, label: "回報名名單" }
      : search.from === "registrations"
        ? { to: "/admin/registrations", label: "回活動報名" }
        : { to: "/admin/orders", label: "回訂單列表" };

  return (
    <PhoneOrderForm
      products={products}
      today={today}
      initialSessionId={search.sessionId ?? null}
      back={back}
      onCreated={async (orderId) => {
        await navigate({ to: "/admin/orders/$id", params: { id: orderId }, replace: true });
      }}
    />
  );
}
