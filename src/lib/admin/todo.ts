/**
 * 後台首頁「今日待辦」的純邏輯 —— 卡片長什麼樣、連到哪一頁、「7 天內」從哪裡算起。
 *
 * 不 import 任何 server 程式，scripts/admin-todo-selftest.mjs 直接用 Node 原生型別剝離
 * 載入這一份驗證（同 dashboard-revenue-selftest.mjs 的做法）。
 *
 * 數字本身由 src/server/repos/admin-todo.ts 查；這裡只決定怎麼呈現。count 為 null
 * 代表那一項查詢失敗 —— 畫面要說「讀取失敗」，**不可以**顯示成 0（0 的意思是「沒事」，
 * 查不到不等於沒事）。
 */

export type AdminTodoCounts = {
  /** 匯款、還沒收到錢、未封存（與 /admin/orders 預設分頁同一個條件）。 */
  transferPending: number | null;
  /** 已付款、處理中、宅配或超商、未封存（與 /admin/orders?scope=to_ship 同一個條件）。 */
  toShip: number | null;
  /** 還沒標記處理的賣超告警（與 /admin/stock-alerts 預設分頁同一個條件）。 */
  stockAlertsOpen: number | null;
  /** 待審核的商品。 */
  productsPending: number | null;
  /** 待審核的調價申請。 */
  priceChangesPending: number | null;
  /** 待審核的進貨。 */
  purchasesPending: number | null;
};

export type TodoCard = {
  key: keyof AdminTodoCounts;
  title: string;
  /** 點下去要去的後台頁。 */
  href:
    | "/admin/orders"
    | "/admin/stock-alerts"
    | "/admin/inventory-products"
    | "/admin/inventory-purchases";
  /** 點下去要帶的 search（目前只有「待出貨」用：/admin/orders?scope=to_ship）。 */
  search?: { scope: "to_ship" };
  count: number | null;
  /** 有幾筆時的說明，例如「筆訂單等你對帳」。 */
  unit: string;
  /** 0 筆時的說明。 */
  emptyText: string;
  /** 到了那一頁要做什麼（審核類頁面沒有預設篩選，要提示切到「待審核」）。 */
  hint?: string;
};

export function buildTodoCards(c: AdminTodoCounts): TodoCard[] {
  return [
    {
      key: "transferPending",
      title: "待收款的匯款訂單",
      href: "/admin/orders",
      count: c.transferPending,
      unit: "筆訂單等你核對匯款",
      emptyText: "沒有待收款的匯款訂單",
    },
    {
      key: "toShip",
      title: "待出貨",
      href: "/admin/orders",
      search: { scope: "to_ship" },
      count: c.toShip,
      unit: "筆已付款訂單等你出貨",
      emptyText: "沒有待出貨的訂單",
    },
    {
      key: "stockAlertsOpen",
      title: "未處理的賣超",
      href: "/admin/stock-alerts",
      count: c.stockAlertsOpen,
      unit: "筆賣超還沒處理",
      emptyText: "沒有未處理的賣超",
    },
    {
      key: "productsPending",
      title: "待審核的商品",
      href: "/admin/inventory-products",
      count: c.productsPending,
      unit: "件商品等你審核",
      emptyText: "沒有待審核的商品",
      hint: "到頁面後把「審核狀態」切到「待審核」",
    },
    {
      key: "priceChangesPending",
      title: "待審核的調價",
      href: "/admin/inventory-products",
      count: c.priceChangesPending,
      unit: "筆調價等你審核",
      emptyText: "沒有待審核的調價",
      hint: "到頁面後把「調價」切到「調價待審」",
    },
    {
      key: "purchasesPending",
      title: "待審核的進貨",
      href: "/admin/inventory-purchases",
      count: c.purchasesPending,
      unit: "筆進貨等你審核",
      emptyText: "沒有待審核的進貨",
      hint: "到頁面後把「審核狀態」切到「待審核」",
    },
  ];
}

/** 有事要做（> 0）的排前面；同一組內維持原本的順序。查詢失敗的視為有事。 */
export function sortTodoCards(cards: TodoCard[]): TodoCard[] {
  const needsAction = (card: TodoCard) => card.count === null || card.count > 0;
  return [...cards.filter(needsAction), ...cards.filter((card) => !needsAction(card))];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 台灣沒有日光節約時間，UTC+8 是固定的。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 「7 天內」的區間：台北今天 00:00 起算，往後 7 天（不含第 8 天的 00:00）。
 *
 * 從今天凌晨算而不是從「現在」算：今天早上已經開始、還在進行中的場次也是今天要顧的。
 * 回傳 ISO 字串直接拿去比 timestamptz。
 */
export function taipeiWeekWindow(now: Date): { fromIso: string; toIso: string } {
  const startOfTodayTaipei =
    Math.floor((now.getTime() + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
  return {
    fromIso: new Date(startOfTodayTaipei).toISOString(),
    toIso: new Date(startOfTodayTaipei + 7 * DAY_MS).toISOString(),
  };
}
