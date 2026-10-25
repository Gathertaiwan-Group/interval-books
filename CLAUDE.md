# 小時光書店 Interval Books — 給接手的人

## 🔴 活動與策旅頁面：版面可以自由做，報名與金流一律用既有的那一套

**這是一條長期規則，不是某一期的決定。**

之後每一個活動（events）或策旅（journeys）的頁面，版面／文案／視覺會用 prompt 另外
指定，那部分怎麼設計都可以 —— 獨立著陸頁、自訂英雄區、自訂章節，都行。

**但「報名」與「收錢」這兩件事，一律接站上已經做好的那一套，不准另外做。**

### 既有的那一套是什麼

```
products (product_type='event' 或 'journey', price)
   └── event_sessions (梯次：時間、地點、capacity、seats_taken)
          └── event_session_plans (票種／價格方案：0036)
   ↓  前台選場次 → 選票種 → 選人數
/checkout  （directCheckoutSearch → resolveDirectCheckout）
   ↓
orders + order_items  →  reserve_session_seat() / reserve_plan_units()
   ↓
event_registrations   ←── /admin/registrations 看得到名單
```

前台要用的共用元件與 helper（**直接用，不要複製**）：

| 用途 | 從哪裡拿 |
|---|---|
| 場次選擇 | `SessionPicker` / `SessionList`（`@/components/shop/SessionPicker`） |
| 票種選擇 | `PlanPicker`（`@/components/shop/PlanPicker`） |
| 人數 | `QuantityStepper`（`@/components/shop/ShopBits`） |
| 商品查詢 | `fetchActiveProductForEventSlug(slug)`（`@/lib/shop`） |
| 數量上限 | `directSeatLimit(product, session, plan)`（`@/lib/direct-checkout`） |
| 去結帳的參數 | `directCheckoutSearch(product, session, qty, plan)` |

`src/routes/events.city-salon-0922.tsx` 是照這條規則做的範例：版面完全自訂，報名區
只組裝上面那幾個東西。

### 🔴 絕對不要做的事

1. **不要為某一場活動另開一張報名表。** 2026-09-09 做過一次（`salon_rsvps`，
   0037 建、0038 刪）。當時的理由是那一場是不收錢的審核邀請制，塞進
   `event_registrations` 要生假訂單、要在回覆當下就佔掉名額——那個判斷在「回條」的
   框架下是對的，但它換掉了更重要的東西：**名單不在後台**。
   `/admin/registrations` 已經有逐位參加者與聯絡方式（會留查閱紀錄）、CSV 匯出、單筆移除；
   自製的表一個都沒有，只能下 SQL 看。**多幾個欄位，不值得整套名單工具。**

2. **不要自己算座位數字。** 數量上限一律問 `directSeatLimit()`（它轉給
   `cartInputFor()`，與購物車同一行程式）。自己算就會出現「頁面說可以買 5、
   場次只剩 1」。`seats_taken` / `units_taken` 只能由那三支加鎖 RPC 維護。

3. **不要另接金流。** 付款走既有的結帳流程（PayUni／匯款／免費）。免費場次把商品
   `price` 設 0 即可——0028 的 `settle_free_order()` 會把 `total=0` 的訂單當場結清，
   不會被 `expire_unpaid_orders()` 當成未付款回收。

### 需要額外欄位的時候

結帳頁本來就有給客人填的**備註**（`orders.note`，最多 500 字，後台訂單詳情看得到）。
服務單位、職稱、期待探討的題目這類，先想想能不能併進備註。真的需要獨立欄位，就加在
`event_registrations` 上讓後台一起看得到，**不要另開一張表**。

---

## 環境

**本機一定要用 Node 24。** 系統的 node 是 v22.14.0，直接跑會壞兩層：`npm ci` 失敗
（lockfile 是 npm 11 產的），以及 `scripts/*-selftest.mjs` 直接 import `.ts` 靠原生
型別剝離、那功能 22.18 才預設開啟——在 22.14 上 8 支測試檔整支拋錯，case 數從 4978
掉到 2734，畫面上看起來只是「幾支紅的」。

```bash
cd ~/Gihub/小時光 && . ./env.sh   # 未進版控，設好 PATH 與 npm cache
```

CI 的四道關卡（跟 GitHub Actions 上跑的一致）：

```bash
npm test && npm run lint && ./node_modules/.bin/tsc --noEmit && npm run check:meta
```

## Migration

**只准新增，不准改既有的。** 新增之後一定要在 `scripts/lib/migration-ledger.mjs`
補一列，`touches` 要**實際掃過剝掉註解的 SQL** 算出來，不是憑印象填。

⚠️ 反少報偵測器剝掉的是 `--` 註解，**`comment on … is '…'` 的字串常值它照掃**。
在那裡提到別區的表名，會讓這支 migration 被判定成動了那一區，把一堆自檢叫回來重審。
說明寫在 `--` 區塊裡。

⚠️ 程式碼**不可以早於 migration 上線**。`src/server/repos/events.ts` 被
「先 select 了還沒 migrate 的欄位」弄壞過三次，PostgREST 的 42703 會讓整個後台頁掛掉。
