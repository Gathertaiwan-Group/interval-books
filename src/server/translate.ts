/**
 * Gemini —— 後台三語欄位「自動翻譯」唯一的對外出口。
 *
 * ── 這是填空幫手，不是送出管線 ────────────────────────────────────────────
 * LocalizedField 本來就長這樣：一個中文框、一個摺疊起來的英日區、一顆「複製中文
 * 到英日」，而且英日只要有一個是空的就**拒絕摺疊**。這一支只是在旁邊多一顆按鈕
 * 幫忙把那兩格填起來，架構一個字都沒動。
 *
 * 這個決定把大部分失敗模式直接消掉：
 *   · API 掛了／逾時／回的不是合法 JSON → 跳一個 toast，兩個框**維持空白而且攤開
 *     在畫面上**。人看得見、可以自己打、可以按既有的「複製中文到英日」。沒有隱形失敗。
 *   · 翻譯發生在**按按鈕的當下**，不是按送出的當下。送出時才發現翻譯壞掉是最糟的
 *     時機 —— 那時人已經填完整張表準備離開了。
 *   · 「可以覆寫嗎？」可以，而且是預設 —— 那三個框本來就一直在，翻完照樣能改。
 *
 * ── 兩個一定要處理的 Gemini 陷阱 ──────────────────────────────────────────
 * 1. **`gemini-2.5-flash` 對新申請的金鑰已經 404**（"no longer available to new
 *    users"），**但它仍然留在 models.list 的回傳裡**。也就是說「列表查得到」不等於
 *    「打得通」，可用性只有真的送一次 generateContent 才知道。預設走
 *    `gemini-3.5-flash`（見 env.ts#geminiTranslateModel）。
 *
 * 2. **3.5-flash 預設會思考，而思考的 token 算在 `maxOutputTokens` 裡。** 實測拿
 *    「用三句話回答一個問題」配 `maxOutputTokens: 600`：不設 thinkingConfig 時思考
 *    吃掉 572，只剩 24 個 token 給輸出，回覆被截斷成漏出思考過程的英文碎片 ——
 *    而且 HTTP 是 200，`finishReason` 才是 `MAX_TOKENS`。翻譯不需要推理，所以
 *    **一律送 `generationConfig.thinkingConfig.thinkingBudget = 0`**，又快又省。
 *    驗收看 `usageMetadata.thoughtsTokenCount === 0`（scripts/translate-selftest.mjs）。
 *
 * ⚠️ 這個檔案只負責「問模型、拿回結構化答案」。它不寫任何一張表 —— 翻譯結果是塞回
 *    表單的兩個 input，人按下儲存才會進資料庫，走的是既有那條路。AI 沒有寫入權。
 */
import "@tanstack/react-start/server-only";
import { geminiApiKey, geminiTranslateModel } from "./env";

/** 翻譯失敗的分類。逐字對齊 gemini.ts 的 OcrFailureKind —— 前端據此決定要說什麼。 */
export type TranslateFailureKind =
  | "quota" // 429/402/403：額度、頻率或金鑰
  | "timeout" // 逾時
  | "bad_response" // 模型回了東西，但不是我們要的形狀
  | "no_content" // 模型沒有給出可用的翻譯（含只回了一種語言）
  | "service"; // 其他（5xx、網路）

export class TranslateError extends Error {
  readonly kind: TranslateFailureKind;
  constructor(kind: TranslateFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * trim 之後任一語言是空的 —— 這一句刻意抽成常數，讓自檢釘得住這條規則。
 *
 * ⚠️ 為什麼空字串必須是失敗而不是「翻不出來就算了」：資料庫的 `is_localized()`
 *    CHECK（0001_init.sql:56-68）只檢查三個 key **存在**，空字串完全過得了，然後
 *    前台就渲染出一塊空白 —— 一個沒有人會收到告警的錯誤。所以在這一層就擋掉，
 *    讓前端**根本拿不到空字串可以寫**。
 */
export const TRANSLATE_EMPTY = "翻譯只回了其中一種語言，沒有填進去。請再試一次，或自己填寫英日文。";

/** 超過這個時間就放棄。與 OCR 同一個數字，理由也一樣：盯著轉圈圈超過半分鐘的人會直接關掉。 */
const TIMEOUT_MS = 30_000;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** 送進去的中文上限。三語欄位最長的是介紹文，2000 字綽綽有餘，也擋住整本書被貼進來。 */
const MAX_INPUT_CHARS = 2000;

/** 收回來的每一種語言的上限。日文／英文比中文長，抓 3 倍。 */
const MAX_OUTPUT_CHARS = 6000;

export type TranslateResult = { en: string; ja: string };

// ---------------------------------------------------------------------------
// responseSchema —— 讓模型自己保證形狀
// ---------------------------------------------------------------------------
// 兩個欄位都是 required 而且**都不是 nullable**：這裡跟 OCR 的取捨剛好相反。
// 辨識不出廠商時回 null 是誠實；但「這段中文翻不出英文」不是一個合理的答案，
// 模型真的給不出來的時候我們要的是一個看得見的失敗，不是一個安靜的 null。

const TRANSLATE_SCHEMA = {
  type: "OBJECT",
  properties: {
    en: { type: "STRING", description: "英文翻譯，只有譯文本身" },
    ja: { type: "STRING", description: "日文翻譯，只有譯文本身" },
  },
  required: ["en", "ja"],
} as const;

const TRANSLATE_SYSTEM = [
  "你是一間台灣獨立書店官方網站的翻譯助手。把使用者給的繁體中文翻成英文與日文。",
  "規則：",
  "1. 只回譯文本身。不要加註解、不要加引號、不要重複原文、不要解釋你怎麼翻的。",
  "2. 這些字會直接出現在網站上（活動名稱、標題、介紹、按鈕文字），所以語氣要像文案，",
  "   不是逐字直譯。書店與藝文場域的措辭優先。",
  "3. 保留原文的換行與段落。原文只有一行就回一行。",
  "4. 專有名詞（人名、店名、品牌、地名）沿用通行譯法；沒有通行譯法就用羅馬拼音，",
  "   不要自己發明意譯。",
  "5. 原文若已經是英文或日文，仍然要給出另外兩種語言各自自然的說法，不要原封不動照抄。",
  "6. 兩個欄位都一定要有內容，不可以留空。",
  "7. 原文的【】是中文標題的強調括號：日文照用【】；英文不要用任何括號或引號包起來，",
  "   把括號裡的字當成主標，後面接「 — 」再接副標（例：【海的聲音】分享會 → The Voice of the Sea — A Talk）。",
].join("\n");

/**
 * 英文譯文裡被模型當成 JSON 陣列寫出來的【】：`["主標"] 副標` → `主標 — 副標`。
 *
 * 2026-10-21《海的聲音》的英文標題就是這樣上站的：`["Have You Heard the Voice of the
 * Sea?"] Hu Hai-Yin ...`。prompt 第 7 條叫模型別這樣寫，這裡是它不聽話時的保險 ——
 * 只認「方括號＋引號」與英文裡殘留的【】這兩種形狀，其他方括號（例如 `[Online]`）原樣保留。
 */
export function cleanEnglishBrackets(en: string): string {
  const BRACKET = /\[\s*["\u201c\u201d]([^"\u201c\u201d\]]+)["\u201c\u201d]\s*\]|【([^】]+)】/g;
  return en
    .split("\n")
    .map((line) => {
      const lead = line.match(/^\s*/)?.[0] ?? "";
      const body = line.slice(lead.length);
      const out = body.replace(
        BRACKET,
        (m, a: string | undefined, b: string | undefined, offset: number) => {
          const inner = (a ?? b ?? "").trim();
          const rest = body.slice(offset + m.length).trim();
          // 開頭的那一組是主標：後面還有字就接「 — 」。中間的就只拿掉括號。
          return offset === 0 && rest ? `${inner} — ` : inner;
        },
      );
      return lead + out.replace(/ — \s+/g, " — ").replace(/\s+$/, "");
    })
    .join("\n");
}

/**
 * 真正送出去的 request body。**抽成函式是為了讓自檢驗得到「production 真的送了什麼」**，
 * 而不是去 grep 原始碼裡有沒有出現 thinkingBudget 這幾個字（註解裡也會出現那幾個字）。
 */
export function buildTranslateRequest(zh: string): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: zh }] }],
    systemInstruction: { parts: [{ text: TRANSLATE_SYSTEM }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: TRANSLATE_SCHEMA,
      // 翻譯同一句話應該每次都得到同一個答案。0 讓人回報「這句翻錯了」時查得下去。
      temperature: 0,
      // ⚠️ 這一行是這個檔案最重要的一行，理由見檔頭第 2 點。拿掉它，思考的 token
      //    會去搶輸出的額度，回來的 JSON 被截斷，然後 JSON.parse 失敗 —— 而 HTTP
      //    是 200，看起來完全正常。
      thinkingConfig: { thinkingBudget: 0 },
      // ⚠️ **刻意不設 maxOutputTokens。** 三語欄位裡最長的是介紹文，設一個猜出來的
      //    上限只會在最長的那幾筆上安靜地截斷。thinkingBudget 已經歸零，不會再有
      //    思考跟輸出搶額度的問題；真的爆掉時 finishReason 會是 MAX_TOKENS，下面
      //    有一條專門認它。
    },
  };
}

// ---------------------------------------------------------------------------
// 送出
// ---------------------------------------------------------------------------

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { thoughtsTokenCount?: number };
};

async function callGemini(zh: string): Promise<unknown> {
  const model = geminiTranslateModel();

  // ⚠️ 金鑰在 try **外面**取。geminiApiKey() 在缺 GEMINI_API_KEY 時會丟一個講得很
  //    清楚的設定錯誤（「Set it in .env.local … and in the Vercel project settings」），
  //    而如果讓它在下面那個 try 裡面被求值，它會被 catch 收成 TranslateError("service",
  //    "無法連線到翻譯服務") —— 於是「環境變數沒設」長得跟「Google 掛了」一模一樣，
  //    管理員會去查網路，而真正要做的是去 Vercel 補一個變數。實測過這條路徑。
  const apiKey = geminiApiKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      // 金鑰走 header，不走 query string —— 網址會進 log、進 error report。
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(buildTranslateRequest(zh)),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TranslateError(
        "timeout",
        "翻譯逾時（超過 30 秒）。可以再按一次，或自己填寫英日文。",
      );
    }
    throw new TranslateError("service", "無法連線到翻譯服務，請自己填寫英日文。");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // ⚠️ 金鑰不對的時候 Google 回的是 **400**（`API key not valid`），不是 401 也不是
    //    403。只看狀態碼會把它歸到最下面那句「翻譯服務暫時無法使用（400）」，然後管理員
    //    會去查服務有沒有掛，而真正要做的是換一把金鑰。所以這裡讀一下 body 分辨。
    //    body 只用來比對關鍵字，永遠不會被原樣丟給使用者 —— 它可能含有請求內容。
    if (response.status === 400) {
      const detail = await response.text().catch(() => "");
      if (/api[ _-]?key/i.test(detail)) {
        throw new TranslateError(
          "quota",
          "翻譯服務的金鑰不正確，請通知管理員確認 GEMINI_API_KEY。可以先自己填寫英日文。",
        );
      }
      throw new TranslateError("service", "翻譯服務不接受這次的請求（400），請自己填寫英日文。");
    }
    // 額度用完（等一下就好）與服務掛掉（等多久都沒用）是兩件事，不可以講同一句話。
    if (response.status === 429) {
      throw new TranslateError(
        "quota",
        "翻譯服務目前忙碌（額度或頻率上限），請稍後再試，或自己填寫英日文。",
      );
    }
    if (response.status === 402 || response.status === 403) {
      throw new TranslateError(
        "quota",
        "翻譯服務的額度或金鑰有問題，請通知管理員。可以先自己填寫英日文。",
      );
    }
    // 404 幾乎一定是模型名稱：GEMINI_TRANSLATE_MODEL 被設成一個對這把金鑰
    // 已經關閉的版本（`gemini-2.5-flash` 就是這樣，而且它還留在 models.list 裡）。
    if (response.status === 404) {
      throw new TranslateError(
        "service",
        "翻譯服務找不到指定的模型（請管理員確認 GEMINI_TRANSLATE_MODEL）。可以先自己填寫英日文。",
      );
    }
    throw new TranslateError(
      "service",
      `翻譯服務暫時無法使用（${response.status}），請自己填寫英日文。`,
    );
  }

  let payload: GeminiResponse;
  try {
    payload = (await response.json()) as GeminiResponse;
  } catch {
    throw new TranslateError("bad_response", "翻譯服務回了無法解析的內容，請再試一次。");
  }

  // ⚠️ MAX_TOKENS 要單獨認出來。它的症狀是「JSON 被切一半」，如果讓它掉到下面的
  //    JSON.parse 去，人看到的會是「格式不正確」—— 那句話會把人引去查格式，而真正
  //    的原因是輸出額度不夠（最常見的成因就是 thinkingBudget 沒有歸零）。
  if (payload.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new TranslateError(
      "bad_response",
      "翻譯結果太長被截斷了。請把中文拆短一點再試，或自己填寫英日文。",
    );
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new TranslateError("no_content", "翻譯服務沒有回傳內容，請再試一次，或自己填寫英日文。");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // responseSchema 理論上保證是合法 JSON，但「理論上」不是驗收條件。
    throw new TranslateError("bad_response", "翻譯結果的格式不正確，請再試一次。");
  }
}

/**
 * 把模型回的東西收成我們的型別。
 *
 * responseSchema 管形狀，這裡管**語意**：trim 過、兩種語言都得有東西。模型再聽話
 * 也不是驗證器 —— 它完全有可能回 `{"en": "", "ja": ""}`，那完全符合 schema。
 */
export function normaliseTranslation(raw: unknown): TranslateResult {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const en = typeof obj.en === "string" ? cleanEnglishBrackets(obj.en.trim()).trim() : "";
  const ja = typeof obj.ja === "string" ? obj.ja.trim() : "";

  if (!en || !ja) {
    throw new TranslateError("no_content", TRANSLATE_EMPTY);
  }

  return { en: en.slice(0, MAX_OUTPUT_CHARS), ja: ja.slice(0, MAX_OUTPUT_CHARS) };
}

/**
 * 中文 → { en, ja }。
 *
 * ⚠️ 中文是空的就**不打 API**。那不是一個翻譯失敗，那是還沒填中文 —— 花一次額度
 *    去問模型「請翻譯空字串」沒有任何意義，而且拿回來的東西一定是垃圾。
 */
export async function translateToEnJa(input: { text: string }): Promise<TranslateResult> {
  const zh = input.text.trim();
  if (!zh) {
    throw new TranslateError("no_content", "請先填中文，再按自動翻譯。");
  }
  return normaliseTranslation(await callGemini(zh.slice(0, MAX_INPUT_CHARS)));
}
