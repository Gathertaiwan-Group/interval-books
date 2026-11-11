/**
 * 一個識別碼欄位（統編／身分證字號／國外識別碼／居留證號碼／匯款帳號）。
 *
 * ⚠️ **遮罩值絕對不可以當成輸入框的預設值。** 編輯既有廠商時，讀回來的識別碼是
 *    `tax_id_masked`（例如 `****5678`）—— view 那一層根本沒有把完整號碼送到瀏覽器。
 *    如果把它塞進 input 的 defaultValue，使用者只要按一次儲存，`inv_save_vendor()` 的
 *    UPDATE 就會把 `****5678` 這串字真的寫進 tax_id 欄位，而且**沒有任何一層會報錯**
 *    （見 0019 SQL：`tax_id = v_tax_id`，沒有 COALESCE、沒有「key 不存在就不動」）。
 *    所以這裡在有遮罩的時候是**唯讀的遮罩顯示 + 一顆「更改」按鈕**，按下去才變成空白
 *    輸入框，而且要求重新輸入完整號碼。
 *
 *    ⚠️ 由此推出一件使用者一定會問的事：**編輯既有廠商時，識別碼必須重新輸入**，
 *    不然儲存會被擋下來。這不是懶得做「留空＝不變更」，而是那個做法在這個資料庫上
 *    做不出來：payload 少一個 key 會被 zod 擋（vendorSchema 的識別碼欄位是
 *    nullable 但不是 optional），送 null 會被 UPDATE 直接寫成 NULL，而
 *    domestic_company 送 null 還會撞上 `VENDOR_TAX_ID_REQUIRED`。三條路都不通，
 *    所以走第四條：講清楚，然後要求重打一次。要看原值請走「完整號碼」那扇門
 *    （VendorSensitiveDialog），那會留下一筆查閱紀錄 —— 那才是原值該有的代價。
 *
 * ⚠️ 有遮罩而且沒按「更改」的時候，這裡渲染的是**文字**不是 input —— 遮罩值連
 *    進到表單 state 的機會都沒有，所以不可能被送出去。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function IdentityField({
  id,
  label,
  masked,
  changing,
  value,
  disabled,
  required,
  hint,
  onStartChange,
  onCancelChange,
  onChange,
}: {
  id: string;
  label: string;
  /** null = 這家還沒填過這個識別碼，直接給輸入框。 */
  masked: string | null;
  changing: boolean;
  value: string;
  disabled: boolean;
  required: boolean;
  /** 輸入框下方的一行說明（例如「個人戶可不填」）。 */
  hint?: string;
  onStartChange: () => void;
  onCancelChange: () => void;
  onChange: (next: string) => void;
}) {
  if (masked !== null && !changing) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </Label>
        <div className="flex items-center gap-2">
          <span
            id={id}
            className="flex h-9 flex-1 items-center rounded-md border border-border bg-muted/40 px-3 font-mono text-sm tabular-nums text-muted-foreground"
          >
            {masked}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onStartChange}
          >
            更改
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          目前只看得到遮罩。要更改必須重新輸入完整號碼。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          className="flex-1"
          value={value}
          disabled={disabled}
          autoComplete="off"
          placeholder={masked === null ? "" : "請輸入完整號碼"}
          onChange={(e) => onChange(e.target.value)}
        />
        {masked !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={onCancelChange}
          >
            取消更改
          </Button>
        ) : null}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {masked !== null ? (
        <p className="text-xs text-amber-700">
          要輸入<strong>完整</strong>號碼。系統讀不回原值，這一格會直接覆寫資料庫。
        </p>
      ) : null}
    </div>
  );
}
