-- 0061_vendor_individual_optional_id.sql —— 國內個人廠商的身分證字號改為選填（2026-11-11）
--
-- 業主有些供貨者是個人（例如寄賣手作的個人戶），沒有統編、也不方便提供身分證字號。
-- 0019 §5.1 的 inv_save_vendor() 對 entity_type = 'domestic_individual' 強制要 id_number，
-- 於是這類廠商**建不起來**。
--
-- 這一支只做一件事：create or replace inv_save_vendor()，與 0019 的版本逐字相同，只改
-- 國內個人那一條 RAISE：
--   · 不填 → 允許（存 NULL）。
--   · 有填 → 仍要是 1 個英文字母 + 1／2／8／9 + 8 碼數字（upper／btrim 之後），否則
--     VENDOR_BAD_ID_NUMBER。這條形狀檢查對任何 entity_type 帶進來的 id_number 都套用。
-- 國內公司的統編、國外法人的國外識別碼、國外個人的「識別碼或居留證擇一」**照舊必填**。
--
-- 簽名（uuid, uuid, jsonb）與回傳型別（jsonb）不變，所以 create or replace 保留 0019 給的
-- 權限（只 grant service_role）；最後仍照 0019 的做法重申一次。冪等。
--
-- 扣繳／寄售結算／匯出都不讀 id_number（只有 inv_vendor_sensitive() 這個留痕出口與兩個
-- 遮罩 view 會讀，而 inv.mask_tail() 對 NULL 回 NULL），所以 NULL 不會讓任何下游崩。
begin;

create or replace function public.inv_save_vendor(
  p_user_id uuid,
  p_id      uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id          uuid;
  v_entity      text;
  v_name        text;
  v_tax_id      text;
  v_id_number   text;
  v_foreign_id  text;
  v_permit      text;
  v_created     boolean := false;
  v_code        text;
  v_status      text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_name := nullif(btrim(coalesce(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NO_NAME: 請輸入供應商名稱';
  END IF;

  v_entity := coalesce(nullif(btrim(coalesce(p_payload->>'entity_type', '')), ''), 'domestic_company');
  IF v_entity NOT IN ('domestic_company', 'domestic_individual', 'foreign', 'foreign_individual') THEN
    RAISE EXCEPTION 'VENDOR_BAD_ENTITY_TYPE: 不認得的實體類型「%」', v_entity
      USING ERRCODE = 'check_violation';
  END IF;

  v_tax_id     := nullif(btrim(coalesce(p_payload->>'tax_id', '')), '');
  v_id_number  := upper(nullif(btrim(coalesce(p_payload->>'id_number', '')), ''));
  v_foreign_id := nullif(btrim(coalesce(p_payload->>'foreign_id', '')), '');
  v_permit     := nullif(btrim(coalesce(p_payload->>'residence_permit_number', '')), '');

  -- (a) 識別碼依實體類型必填 —— 在這裡擋，不在瀏覽器擋。（國內個人自 0061 起例外，見下）
  IF v_entity = 'domestic_company'    AND v_tax_id     IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_TAX_ID: 國內公司必須填統一編號' USING ERRCODE = 'check_violation';
  END IF;
  -- 0061：國內個人的身分證字號**不再必填**（個人戶可不填，日後要開扣繳憑單再補）。
  --       有填就要長得像台灣身分證／新式居留證：一個英文字母 + 1／2／8／9 + 8 碼數字。
  --       檢查碼在 vendorSchema 驗（錯誤才會出現在欄位旁邊）；這裡只守形狀，擋直接 POST。
  IF v_id_number IS NOT NULL AND v_id_number !~ '^[A-Z][1289][0-9]{8}$' THEN
    RAISE EXCEPTION 'VENDOR_BAD_ID_NUMBER: 身分證字號格式不正確（應為 1 個英文字母加 9 碼數字，例如 A123456789）'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_entity = 'foreign'             AND v_foreign_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_FOREIGN_ID: 國外法人必須填國外識別碼' USING ERRCODE = 'check_violation';
  END IF;
  IF v_entity = 'foreign_individual'  AND v_foreign_id IS NULL AND v_permit IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_FOREIGN_OR_PERMIT: 國外個人必須填國外識別碼或居留證號碼'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) 費率是 0–1 的小數（畫面上是百分比，換算在前端，但值域在這裡守）。
  PERFORM inv.assert_rate(p_payload->>'cash_fee_rate',          '現金手續費率');
  PERFORM inv.assert_rate(p_payload->>'domestic_card_fee_rate', '國內信用卡手續費率');
  PERFORM inv.assert_rate(p_payload->>'foreign_card_fee_rate',  '國外信用卡手續費率');
  PERFORM inv.assert_rate(p_payload->>'commission_rate',        '抽成比例');

  -- (c) 結算日 1–31。
  PERFORM inv.assert_day_of_month(p_payload->>'settlement_start_day', '結算起算日');
  PERFORM inv.assert_day_of_month(p_payload->>'bill_due_day',         '帳單截止日');

  -- status 是「還有沒有在往來」，與 approval_status 是兩件事。來源的表單根本
  -- 沒有這個欄位的入口（型別有、DB 有、UI 沒有），所以停用廠商實際上做不到。
  v_status := coalesce(nullif(btrim(coalesce(p_payload->>'status', '')), ''), 'active');
  IF v_status NOT IN ('active', 'suspended', 'inactive') THEN
    RAISE EXCEPTION 'VENDOR_BAD_STATUS: 不認得的往來狀態「%」', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO inv.vendors (
      entity_type, category_id, name, name_en, short_name, representative,
      tax_id, id_number, foreign_id, foreign_id_type, residence_permit_number,
      taiwan_residency_status, country_code,
      phone, fax, email, address, address_en, invoice_address,
      default_tax_type_id, default_withholding_category_id, is_nhi_applicable,
      voucher_category, einvoice_type,
      payment_terms, payment_terms_note, settlement_type,
      settlement_start_day, settlement_interval_days, bill_due_day,
      is_consignment, cash_fee_rate, domestic_card_fee_rate, foreign_card_fee_rate,
      commission_rate, is_preferred, notes, status,
      created_by, approval_status
    ) VALUES (
      v_entity,
      (p_payload->>'category_id')::uuid,
      v_name,
      nullif(btrim(coalesce(p_payload->>'name_en', '')), ''),
      nullif(btrim(coalesce(p_payload->>'short_name', '')), ''),
      nullif(btrim(coalesce(p_payload->>'representative', '')), ''),
      v_tax_id, v_id_number, v_foreign_id,
      nullif(btrim(coalesce(p_payload->>'foreign_id_type', '')), ''),
      v_permit,
      nullif(btrim(coalesce(p_payload->>'taiwan_residency_status', '')), ''),
      nullif(btrim(coalesce(p_payload->>'country_code', '')), ''),
      nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      nullif(btrim(coalesce(p_payload->>'fax', '')), ''),
      nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      nullif(btrim(coalesce(p_payload->>'address', '')), ''),
      nullif(btrim(coalesce(p_payload->>'address_en', '')), ''),
      nullif(btrim(coalesce(p_payload->>'invoice_address', '')), ''),
      (p_payload->>'default_tax_type_id')::uuid,
      (p_payload->>'default_withholding_category_id')::uuid,
      coalesce((p_payload->>'is_nhi_applicable')::boolean, false),
      coalesce(nullif(btrim(coalesce(p_payload->>'voucher_category', '')), ''), 'invoice'),
      coalesce(nullif(btrim(coalesce(p_payload->>'einvoice_type', '')), ''), 'none'),
      coalesce(nullif(btrim(coalesce(p_payload->>'payment_terms', '')), ''), 'immediate'),
      nullif(btrim(coalesce(p_payload->>'payment_terms_note', '')), ''),
      coalesce(nullif(btrim(coalesce(p_payload->>'settlement_type', '')), ''), 'invoice_date'),
      nullif(p_payload->>'settlement_start_day', '')::integer,
      nullif(p_payload->>'settlement_interval_days', '')::integer,
      nullif(p_payload->>'bill_due_day', '')::integer,
      coalesce((p_payload->>'is_consignment')::boolean, false),
      coalesce(nullif(p_payload->>'cash_fee_rate', '')::numeric, 0.08),
      coalesce(nullif(p_payload->>'domestic_card_fee_rate', '')::numeric, 0.101),
      coalesce(nullif(p_payload->>'foreign_card_fee_rate', '')::numeric, 0.1115),
      nullif(p_payload->>'commission_rate', '')::numeric,
      coalesce((p_payload->>'is_preferred')::boolean, false),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      v_status,
      p_user_id,
      inv.initial_approval_status('vendors')   -- ← 不是從 payload 拿
    )
    RETURNING id INTO v_id;
    v_created := true;
  ELSE
    UPDATE inv.vendors SET
      entity_type              = v_entity,
      category_id              = (p_payload->>'category_id')::uuid,
      name                     = v_name,
      name_en                  = nullif(btrim(coalesce(p_payload->>'name_en', '')), ''),
      short_name               = nullif(btrim(coalesce(p_payload->>'short_name', '')), ''),
      representative           = nullif(btrim(coalesce(p_payload->>'representative', '')), ''),
      tax_id                   = v_tax_id,
      id_number                = v_id_number,
      foreign_id               = v_foreign_id,
      foreign_id_type          = nullif(btrim(coalesce(p_payload->>'foreign_id_type', '')), ''),
      residence_permit_number  = v_permit,
      taiwan_residency_status  = nullif(btrim(coalesce(p_payload->>'taiwan_residency_status', '')), ''),
      country_code             = nullif(btrim(coalesce(p_payload->>'country_code', '')), ''),
      phone                    = nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      fax                      = nullif(btrim(coalesce(p_payload->>'fax', '')), ''),
      email                    = nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      address                  = nullif(btrim(coalesce(p_payload->>'address', '')), ''),
      address_en               = nullif(btrim(coalesce(p_payload->>'address_en', '')), ''),
      invoice_address          = nullif(btrim(coalesce(p_payload->>'invoice_address', '')), ''),
      default_tax_type_id      = (p_payload->>'default_tax_type_id')::uuid,
      default_withholding_category_id = (p_payload->>'default_withholding_category_id')::uuid,
      is_nhi_applicable        = coalesce((p_payload->>'is_nhi_applicable')::boolean, false),
      voucher_category         = coalesce(nullif(btrim(coalesce(p_payload->>'voucher_category', '')), ''), 'invoice'),
      einvoice_type            = coalesce(nullif(btrim(coalesce(p_payload->>'einvoice_type', '')), ''), 'none'),
      payment_terms            = coalesce(nullif(btrim(coalesce(p_payload->>'payment_terms', '')), ''), 'immediate'),
      payment_terms_note       = nullif(btrim(coalesce(p_payload->>'payment_terms_note', '')), ''),
      settlement_type          = coalesce(nullif(btrim(coalesce(p_payload->>'settlement_type', '')), ''), 'invoice_date'),
      settlement_start_day     = nullif(p_payload->>'settlement_start_day', '')::integer,
      settlement_interval_days = nullif(p_payload->>'settlement_interval_days', '')::integer,
      bill_due_day             = nullif(p_payload->>'bill_due_day', '')::integer,
      is_consignment           = coalesce((p_payload->>'is_consignment')::boolean, false),
      cash_fee_rate            = coalesce(nullif(p_payload->>'cash_fee_rate', '')::numeric, 0.08),
      domestic_card_fee_rate   = coalesce(nullif(p_payload->>'domestic_card_fee_rate', '')::numeric, 0.101),
      foreign_card_fee_rate    = coalesce(nullif(p_payload->>'foreign_card_fee_rate', '')::numeric, 0.1115),
      commission_rate          = nullif(p_payload->>'commission_rate', '')::numeric,
      is_preferred             = coalesce((p_payload->>'is_preferred')::boolean, false),
      notes                    = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      status                   = v_status,
      updated_by               = p_user_id,
      updated_at               = now()
      -- ⚠️ approval_status / approved_by / approved_at 不在這裡。編輯不該改審核狀態。
    WHERE id = p_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VENDOR_NOT_FOUND: 找不到這家廠商' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  SELECT vendor_code, approval_status INTO v_code, v_status FROM inv.vendors WHERE id = v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'created', v_created,
    'vendor_code', v_code, 'approval_status', v_status);
END;
$$;

comment on function public.inv_save_vendor(uuid, uuid, jsonb) is
  '新增／編輯廠商。payload 逐欄具名取出 —— approval_status / created_by / vendor_code 送進來也不會被讀。識別碼依 entity_type 必填（國內公司統編、國外法人國外識別碼、國外個人識別碼或居留證擇一；國內個人的身分證字號自 0061 起選填，有填仍驗形狀）、費率 0–1、結算日 1–31 都在這裡守。';

revoke execute on function public.inv_save_vendor(uuid, uuid, jsonb) from public;
revoke execute on function public.inv_save_vendor(uuid, uuid, jsonb) from anon, authenticated;
grant  execute on function public.inv_save_vendor(uuid, uuid, jsonb) to service_role;

commit;
