/**
 * Server-only environment access.
 *
 * IMPORTANT: never name a secret with a `VITE_` prefix. The Vite config
 * (@lovable.dev/vite-tanstack-config) runs `loadEnv(mode, cwd, "VITE_")` and
 * turns every match into a compile-time `define` — applied to BOTH the client
 * and the SSR bundle. A `VITE_`-prefixed service role key would ship to the
 * browser as a string literal.
 *
 * Secrets are therefore read from `process.env` at request time, and this
 * module lives under `src/server/**` so the build's import protection
 * (behavior: "error") fails the build if it is ever reachable from client code.
 */
import "@tanstack/react-start/server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[server/env] Missing required environment variable ${name}. ` +
        `Set it in .env.local for local dev and in the Vercel project settings for deploys. ` +
        `Do NOT add a VITE_ prefix — that would expose it to the browser.`,
    );
  }
  return value;
}

/** Supabase project URL. Public information — safe to share with the client. */
export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL;
}

/** Service role key. Bypasses RLS — must never leave the server. */
export function supabaseServiceRoleKey(): string {
  return required("SUPABASE_SERVICE_ROLE_KEY");
}

/** Secret used to seal the admin session cookie (>= 32 chars). */
export function adminSessionSecret(): string {
  return required("ADMIN_SESSION_SECRET");
}

/**
 * Google Gemini API key, for the OCR (拍照辨識) server functions.
 *
 * 來源進銷存打的是 Lovable AI Gateway（`ai.gateway.lovable.dev`，OpenAI 相容的
 * /v1/chat/completions），金鑰是那個平台發的。離開平台就失效，所以 4a/4b 把 OCR
 * 入口整個拿掉、留到這一期改接 Gemini 原生 API。
 *
 * ⚠️ 沒有 VITE_ 前綴，理由見本檔開頭：那會被 define 進**瀏覽器** bundle。
 */
export function geminiApiKey(): string {
  return required("GEMINI_API_KEY");
}

/**
 * OCR 用的模型。
 *
 * ⚠️ 原訂是沿用來源的 `gemini-2.5-flash` 以便比較辨識品質，**但那個模型已經不能
 *    用了**：Google 對新金鑰關閉了它，實測回 404 —— "This model
 *    models/gemini-2.5-flash is no longer available to new users."（models 清單
 *    裡還列著它，但 generateContent 會 404，所以不能靠列表判斷可用性）。
 *
 * 所以預設值是 `gemini-3.5-flash`（同一條 flash 產線的現役版本，實測可用）。
 * 寫成環境變數而不是常數，是因為哪天拿到 2.5 的存取權，改一個 Vercel 環境變數
 * 就能切回去比對，不必動程式。
 */
export function geminiOcrModel(): string {
  return process.env.GEMINI_OCR_MODEL || "gemini-3.5-flash";
}

/**
 * 後台三語欄位「自動翻譯」用的模型（src/server/translate.ts）。
 *
 * ⚠️ **刻意不共用 `GEMINI_OCR_MODEL`。** 兩件事的失敗長得完全不一樣 —— 辨識爛掉是
 *    店員重拍一張，翻譯爛掉是十支後台表單同時填不出英日文。共用一個變數的意思是
 *    「為了調辨識品質而動的那一下，會順手改掉翻譯」，而那個副作用不會有人預期到。
 *    一個旋鈕管一件事。
 *
 * ⚠️ 預設值同樣是 `gemini-3.5-flash`，理由與 geminiOcrModel() 一樣：`gemini-2.5-flash`
 *    對新申請的金鑰已經 404（"no longer available to new users"），而且**它仍然留在
 *    models.list 的回傳裡** —— 不能靠列表判斷可不可用，只有真的打一次才知道。
 *
 * ⚠️ 3.5-flash 預設會「思考」，而思考的 token 算在 maxOutputTokens 裡面。翻譯不需要
 *    推理，所以 translate.ts 一律送 thinkingConfig.thinkingBudget = 0。那一條規則在
 *    程式碼那一側，這裡只決定打哪一個模型。
 */
export function geminiTranslateModel(): string {
  return process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash";
}

/**
 * MCP「對外動作」兩步確認（寄信給客人）的 HMAC 祕密來源（src/server/mcp/outbound-tools.ts）。
 *
 * 不新增環境變數：沿用 MCP 已經有的伺服器祕密，優先 MCP_OAUTH_SECRET（OAuth 連接器必設），
 * 沒有才退回 MCP_TOKEN（靜態 token）。兩個都沒有（或短於 16 字）→ null，呼叫端一律拒絕寄給
 * 客人（fail closed）。呼叫端會再用固定標籤 HMAC 派生一把專用金鑰，不直接拿這把當簽章鑰匙，
 * 所以確認碼與 OAuth token 不會互相通用。
 */
export function mcpConfirmSecret(): string | null {
  const oauth = (process.env.MCP_OAUTH_SECRET ?? "").trim();
  if (oauth.length >= 16) return oauth;
  const token = (process.env.MCP_TOKEN ?? "").trim();
  if (token.length >= 16) return token;
  return null;
}
