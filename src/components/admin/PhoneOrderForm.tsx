/**
 * 新增電話報名的表單（/admin/orders/new，0050）。
 *
 * 後台慣例：AdminDetailPage（「← 回到列表」＋手機版底部固定按鈕）、UnsavedChangesGuard
 * （填到一半離開會先問）、useState 管欄位（同 ReferrerForm）。
 *
 * 驗證：送出前用 phoneOrderSchema（與 server fn 的 inputValidator **同一份**）先擋一次，
 * 錯誤列在按鈕上方；真正的邊界在伺服器（createOrder() 重算價格、reserve_session_seat()
 * 擋名額不足與已開始的場次）。
 *
 * 重複送出：idempotencyKey 在第一次按「建立」時產生，之後每一次重送都帶同一個——
 * 連點、逾時重按都只會有一張單。送出中按鈕也會停用。
 */
import { useMemo, useRef, useState } from "react";
import { Loader2, PhoneCall, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { money } from "@/lib/admin/order-labels";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { CARRIER_MOBILE, CARRIER_NPC, type InvoiceType } from "@/lib/invoice-format";
import {
  phoneOrderSchema,
  priceOverrideError,
  quotePhoneOrder,
  type PhoneOrderInput,
  type PhoneOrderProductOption,
} from "@/lib/admin/phone-order";

type Person = { name: string; phone: string; email: string };
const EMPTY_PERSON: Person = { name: "", phone: "", email: "" };

type Props = {
  products: PhoneOrderProductOption[];
  /** 台北的今天（YYYY-MM-DD），匯款日期的預設值。 */
  today: string;
  initialSessionId: string | null;
  back: { to: string; label: string };
  onCreated: (orderId: string) => Promise<void>;
};

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <Label htmlFor={htmlFor} className="block text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

const SELECT_CLASS = "block h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function PhoneOrderForm({ products, today, initialSessionId, back, onCreated }: Props) {
  const initialProduct =
    (initialSessionId && products.find((p) => p.sessions.some((s) => s.id === initialSessionId))) ||
    null;

  const [productId, setProductId] = useState(initialProduct?.id ?? "");
  const [sessionId, setSessionId] = useState(initialProduct ? (initialSessionId ?? "") : "");
  const [planId, setPlanId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [people, setPeople] = useState<Person[]>([{ ...EMPTY_PERSON }]);
  const [buyer, setBuyer] = useState<Person>({ ...EMPTY_PERSON });
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("personal");
  const [carrierType, setCarrierType] = useState("");
  const [carrierNumber, setCarrierNumber] = useState("");
  const [taxId, setTaxId] = useState("");
  const [companyTitle, setCompanyTitle] = useState("");
  const [loveCode, setLoveCode] = useState("");
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideAmount, setOverrideAmount] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<"paid" | "unpaid">("paid");
  const [paidOn, setPaidOn] = useState(today);
  const [last5, setLast5] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [notifyCustomer, setNotifyCustomer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const idemKey = useRef<string | null>(null);

  const product = products.find((p) => p.id === productId) ?? null;
  const session = product?.sessions.find((s) => s.id === sessionId) ?? null;
  const plan = session?.plans.find((p) => p.id === planId) ?? null;
  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : 0;
  const quote = quotePhoneOrder(product, plan, qty);
  const needsPlan = session !== null && session.hasPlans;

  // 參加者欄位數跟著「人數 × 每單位座位」走；已經填的不丟。
  const seats = quote.seats;
  const shownPeople = useMemo(() => {
    const out = people.slice(0, Math.max(seats, 0));
    while (out.length < seats) out.push({ ...EMPTY_PERSON });
    return out;
  }, [people, seats]);

  const { dirty } = useFormDirty({
    productId,
    sessionId,
    planId,
    quantity,
    people,
    buyer,
    invoiceType,
    carrierType,
    carrierNumber,
    taxId,
    companyTitle,
    loveCode,
    overrideOn,
    overrideAmount,
    overrideReason,
    paymentStatus,
    paidOn,
    last5,
    adminNote,
    notifyCustomer,
  });
  const guard = useUnsavedChangesGuard(dirty);

  function setPerson(i: number, patch: Partial<Person>) {
    setPeople((prev) => {
      const next = [...prev];
      while (next.length <= i) next.push({ ...EMPTY_PERSON });
      next[i] = { ...next[i]!, ...patch };
      return next;
    });
  }

  const overrideNumber = /^\d+$/.test(overrideAmount.trim()) ? Number(overrideAmount.trim()) : NaN;
  const finalTotal = overrideOn && Number.isFinite(overrideNumber) ? overrideNumber : quote.total;
  const isFree = finalTotal === 0 && session !== null && (!needsPlan || plan !== null);

  function buildInput(): PhoneOrderInput | null {
    const msgs: string[] = [];
    if (!product) msgs.push("請選擇活動或策旅");
    if (!session) msgs.push("請選擇場次");
    if (needsPlan && !plan) msgs.push("這個場次有票種，請選擇票種");
    if (session && needsPlan && session.plans.length === 0)
      msgs.push("這個場次目前沒有販售中的票種");
    if (qty < 1) msgs.push("人數至少 1");
    if (session && quote.seats > session.seatsLeft) {
      msgs.push(`名額不足：這場只剩 ${session.seatsLeft} 位，這次需要 ${quote.seats} 位`);
    }
    if (overrideOn) {
      const err = priceOverrideError(
        { amount: Number.isFinite(overrideNumber) ? overrideNumber : -1, reason: overrideReason },
        quote.total,
      );
      if (err) msgs.push(`手動改價：${err}`);
    }
    if (msgs.length > 0) {
      setErrors(msgs);
      return null;
    }

    if (!idemKey.current) idemKey.current = crypto.randomUUID();
    const raw = {
      idempotencyKey: idemKey.current,
      productId,
      sessionId,
      planId: plan ? plan.id : null,
      quantity: qty,
      participants: shownPeople.map((p) => ({
        name: p.name,
        phone: p.phone.trim() || null,
        email: p.email.trim() || null,
      })),
      customerName: buyer.name,
      customerPhone: buyer.phone,
      customerEmail: buyer.email,
      invoice: {
        type: invoiceType,
        carrierType: invoiceType === "personal" ? carrierType || null : null,
        carrierNumber: invoiceType === "personal" && carrierType ? carrierNumber : null,
        taxId: invoiceType === "company" ? taxId : null,
        companyTitle: invoiceType === "company" ? companyTitle || null : null,
        loveCode: invoiceType === "donate" ? loveCode : null,
      },
      adminNote: adminNote.trim() || null,
      priceOverride: overrideOn ? { amount: overrideNumber, reason: overrideReason } : null,
      // 0 元（免費招待）沒有款項：一律送「未收款」，伺服器會 settle_free_order() 直接成立。
      payment:
        paymentStatus === "paid" && !isFree
          ? { status: "paid" as const, paidOn, last5: last5.trim() || null }
          : { status: "unpaid" as const },
      notifyCustomer,
    };
    const parsed = phoneOrderSchema.safeParse(raw);
    if (!parsed.success) {
      setErrors(
        parsed.error.issues.map((i) => {
          const path = i.path.join(".");
          const where = path.startsWith("participants.")
            ? `第 ${Number(i.path[1]) + 1} 位參加者：`
            : path.startsWith("customer")
              ? "訂購人："
              : path.startsWith("invoice")
                ? "發票："
                : path.startsWith("payment")
                  ? "付款："
                  : "";
          return `${where}${i.message}`;
        }),
      );
      return null;
    }
    setErrors([]);
    return parsed.data;
  }

  async function submit() {
    if (saving) return;
    const input = buildInput();
    if (!input) {
      toast.error("有欄位需要修正");
      return;
    }
    setSaving(true);
    try {
      const { createPhoneOrderAdmin } = await import("@/lib/admin/fns/phone-orders");
      const res = await createPhoneOrderAdmin({ data: input });
      if (!res.ok) {
        setErrors([res.message]);
        toast.error(res.message);
        return;
      }
      if (res.warning) toast.warning(res.warning);
      else toast.success(`已建立訂單 ${res.orderNo}`);
      guard.allowLeave();
      await onCreated(res.orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "建立失敗，請再試一次";
      setErrors([message]);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="phone-order-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "建立中…" : "建立訂單"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo={back.to}
      backLabel={back.label}
      backAlso={["/admin/orders", "/admin/registrations"]}
      icon={<PhoneCall className="h-5 w-5" aria-hidden="true" />}
      title="新增電話報名"
      meta="客人打電話來報名時，在這裡補一張正式訂單：會占名額、出現在報名名單、計入營收，收到款後自動開立電子發票。"
      actions={actions}
      width="lg"
    >
      <form
        id="phone-order-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-5"
      >
        <Block title="1. 活動與場次">
          {products.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前沒有可以報名的場次（只列出上架中、開放報名、還沒開始的場次）。
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="活動／策旅" htmlFor="po-product">
                <select
                  id="po-product"
                  className={SELECT_CLASS}
                  value={productId}
                  onChange={(e) => {
                    setProductId(e.target.value);
                    setSessionId("");
                    setPlanId("");
                  }}
                >
                  <option value="">請選擇</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.productType === "journey" ? "【策旅】" : "【活動】"}
                      {p.title.zh}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="場次（只列還沒開始的）" htmlFor="po-session">
                <select
                  id="po-session"
                  className={SELECT_CLASS}
                  value={sessionId}
                  disabled={!product}
                  onChange={(e) => {
                    setSessionId(e.target.value);
                    setPlanId("");
                  }}
                >
                  <option value="">請選擇</option>
                  {(product?.sessions ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {formatTaipeiDateTime(s.startsAt)}
                      {s.title?.zh ? `　${s.title.zh}` : ""}
                      {`　剩 ${s.seatsLeft} / ${s.capacity} 位`}
                    </option>
                  ))}
                </select>
              </Field>
              {needsPlan ? (
                <Field label="票種" htmlFor="po-plan">
                  <select
                    id="po-plan"
                    className={SELECT_CLASS}
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                  >
                    <option value="">
                      {session && session.plans.length === 0 ? "目前沒有販售中的票種" : "請選擇"}
                    </option>
                    {(session?.plans ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title.zh}　{money(p.price)}
                        {p.seatsPerUnit > 1 ? `（每份 ${p.seatsPerUnit} 人）` : ""}
                        {`　剩 ${p.unitsLeft} 份`}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field
                label={plan && plan.seatsPerUnit > 1 ? "份數" : "人數"}
                htmlFor="po-qty"
                hint={
                  session
                    ? `單價 ${money(quote.unitPrice)}，需填 ${quote.seats} 位參加者，依票種計 ${money(quote.total)}`
                    : undefined
                }
              >
                <Input
                  id="po-qty"
                  inputMode="numeric"
                  value={quantity}
                  maxLength={2}
                  onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ""))}
                />
              </Field>
            </div>
          )}
        </Block>

        <Block title="2. 訂購人">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="姓名" htmlFor="po-buyer-name">
              <Input
                id="po-buyer-name"
                value={buyer.name}
                maxLength={60}
                onChange={(e) => setBuyer({ ...buyer, name: e.target.value })}
              />
            </Field>
            <Field label="手機（09 開頭 10 碼）" htmlFor="po-buyer-phone">
              <Input
                id="po-buyer-phone"
                inputMode="tel"
                value={buyer.phone}
                maxLength={10}
                onChange={(e) => setBuyer({ ...buyer, phone: e.target.value.trim() })}
              />
            </Field>
            <Field label="Email" htmlFor="po-buyer-email">
              <Input
                id="po-buyer-email"
                type="email"
                value={buyer.email}
                maxLength={120}
                onChange={(e) => setBuyer({ ...buyer, email: e.target.value.trim() })}
              />
            </Field>
          </div>
        </Block>

        <Block title="3. 參加者">
          {shownPeople.length === 0 ? (
            <p className="text-sm text-muted-foreground">先選場次與人數。</p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                每一位都要有姓名，信箱與手機至少填一項（與網站結帳相同）。
              </p>
              {shownPeople.map((p, i) => (
                <div key={i} className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-3">
                  <div className="flex items-center justify-between sm:col-span-3">
                    <span className="text-xs font-medium">第 {i + 1} 位參加者</span>
                    {i === 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setPerson(0, { ...buyer })}
                      >
                        帶入訂購人資料
                      </Button>
                    ) : null}
                  </div>
                  <Field label="姓名" htmlFor={`po-p${i}-name`}>
                    <Input
                      id={`po-p${i}-name`}
                      value={p.name}
                      maxLength={60}
                      onChange={(e) => setPerson(i, { name: e.target.value })}
                    />
                  </Field>
                  <Field label="手機" htmlFor={`po-p${i}-phone`}>
                    <Input
                      id={`po-p${i}-phone`}
                      inputMode="tel"
                      value={p.phone}
                      maxLength={10}
                      onChange={(e) => setPerson(i, { phone: e.target.value.trim() })}
                    />
                  </Field>
                  <Field label="Email" htmlFor={`po-p${i}-email`}>
                    <Input
                      id={`po-p${i}-email`}
                      type="email"
                      value={p.email}
                      maxLength={120}
                      onChange={(e) => setPerson(i, { email: e.target.value.trim() })}
                    />
                  </Field>
                </div>
              ))}
            </div>
          )}
        </Block>

        <Block title="4. 電子發票">
          <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label="發票類型">
            {(
              [
                ["personal", "個人（含載具）"],
                ["company", "公司（統編）"],
                ["donate", "捐贈"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="po-invoice-type"
                  checked={invoiceType === value}
                  onChange={() => setInvoiceType(value)}
                />
                {label}
              </label>
            ))}
          </div>
          {invoiceType === "personal" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="載具" htmlFor="po-carrier-type">
                <select
                  id="po-carrier-type"
                  className={SELECT_CLASS}
                  value={carrierType}
                  onChange={(e) => {
                    setCarrierType(e.target.value);
                    setCarrierNumber("");
                  }}
                >
                  <option value="">不使用載具</option>
                  <option value={CARRIER_MOBILE}>手機條碼</option>
                  <option value={CARRIER_NPC}>自然人憑證</option>
                </select>
              </Field>
              {carrierType ? (
                <Field
                  label={
                    carrierType === CARRIER_MOBILE ? "手機條碼（/ 開頭 8 碼）" : "自然人憑證號碼"
                  }
                  htmlFor="po-carrier-number"
                >
                  <Input
                    id="po-carrier-number"
                    value={carrierNumber}
                    maxLength={carrierType === CARRIER_MOBILE ? 8 : 16}
                    onChange={(e) => setCarrierNumber(e.target.value.trim().toUpperCase())}
                  />
                </Field>
              ) : null}
            </div>
          ) : invoiceType === "company" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="統一編號（8 碼）" htmlFor="po-tax-id">
                <Input
                  id="po-tax-id"
                  inputMode="numeric"
                  value={taxId}
                  maxLength={8}
                  onChange={(e) => setTaxId(e.target.value.replace(/[^\d]/g, ""))}
                />
              </Field>
              <Field label="公司抬頭（選填）" htmlFor="po-company-title">
                <Input
                  id="po-company-title"
                  value={companyTitle}
                  maxLength={60}
                  onChange={(e) => setCompanyTitle(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="愛心碼（3–7 位數字）" htmlFor="po-love-code">
                <Input
                  id="po-love-code"
                  inputMode="numeric"
                  value={loveCode}
                  maxLength={7}
                  onChange={(e) => setLoveCode(e.target.value.replace(/[^\d]/g, ""))}
                />
              </Field>
            </div>
          )}
        </Block>

        <Block title="5. 金額與付款">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">依票種計算</dt>
            <dd>{money(quote.total)}</dd>
            <dt className="font-medium">本單金額</dt>
            <dd className="font-medium">
              {money(finalTotal)}
              {isFree ? "（免費招待：建單後直接成立，不用付款）" : ""}
            </dd>
          </dl>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={overrideOn} onCheckedChange={(v) => setOverrideOn(v === true)} />
            手動改價（只能改低，例如親友價、團體價；改成 0 ＝ 免費招待）
          </label>
          {overrideOn ? (
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Field label="改後總金額" htmlFor="po-override-amount">
                <Input
                  id="po-override-amount"
                  inputMode="numeric"
                  value={overrideAmount}
                  onChange={(e) => setOverrideAmount(e.target.value.replace(/[^\d]/g, ""))}
                />
              </Field>
              <Field label="改價原因（必填）" htmlFor="po-override-reason">
                <Input
                  id="po-override-reason"
                  value={overrideReason}
                  maxLength={200}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {isFree ? null : (
            <>
              <div
                className="flex flex-wrap gap-4 pt-2 text-sm"
                role="radiogroup"
                aria-label="付款狀態"
              >
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="po-payment"
                    checked={paymentStatus === "paid"}
                    onChange={() => setPaymentStatus("paid")}
                  />
                  已收到匯款
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="po-payment"
                    checked={paymentStatus === "unpaid"}
                    onChange={() => setPaymentStatus("unpaid")}
                  />
                  尚未收到匯款
                </label>
              </div>
              {paymentStatus === "paid" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="匯款日期" htmlFor="po-paid-on">
                    <Input
                      id="po-paid-on"
                      type="date"
                      value={paidOn}
                      max={today}
                      onChange={(e) => setPaidOn(e.target.value)}
                    />
                  </Field>
                  <Field label="帳號末五碼（選填）" htmlFor="po-last5">
                    <Input
                      id="po-last5"
                      inputMode="numeric"
                      value={last5}
                      maxLength={5}
                      onChange={(e) => setLast5(e.target.value.replace(/[^\d]/g, ""))}
                    />
                  </Field>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    建立後直接標記為已收款（與訂單頁「標記已收款」同一個流程），系統會自動開立電子發票。
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  建成待收款的匯款訂單，名額先保留。收到款後到訂單頁按「標記已收款」。 電話報名的單
                  <strong>不會</strong>被 3
                  天逾期自動取消；客人不來了請到訂單頁「刪除訂單」釋出名額。
                </p>
              )}
            </>
          )}
        </Block>

        <Block title="6. 內部備註與通知">
          <Field label="內部備註（只有後台與店家通知信看得到）" htmlFor="po-note">
            <Textarea
              id="po-note"
              value={adminNote}
              maxLength={1000}
              rows={3}
              onChange={(e) => setAdminNote(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={notifyCustomer}
              onCheckedChange={(v) => setNotifyCustomer(v === true)}
            />
            <span>
              寄報名成功信給客人
              <span className="block text-xs text-muted-foreground">
                不勾＝這張單完全不寄信給客人（含付款成功、報名成功、活動前提醒）。店家通知信照常寄，並標明「後台電話報名」。
              </span>
            </span>
          </label>
        </Block>

        {errors.length > 0 ? (
          <ul
            className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            role="alert"
          >
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : null}
      </form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
