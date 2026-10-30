/**
 * 寄信的編排層：claim → 排信 → finish/fail，然後把 outbox 沖出去。
 *
 * ── 形狀逐字對應 src/server/invoice-issuer.ts ─────────────────────────────
 * 那個檔案已經把「付款之後要做一件會失敗的事」該長什麼樣子寫清楚了，這裡照抄：
 *
 *   1. claimOrderNotify()   —— 原子地宣告「這張的通知由我排」（0022 §8 的兩道閘門）
 *   2. 排信進 email_outbox   —— 只有拿到 claim 的人可以做這一步
 *   3. finish / fail        —— 一定要走到其中一個
 *
 * ── 為什麼這個檔案永不 throw ──────────────────────────────────────────────
 * 它跑在 PayUni webhook 的成功路徑上。docs/alignment-audit.md 與
 * invoice-issuer.ts:20-24 已經寫過同一件事：把會失敗的事塞進金流 webhook 的同步
 * 流程，那件事一掛就會讓 PayUni 收到 5xx 而**不斷重送同一則通知**。所以這裡的每
 * 一支公開函式回的都是一個可以忽略的結果物件，失敗留在 email_outbox 與
 * order_post_payment_log 裡等 backlog 收拾。
 *
 * ⚠️ scripts/notify-selftest.mjs 有一條靜態測試：**這個檔案裡不可以出現 `throw`。**
 *
 * ── 為什麼 claim 一定要在排信之前 ────────────────────────────────────────
 * 這一點比發票鬆得多（信重寄一次只是客人多收一封，發票開兩張要跑國稅局），但
 * claim 仍然值得：沒有它，一則被重送三次的 webhook 會讓「載入訂單 → 讀名單 →
 * 排信」跑三遍，而那是三倍的資料庫工作換同一個結果。真正的冪等保證在下面一層 ——
 * `email_outbox.dedupe_key` 是 unique，所以就算三次都跑完，信仍然只有一封。
 * **claim 省的是工，dedupe_key 保的是正確性。** 兩者不可互相取代。
 *
 * ── 信不帶發票號碼 ────────────────────────────────────────────────────────
 * 見 0022 檔頭 §0.3：發票那一步有 8 秒逾時保護，等它就等於讓 Amego 慢的時候
 * 信也不寄。
 *
 * ── 明文 email 不經過這個檔案 ────────────────────────────────────────────
 * 排信時送進資料庫的是 registration_id / order_id 與排好版的內容，地址由
 * 0022 §7 的 SQL 自己 join。這個檔案唯一碰得到地址的地方是 flushEmailOutbox()
 * 從 claimEmailBatch() 拿到的那一批 —— 而那是把信交給 Resend 必須的。
 *
 * ⚠️ **log 裡不准出現裸的收件地址**，一律走 maskEmail()。
 */
import "@tanstack/react-start/server-only";
import { sendEmail, emailConfigured } from "@/server/email";
import {
  claimEmailBatch,
  claimOrderNotify,
  enqueueAdminOrderEmail,
  enqueueOrderEmail,
  enqueueOrderEmailResult,
  enqueueRegistrationEmails,
  failEmail,
  failOrderNotify,
  finishEmail,
  finishOrderNotify,
  getOrderContactForAdminNotify,
  getOrderForNotify,
  getOrderForShippedEmail,
  getOrderPublicToken,
  getShopContactEmail,
  loadEmailCopy,
  loadOrderLocales,
  notifyBacklog,
  purgeSentEmailBodies,
  sessionsDueForReminder,
  EMAIL_FLUSH_BATCH,
  REMINDER_LEAD,
  type RegistrationMailItem,
} from "@/server/repos/email-outbox";
import {
  loadOrderAttendeesForAdminNotify,
  loadPaidRoster,
  loadPaidRosterByOrder,
} from "@/server/repos/event-registrations";
import { getEventSessionById } from "@/server/repos/event-sessions";
import { getRemittanceAccount } from "@/server/repos/site-settings";
import { publicUrlFor } from "@/server/public-url";
import {
  maskEmail,
  renderAdminOrderNotificationEmail,
  renderOrderPaidEmail,
  renderRegistrationTicketEmail,
  renderOrderShippedEmail,
  renderRemittanceEmail,
  renderSessionReminderEmail,
  type AdminOrderAttendee,
  type AdminOrderContact,
  type SessionBrief,
} from "@/lib/email-templates";
import { remittanceConfigured, remittanceDueAt } from "@/lib/checkout";
import type { Lang } from "@/i18n/types";

export type NotifyOutcome =
  | { ok: true; queued: number; adopted: boolean }
  | { ok: false; reason: string };

/** dedupe_key 的四種格式。**只在這裡組**，免得有第二個地方拼錯前綴。 */
export const dedupeKeys = {
  orderPaid: (orderId: string) => `order_paid:${orderId}`,
  registrationTicket: (registrationId: string) => `registration_ticket:${registrationId}`,
  sessionReminder: (sessionId: string, registrationId: string) =>
    `session_reminder:${sessionId}:${registrationId}`,
  /** 0032：店家的新訂單／新報名通知。一張訂單一封，跟 orderPaid 用同一個實體 id。 */
  orderNotifyAdmin: (orderId: string) => `order_notify_admin:${orderId}`,
  /** 0034：匯款資訊信（客人），下單當下寄。 */
  remittance: (orderId: string) => `remittance:${orderId}`,
  /**
   * 0034：店家的「有一筆待收款的新訂單」通知，**下單當下**寄。
   *
   * 🔴 前綴必須與 orderNotifyAdmin 不同。同一張匯款訂單會先走這裡（下單當下），
   *    店家對完帳標記已付款之後再走 orderNotifyAdmin（付款成功）——兩者共用 key
   *    的話，第二封會撞 dedupe_key 的 unique 變成 no-op，店家從此再也收不到任何
   *    一張匯款／待聯繫訂單的「已收款」通知，而 email_outbox 裡看起來一切正常
   *    （那一列確實存在，只是內容是三天前那封「有新單」）。見 0034 §0.6。
   *    scripts/notify-selftest.mjs 對真的 email_outbox 跑過這一條。
   */
  orderPlacedAdmin: (orderId: string) => `order_placed_admin:${orderId}`,
  /**
   * 出貨通知信（客人），後台「標記已出貨」（processing → shipped）**真的發生**的那
   * 一次才排。一張訂單一封：重按、重試、兩個分頁同時按，都撞這把 key 變成 no-op。
   */
  orderShipped: (orderId: string) => `order_shipped:${orderId}`,
};

// -----------------------------------------------------------------------------
// 店家通知信的「這是誰的單」（2026-10）
// -----------------------------------------------------------------------------

/**
 * 店家通知信要的訂購人資料、逐位參加者（明文，業主 2026-10-25 決定）、後台訂單連結
 * （/admin/orders/<id>；舊信的 ?order= 由列表頁轉址）。兩條店家信的路徑
 * （付款成功後／下單當下）共用。兩支 repo 都設計成讀失敗回 null／空 Map 而不丟例外；
 * 呼叫端仍然把整段包在自己的 try/catch 裡。
 *
 * 後台連結組不出來（SITE_URL 沒設）就是 null，信裡改寫「請登入後台查看」——不放一條
 * 連不到的連結（同匯款信的立場，見 public-url.ts）。
 */
async function loadAdminMailExtras(orderId: string): Promise<{
  contact: AdminOrderContact | null;
  attendees: Map<string, AdminOrderAttendee[]>;
  adminUrl: string | null;
}> {
  const [contact, attendees] = await Promise.all([
    getOrderContactForAdminNotify(orderId),
    loadOrderAttendeesForAdminNotify(orderId),
  ]);
  return {
    contact,
    attendees,
    adminUrl: publicUrlFor(`/admin/orders/${encodeURIComponent(orderId)}`),
  };
}

// -----------------------------------------------------------------------------
// 付款成功之後排信
// -----------------------------------------------------------------------------

/**
 * 一次把某張訂單該寄的信全部排進 outbox。**永不 throw。**
 *
 * 排幾封：訂購人 1 封（付款成功）＋ 店家 1 封（新訂單／新報名通知，0032，收件人
 * 是 site_settings.notify_emails，空白就安靜不排）＋ 這張訂單上每一位在簽到表上
 * 的參加者 1 封（報名成功）。只買書的訂單就是訂購人與店家各 1 封。
 *
 * 回傳 queued 是**這一次真的新增的列數**，重跑時會是 0（全部撞 dedupe_key），
 * 那是正常的，不是失敗。
 */
export async function queueOrderNotifications(orderId: string): Promise<NotifyOutcome> {
  const claim = await claimOrderNotify(orderId);
  if (!claim.claimed) {
    if (claim.reason === "already_sent") return { ok: true, queued: 0, adopted: true };
    // locked 是正常的併發結果，不值得吵；其餘都值得留紀錄（同 invoice-issuer.ts）。
    if (claim.reason !== "locked") {
      console.warn(`[notify] 未取得排信許可 order=${orderId} reason=${claim.reason}`);
    }
    return { ok: false, reason: claim.reason };
  }

  // 拿到 claim 之後，任何路徑都必須走到 finish 或 fail。
  try {
    return await queueWithClaim(orderId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 排信途中發生未預期例外 order=${orderId} ${message}`);
    await failOrderNotify(orderId, `unexpected: ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

async function queueWithClaim(orderId: string): Promise<NotifyOutcome> {
  const loaded = await getOrderForNotify(orderId);
  if (!loaded) {
    await failOrderNotify(orderId, "order_not_found");
    return { ok: false, reason: "order_not_found" };
  }
  const { order, items } = loaded;
  const lang = order.locale;
  const copy = await loadEmailCopy();

  // 這張訂單買到的場次。一張訂單可以買到兩個不同場次的位子，所以是一組。
  const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((s): s is string => !!s))];
  const sessions = await loadSessionBriefs(sessionIds);

  let queued = 0;

  // ---- 1. 訂購人的付款成功信 -------------------------------------------------
  // 先排這一封：它不依賴名單，所以名單那一步就算失敗，客人至少會收到「錢收到了」。
  // 之後 backlog 重跑時這一封會撞 dedupe_key 變成 no-op，不會寄第二次。
  const paidMail = renderOrderPaidEmail(
    {
      orderNo: order.orderNo,
      customerName: order.customerName,
      total: order.total,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
      sessions: sessionIds.map((id) => sessions.get(id)).filter((s): s is SessionBrief => !!s),
    },
    copy,
    lang,
  );
  const addedOrderMail = await enqueueOrderEmail({
    orderId,
    dedupeKey: dedupeKeys.orderPaid(orderId),
    subject: paidMail.subject,
    text: paidMail.text,
    html: paidMail.html,
  });
  if (addedOrderMail) queued += 1;

  // ---- 1.5 店家的新訂單／新報名通知（0032）------------------------------------
  // ⚠️ 整段包在自己的 try/catch 裡，**絕對不能讓店家信的任何失敗拖累客人的信**：
  //    上面訂購人的付款成功信已經排進去了，下面每一位參加者的報名成功信還沒排——
  //    這一段夾在中間，萬一 renderAdminOrderNotificationEmail() 或
  //    enqueueAdminOrderEmail() 丟出意外例外（不應該發生：兩者都設計成不 throw，
  //    但這裡按「防禦性」處理，不賭它們的實作永遠不變），try/catch 讓函式繼續往
  //    下跑到報名信的迴圈與 finishOrderNotify()，不會被這一段拖垮。
  //    店家信箱是空的（site_settings.notify_emails 沒設）不算失敗，是
  //    enqueue_admin_order_email() 內建的安靜跳過（0032 §2），這裡收到的就是
  //    普通的 false，不會進到 catch。
  try {
    // 場次的參加人數：這張訂單裡屬於同一個 session 的 item.quantity 加總。
    // ⚠️ 這是「這場買了幾個名額」，不是「簽到表上有幾筆」——不需要等下面的
    //    loadPaidRosterByOrder()，訂單的 order_items 就夠了。逐位參加者姓名另外由
    //    loadAdminMailExtras() 從 event_registrations 讀（明文，2026-10-25）。
    const sessionParticipants = new Map<string, number>();
    for (const it of items) {
      if (!it.sessionId) continue;
      sessionParticipants.set(
        it.sessionId,
        (sessionParticipants.get(it.sessionId) ?? 0) + it.quantity,
      );
    }
    const extras = await loadAdminMailExtras(orderId);
    const adminMail = renderAdminOrderNotificationEmail({
      // 0034：這條路永遠是「付款成功之後」——它跑在 claim_order_notify() 之內，
      // 而那道閘門的第一句就是「訂單必須已經結清」（0022 §8 閘門 1）。
      stage: "afterPayment",
      orderNo: order.orderNo,
      total: order.total,
      contact: extras.contact,
      adminUrl: extras.adminUrl,
      paymentMethod: order.paymentMethod,
      shippingMethod: order.shippingMethod,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
      sessions: sessionIds.flatMap((id) => {
        const session = sessions.get(id);
        if (!session) return [];
        return [
          {
            session,
            participants: sessionParticipants.get(id) ?? 0,
            attendees: extras.attendees.get(id) ?? [],
          },
        ];
      }),
    });
    const addedAdminMail = await enqueueAdminOrderEmail({
      dedupeKey: dedupeKeys.orderNotifyAdmin(orderId),
      subject: adminMail.subject,
      text: adminMail.text,
      html: adminMail.html,
    });
    if (addedAdminMail) queued += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 店家通知信排入失敗 order=${order.orderNo} ${message}`);
  }

  // ---- 2. 每一位參加者的報名成功信 -------------------------------------------
  // ⚠️ 用 loadPaidRosterByOrder()，不是自己寫一次付款狀態的條件。「誰在簽到表上」
  //    只定義在 0021 §3 的 view 裡（見那支 repo 的檔頭）。
  //
  // ⚠️ 這裡拿到的是**遮罩過的**列，沒有明文地址 —— 排信只送 registration_id
  //    進去，地址由 0022 §7 的 SQL join。
  if (sessionIds.length > 0) {
    const roster = await loadPaidRosterByOrder(orderId);
    const mails: RegistrationMailItem[] = [];
    for (const row of roster) {
      // 沒留信箱的參加者（0020 允許只留電話）連信都不用排。SQL 那一側也會擋，
      // 這裡先擋掉只是為了讓 queued 的數字對得起來。
      if (!row.has_email) continue;
      const session = sessions.get(row.session_id);
      if (!session) continue;
      const mail = renderRegistrationTicketEmail(
        {
          participantName: row.name,
          seatNo: row.seat_no,
          orderNo: row.order_no,
          session,
        },
        copy,
        lang,
      );
      mails.push({
        registrationId: row.registration_id,
        dedupeKey: dedupeKeys.registrationTicket(row.registration_id),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    }
    queued += await enqueueRegistrationEmails(mails);
  }

  const done = await finishOrderNotify(orderId);
  if (!done) {
    // 信已經排進 outbox 了，只是 claim 沒結掉。**絕不能當成失敗重排** ——
    // 重排也只會撞 dedupe_key，但這個狀態值得被看見：它代表 log 那一列不見了。
    console.error(`[notify] 🚨 已排信但結不掉 claim order=${order.orderNo} —— 需人工確認 log 列`);
  }
  console.info(`[notify] 已排信 order=${order.orderNo} queued=${queued}`);
  return { ok: true, queued, adopted: false };
}

// -----------------------------------------------------------------------------
// 下單當下排信（0034）—— 這個站第一條不在「付款成功之後」觸發的路徑
// -----------------------------------------------------------------------------

/**
 * 訂單成立當下該寄的信。**永不 throw。**
 *
 * 🔴 為什麼不能塞進 queueOrderNotifications()：那一支的第一句是 claimOrderNotify()，
 *    而它的閘門 1 就是 `payment_status <> 'paid' → order_not_paid`（0022 §8）。
 *    這裡要寄的兩封信的前提正好相反 —— **錢還沒進來**。放寬那道閘門是錯的修法：
 *    它守的是「沒收到錢不要告訴客人收到錢了」，這條規則沒有問題。所以這是第二條
 *    路，不是第一條路的例外。見 0034 §0.5。
 *
 * 排幾封（都是「有才排」，沒有就安靜跳過）：
 *   · payment_method = 'transfer' → 客人 1 封匯款資訊信
 *   · payment_method = 'transfer' 或 NULL（＝舊的「由我們與你聯繫付款」，0048 起結帳頁
 *     不再提供，只剩舊訂單）→ 店家 1 封「有一筆待收款的新訂單」
 *   · 0048：orders.needs_contact = true（匯款＋勾了「我需要專人聯繫協助付款」）時，
 *     客人那封在匯款資訊旁加「我們會盡快與你聯繫」，店家那封主旨與內文標「需聯繫」。
 *
 * 刷卡訂單不走這裡（它們有金流頁可以看，而店家的通知在付款成功之後由 0032 那條路
 * 寄）。免費訂單（total = 0）也不走這裡——它在 step 5b 就已經是 paid 了，該走的是
 * 付款成功那條路。
 *
 * 冪等：兩層。createOrder() 頂端的 idempotency_key replay 短路讓重送的結帳請求
 * 根本不會走到這裡；真的走到了，email_outbox.dedupe_key 的 unique 讓它變成 no-op。
 * 這與既有四封信是同一個保證，不是新機制。
 *
 * ⚠️ 這一支**沒有** claim。claim 在 0022 那條路上省的是「重送的 webhook 讓同一批
 *    工作跑三遍」，而這條路的觸發者是結帳請求本身，已經被 idempotency_key 擋在
 *    更前面了。多開一道 claim 只會多一張要維護的 order_post_payment_log 列，
 *    而且會與 'notify' 那一步的語意混在一起。
 */
export async function queueOrderPlacedNotifications(orderId: string): Promise<NotifyOutcome> {
  try {
    const loaded = await getOrderForNotify(orderId);
    if (!loaded) return { ok: false, reason: "order_not_found" };
    const { order, items } = loaded;

    const isTransfer = order.paymentMethod === "transfer";
    const isOffline = order.paymentMethod === null;
    if (!isTransfer && !isOffline) return { ok: true, queued: 0, adopted: false };

    const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((s): s is string => !!s))];
    const sessions = await loadSessionBriefs(sessionIds);
    let queued = 0;

    // ---- 1. 客人的匯款資訊信（只有匯款訂單有）-------------------------------
    // ⚠️ 自己一個 try/catch：它失敗不可以害得下面店家那封也排不進去（那是兩件
    //    獨立的事），更不可以往上丟讓訂單成立失敗。同 0032 在這個檔案裡的做法。
    if (isTransfer) {
      try {
        const account = await getRemittanceAccount();
        // 🔴 這封信裡有一條「回訂單頁填末五碼」的連結，而網址來自 SITE_URL。
        //    `SITE_URL` **從來沒有設在 Vercel 上**過一次，而那一次讓這個站掉了一張
        //    NT$1,800 的單（src/server/public-url.ts 有整段紀錄）。組不出可用的
        //    公開網址時，正確的行為是**不寄這封信**：一封連結指向 localhost 的信在
        //    我們這一側完全沒有錯誤（寄出成功、log 乾淨），只有客人點下去打不開，
        //    等於整個末五碼回報功能不存在，而且沒有任何人會發現。
        //
        // ⚠️ 不寄信**不會**讓訂單失敗。這一整段跑在 createOrder() 的 step 7.5，
        //    訂單那時候已經 durable、座位已經鎖住；這裡回什麼都不影響它。客人當下
        //    就在完成頁上，帳號與回填欄位在那一頁看得到——信是備份，不是唯一出口。
        const token = await getOrderPublicToken(orderId);
        const orderUrl = token ? publicUrlFor("/checkout/complete", { token }) : null;
        if (orderUrl === null) {
          // ⚠️ error 不是 warn，而且明著說出兩件事：為什麼不寄、以及訂單沒事。
          //    這是「吵的失敗」——比一封寄出去卻沒有人點得開的信好得多。
          console.error(
            `[notify] 🚨 匯款資訊信不寄 order=${order.orderNo} —— ` +
              (token
                ? "組不出可用的公開網址（SITE_URL 沒設、不是 https、或指向 localhost/*.local）。" +
                  "請到 Vercel 設定 SITE_URL。"
                : "讀不到這張訂單的 public_token。") +
              " 訂單與座位不受影響，客人仍可在完成頁看到匯款帳號與回報欄位。",
          );
        } else if (remittanceConfigured(account) && account) {
          const copy = await loadEmailCopy();
          const mail = renderRemittanceEmail(
            {
              orderNo: order.orderNo,
              customerName: order.customerName,
              total: order.total,
              bankName: account.bankName,
              bankCode: account.bankCode,
              bankAccount: account.bankAccount,
              accountName: account.accountName,
              dueAt: remittanceDueAt(order.createdAt),
              orderUrl,
              items: items.map((i) => ({
                name: i.name,
                quantity: i.quantity,
                subtotal: i.subtotal,
              })),
              sessions: sessionIds
                .map((id) => sessions.get(id))
                .filter((s): s is SessionBrief => !!s),
              needsContact: order.needsContact,
            },
            copy,
            order.locale,
          );
          // enqueueOrderEmail 就是 0022 §7 的 enqueue_order_email()：地址由 SQL 自己
          // 從 orders.customer_email join 進來，不經過 Node。這封信要的東西與付款成功
          // 信一模一樣（同一張訂單、同一個收件人、同一種 dedupe），沒有理由在資料庫
          // 裡再開一支長得一樣的函式——差別只在 dedupe_key 的前綴，而那是呼叫端組的。
          const added = await enqueueOrderEmail({
            orderId,
            dedupeKey: dedupeKeys.remittance(orderId),
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          });
          if (added) queued += 1;
        } else {
          console.warn(`[notify] 匯款訂單但店家沒設定匯款帳戶，資訊信不寄 order=${order.orderNo}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[notify] 匯款資訊信排入失敗 order=${order.orderNo} ${message}`);
      }
    }

    // ---- 2. 店家的「有一筆待收款的新訂單」------------------------------------
    // 匯款與舊的「由店家聯繫付款」（NULL）兩條都寄。0032 那封只在**付款成功之後**寄，
    // 而這兩條路的訂單可能永遠不會走到那一步——沒有這一封，一張 offline 訂單就是
    // 靜靜躺著等 expire，沒有任何人知道它存在過。
    try {
      const sessionParticipants = new Map<string, number>();
      for (const it of items) {
        if (!it.sessionId) continue;
        sessionParticipants.set(
          it.sessionId,
          (sessionParticipants.get(it.sessionId) ?? 0) + it.quantity,
        );
      }
      const extras = await loadAdminMailExtras(orderId);
      const adminMail = renderAdminOrderNotificationEmail({
        stage: "atOrderTime",
        orderNo: order.orderNo,
        total: order.total,
        contact: extras.contact,
        adminUrl: extras.adminUrl,
        paymentMethod: order.paymentMethod,
        shippingMethod: order.shippingMethod,
        needsContact: order.needsContact,
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
        sessions: sessionIds.flatMap((id) => {
          const session = sessions.get(id);
          if (!session) return [];
          return [
            {
              session,
              participants: sessionParticipants.get(id) ?? 0,
              attendees: extras.attendees.get(id) ?? [],
            },
          ];
        }),
      });
      const added = await enqueueAdminOrderEmail({
        // 🔴 orderPlacedAdmin，**不是** orderNotifyAdmin。見那兩個 key 的註解。
        dedupeKey: dedupeKeys.orderPlacedAdmin(orderId),
        subject: adminMail.subject,
        text: adminMail.text,
        html: adminMail.html,
      });
      if (added) queued += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notify] 待收款通知信排入失敗 order=${order.orderNo} ${message}`);
    }

    console.info(`[notify] 下單當下已排信 order=${order.orderNo} queued=${queued}`);
    return { ok: true, queued, adopted: false };
  } catch (err) {
    // 最外圈。這一支的規約是「永不 throw」，而它跑在結帳的成功路徑上 —— 一封信
    // 排不進去絕不可以變成「訂單建立失敗，請再試一次」。
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 下單當下排信發生未預期例外 order=${orderId} ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

/**
 * 下單成功之後觸發「下單當下」那批信，且**保證不會拖垮結帳**。
 *
 * 形狀與理由逐字對應 triggerNotifyAfterPayment()，只有呼叫端不同：那邊是金流
 * webhook（拖久了金流商會重送），這邊是客人的結帳請求（拖久了客人看著轉圈圈，
 * 而訂單其實早就成立了）。逾時就當作沒做完 —— 排進 outbox 的信本來就在等
 * /api/tasks/notify 的下一輪 flush。
 */
export async function triggerNotifyAfterOrderPlaced(
  orderId: string,
  timeoutMs = 5_000,
): Promise<NotifyOutcome> {
  // .unref?.() 同 triggerNotifyAfterPayment：逾時的 timer 不可以把 Node 的行程
  // 留著不結束（serverless 上那等於白白吃滿執行時間）。
  const timeout = new Promise<NotifyOutcome>((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: "notify_timeout" }), timeoutMs).unref?.(),
  );
  try {
    const work = (async (): Promise<NotifyOutcome> => {
      const outcome = await queueOrderPlacedNotifications(orderId);
      // 排完就立刻試寄一次。失敗不影響上面的結果 —— 信已經在 outbox 裡了。
      await flushEmailOutbox(EMAIL_FLUSH_BATCH);
      return outcome;
    })();
    const outcome = await Promise.race([work, timeout]);
    if (!outcome.ok && outcome.reason === "notify_timeout") {
      console.error(`[notify] 下單當下通知逾時 order=${orderId} —— 已交給排程，訂單照常成立`);
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] triggerNotifyAfterOrderPlaced 例外 ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

/** 場次的摘要（信裡要印的時間地點）。查不到的場次直接略過，不讓整封信失敗。 */
async function loadSessionBriefs(ids: string[]): Promise<Map<string, SessionBrief>> {
  const out = new Map<string, SessionBrief>();
  for (const id of ids) {
    try {
      const s = await getEventSessionById(id);
      if (s) {
        out.set(id, {
          title: s.title,
          location: s.location,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notify] 讀場次失敗 session=${id} ${message}`);
    }
  }
  return out;
}

/**
 * 付款確認之後觸發通知，且**保證不會拖垮呼叫端**。
 *
 * 理由與 invoice-issuer.ts:413-440 逐字相同：webhook 的職責是「盡快告訴金流商我
 * 收到了」。這裡除了排信還會順手沖一次 outbox（>90% 的客人因此是秒收到的），而
 * 沖 outbox 要往返 Resend —— 那是一個外部服務，它慢的時候不能讓 PayUni 收到逾時
 * 或 5xx，因為那換來的是無止盡的重送。
 *
 * 超時就當作沒做完，交給 /api/tasks/notify 的排程；claim 會在 p_stale_after 之後
 * 被接手，而已經排進 outbox 的信本來就在等下一輪 flush。
 */
export async function triggerNotifyAfterPayment(
  orderId: string,
  timeoutMs = 8_000,
): Promise<NotifyOutcome> {
  const timeout = new Promise<NotifyOutcome>((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: "notify_timeout" }), timeoutMs).unref?.(),
  );
  try {
    const work = (async (): Promise<NotifyOutcome> => {
      const outcome = await queueOrderNotifications(orderId);
      // 排完就立刻試寄一次。失敗不影響上面的結果 —— 信已經在 outbox 裡了。
      await flushEmailOutbox(EMAIL_FLUSH_BATCH);
      return outcome;
    })();
    const outcome = await Promise.race([work, timeout]);
    if (!outcome.ok && outcome.reason === "notify_timeout") {
      console.error(`[notify] 通知逾時 order=${orderId} —— 已交給排程，webhook 照常回 200`);
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] triggerNotifyAfterPayment 例外 ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

// -----------------------------------------------------------------------------
// 出貨通知（後台「標記已出貨」）
// -----------------------------------------------------------------------------

/**
 * 出貨通知信排入的結果。
 *   queued     —— 這一次新增了一列（會被下面的 flush 或 /api/tasks/notify 寄出）
 *   duplicate  —— dedupe_key 已存在（之前排過了），或訂單沒有信箱：不需要做任何事
 *   failed     —— 排不進去（讀不到訂單、資料庫錯誤、未預期例外）——後台要提示
 */
export type ShippedNotifyOutcome =
  | { status: "queued" }
  | { status: "duplicate" }
  | { status: "failed"; reason: string };

/**
 * 把出貨通知信排給訂購人。**永不 throw。**
 *
 * 🔴 呼叫端（src/lib/admin/fns/orders.ts）只在 advanceOrderFulfillment() 回
 *    reason === "updated" 且 action === "ship" 時呼叫——也就是 processing → shipped
 *    **這一次真的發生了**。冪等的 already_done、門市自取的 pickup、已出貨 → 已完成
 *    的 complete 都不會走到這裡。就算有人誤叫，dedupe_key 也只讓它排一次。
 */
export async function queueOrderShippedEmail(orderId: string): Promise<ShippedNotifyOutcome> {
  try {
    const loaded = await getOrderForShippedEmail(orderId);
    if (!loaded) return { status: "failed", reason: "order_not_found" };
    const { order, items, address } = loaded;

    const [token, contactEmail, copy] = await Promise.all([
      getOrderPublicToken(orderId),
      getShopContactEmail(),
      loadEmailCopy(),
    ]);
    // 連結是加分項，不是必要條件（與匯款信不同：那封信的存在意義一半是回填末五碼）。
    // 組不出可用的公開網址就不印連結，信照寄。
    const orderUrl = token ? publicUrlFor("/checkout/complete", { token }) : null;

    const mail = renderOrderShippedEmail(
      {
        orderNo: order.orderNo,
        customerName: order.customerName,
        shippingMethod: order.shippingMethod,
        items,
        address,
        orderUrl,
        contactEmail,
      },
      copy,
      order.locale,
    );

    const result = await enqueueOrderEmailResult({
      orderId,
      dedupeKey: dedupeKeys.orderShipped(orderId),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (result === "error") return { status: "failed", reason: "enqueue_error" };
    console.info(`[notify] 出貨通知信 order=${order.orderNo} result=${result}`);
    return result === "queued" ? { status: "queued" } : { status: "duplicate" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 出貨通知信排入發生未預期例外 order=${orderId} ${message}`);
    return { status: "failed", reason: "unexpected_error" };
  }
}

/**
 * 排出貨通知信並順手沖一次 outbox。**永不 throw**，有逾時保護。
 *
 * 狀態早就寫進資料庫了，這裡回什麼都不會讓它倒回去；後台人員只會多看到一句提示。
 * 逾時時信可能已經排進去、也可能還沒——回 failed 讓後台提示去看一下，而 dedupe_key
 * 保證之後任何重試都不會多寄一封。排進去但沒來得及寄的，由 /api/tasks/notify 的
 * 下一輪 flush 寄出。
 */
export async function triggerNotifyAfterShipped(
  orderId: string,
  timeoutMs = 8_000,
): Promise<ShippedNotifyOutcome> {
  const timeout = new Promise<ShippedNotifyOutcome>((resolve) =>
    setTimeout(() => resolve({ status: "failed", reason: "notify_timeout" }), timeoutMs).unref?.(),
  );
  try {
    const work = (async (): Promise<ShippedNotifyOutcome> => {
      const outcome = await queueOrderShippedEmail(orderId);
      if (outcome.status === "queued") await flushEmailOutbox(EMAIL_FLUSH_BATCH);
      return outcome;
    })();
    return await Promise.race([work, timeout]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] triggerNotifyAfterShipped 例外 ${message}`);
    return { status: "failed", reason: "unexpected_error" };
  }
}

// -----------------------------------------------------------------------------
// 把 outbox 沖出去
// -----------------------------------------------------------------------------

export type FlushResult = {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  givenUp: number;
};

/**
 * 拿一批待寄信，逐封送出去。**永不 throw。**
 *
 * 序列跑，不並行：同時打 Resend 好幾封並沒有比較快（瓶頸不在我們這邊），但併發
 * 會讓錯誤變得難以歸因（同 invoice-issuer.ts 的 runInvoiceBacklog）。
 *
 * ⚠️ claimEmailBatch() 已經在資料庫那一側把 attempts +1 並把 next_attempt_at 推到
 *    未來了，所以就算這個行程在下面任何一行死掉，那幾封信只是晚幾分鐘再試 ——
 *    不會卡住，也不會被別的 flush 同時拿走（for update skip locked）。
 */
export async function flushEmailOutbox(limit = EMAIL_FLUSH_BATCH): Promise<FlushResult> {
  const tally: FlushResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, givenUp: 0 };

  try {
    const batch = await claimEmailBatch(limit);
    tally.claimed = batch.length;
    if (batch.length === 0) return tally;

    if (!emailConfigured()) {
      // 一次講清楚，而不是每封信各印一行。
      console.warn(
        `[notify] 沒有 RESEND_API_KEY / MAIL_FROM —— 這 ${batch.length} 封走 dry run 並標記 skipped`,
      );
    }

    for (const mail of batch) {
      const result = await sendEmail({
        to: mail.toEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });

      if (result.outcome === "failed") {
        const status = await failEmail(mail.id, result.error ?? "unknown");
        tally.failed += 1;
        if (status === "failed") {
          tally.givenUp += 1;
          console.error(
            `[notify] 放棄重試 key=${mail.dedupeKey} to=${maskEmail(mail.toEmail)} attempts=${mail.attempts}`,
          );
        }
        continue;
      }

      // dry run 標 skipped 不是 sent —— 見 src/server/email.ts 檔頭。
      const isDryRun = result.outcome === "dry_run";
      await finishEmail({ id: mail.id, providerId: result.id, skipped: isDryRun });
      if (isDryRun) tally.skipped += 1;
      else tally.sent += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] flush 例外 ${message}`);
  }

  return tally;
}

// -----------------------------------------------------------------------------
// 補跑：付了錢卻沒排信的訂單
// -----------------------------------------------------------------------------

export type BacklogResult = {
  scanned: number;
  queued: number;
  adopted: number;
  failed: number;
  details: { orderNo: string; outcome: string }[];
};

/**
 * 掃過待通知清單，逐張補排。**永不 throw。**
 *
 * webhook 當下失敗的、instance 被回收的、資料庫當時掛掉的，全部從這裡補回來。
 *
 * ⚠️ 0022 §10 已經把「這一期上線之前就付過款的訂單」一次標成完成，所以這支不會
 *    去翻歷史訂單寄信給每一位舊客人。那一段的理由寫在那支 migration 裡。
 */
export async function runNotifyBacklog(limit = 20): Promise<BacklogResult> {
  const out: BacklogResult = { scanned: 0, queued: 0, adopted: 0, failed: 0, details: [] };

  try {
    const rows = await notifyBacklog(limit);
    out.scanned = rows.length;

    for (const row of rows) {
      const outcome = await queueOrderNotifications(row.orderId);
      if (outcome.ok) {
        if (outcome.adopted) out.adopted += 1;
        else out.queued += outcome.queued;
        out.details.push({ orderNo: row.orderNo, outcome: `ok queued=${outcome.queued}` });
      } else {
        out.failed += 1;
        out.details.push({ orderNo: row.orderNo, outcome: `fail ${outcome.reason}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] backlog 例外 ${message}`);
  }

  return out;
}

// -----------------------------------------------------------------------------
// 活動前 24 小時的提醒
// -----------------------------------------------------------------------------

export type ReminderResult = {
  sessions: number;
  queued: number;
};

/**
 * 掃出 24 小時內要開始的場次，替每一位在簽到表上的參加者排一封提醒信。
 * **永不 throw。**
 *
 * ⚠️ **沒有「這一場提醒過了沒有」的旗標。** 冪等來自 dedupe_key
 *    （`session_reminder:<session_id>:<registration_id>`）：排程每 10 分鐘掃一次，
 *    第二次之後全部撞 unique 變成 no-op。多一個旗標就多一個會與真實狀態對不上的
 *    地方 —— 例如「旗標設了但信其實沒排進去」。
 *
 * ⚠️ **寄給誰用 loadPaidRoster()**，不是自己寫一次條件。那正是快樂手
 *    queries.ts:117-125 那段紅字在防的事（「有人收到提醒卻不在簽到表上」）。
 *
 * 語言用**下單時的語言**（orders.locale），不是店家的預設語言：一個用日文結帳的
 * 客人收到中文提醒信，等於沒收到。
 */
export async function runSessionReminders(
  lead = REMINDER_LEAD,
  limit = 50,
): Promise<ReminderResult> {
  const out: ReminderResult = { sessions: 0, queued: 0 };

  try {
    const due = await sessionsDueForReminder(lead, limit);
    out.sessions = due.length;
    if (due.length === 0) return out;

    const copy = await loadEmailCopy();

    for (const session of due) {
      try {
        const roster = await loadPaidRoster(session.sessionId);
        const withEmail = roster.filter((r) => r.has_email);
        if (withEmail.length === 0) continue;

        const locales = await loadOrderLocales([...new Set(withEmail.map((r) => r.order_id))]);
        const brief: SessionBrief = {
          title: session.title,
          location: session.location,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
        };

        const mails: RegistrationMailItem[] = withEmail.map((row) => {
          const lang: Lang = locales.get(row.order_id) ?? "zh";
          const mail = renderSessionReminderEmail(
            {
              participantName: row.name,
              seatNo: row.seat_no,
              orderNo: row.order_no,
              session: brief,
            },
            copy,
            lang,
          );
          return {
            registrationId: row.registration_id,
            dedupeKey: dedupeKeys.sessionReminder(session.sessionId, row.registration_id),
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          };
        });

        const added = await enqueueRegistrationEmails(mails);
        out.queued += added;
        if (added > 0) {
          console.info(`[notify] 場次提醒已排入 session=${session.sessionId} queued=${added}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[notify] 場次提醒失敗 session=${session.sessionId} ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 提醒信例外 ${message}`);
  }

  return out;
}

/** 寄出 30 天後清掉信件內文（0022 §6）。**永不 throw**，冪等。 */
export async function purgeEmailBodies(): Promise<number> {
  return purgeSentEmailBodies();
}
