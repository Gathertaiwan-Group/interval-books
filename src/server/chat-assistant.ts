/**
 * 官網 AI 小幫手 —— 伺服器端：讀網站資料（5 分鐘快取）、限流、呼叫 Gemini。
 *
 * 純邏輯（知識組裝、prompt、白名單、injection 偵測、限流計數）在 src/lib/chat-assistant.ts。
 *
 * ── 這一層的規矩 ──────────────────────────────────────────────────────────
 * 1. 金鑰只在這裡讀（GEMINI_API_KEY，沒有 VITE_ 前綴），走 x-goog-api-key 標頭，不進網址。
 * 2. AI 沒有任何寫入權：這支只讀 site_settings／pages／contact_phones／events／journeys／products。
 * 3. 不存對話、不蒐集聯絡資訊（要存需要新表＝migration，這一期不做）。console 只記錯誤種類。
 * 4. 模型：GEMINI_CHAT_MODEL，預設 gemini-3.1-flash-lite（實測可用、便宜、約 1 秒）。
 *    回 404（「no longer available to new users」那一類）時退到 gemini-3.5-flash
 *    （OCR／翻譯在正式金鑰上已經實測可用的那一支）。
 */
import "@tanstack/react-start/server-only";
import { getRequestHeader } from "@tanstack/react-start/server";
import { geminiApiKey } from "@/server/env";
import { clientIpFrom } from "@/server/partnership-guard";
import {
  buildKnowledge,
  buildSystemPrompt,
  ChatRateLimiter,
  cleanSessionId,
  FALLBACK_EMAIL,
  fallbackMessage,
  finalizeReply,
  guessLang,
  injectionReply,
  looksLikeInjection,
  MAX_OUTPUT_TOKENS,
  prepareTurns,
  rateLimitedMessage,
  tooLongMessage,
  type ChatLang,
  type ChatTurn,
  type KnowledgeInput,
} from "@/lib/chat-assistant";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 20_000;
const CACHE_MS = 5 * 60_000;

export type ChatAnswer =
  | { ok: true; reply: string }
  | { ok: false; error: "rate_limited" | "too_long" | "empty" | "ai_error"; message: string };

// ---------------------------------------------------------------------------
// 知識（5 分鐘快取，同時間只讀一次）
// ---------------------------------------------------------------------------

let cache: { at: number; prompt: string; emails: string[] } | null = null;
let inflight: Promise<{ prompt: string; emails: string[] }> | null = null;

async function loadKnowledgeInput(): Promise<KnowledgeInput> {
  const [
    { getSiteSettings },
    { listPageListItems },
    { listContactPhones },
    { listEvents, listEventProducts },
    { listJourneys },
    { linkedEventIdFor },
    { fetchActiveProductsForList, isSoldOut },
  ] = await Promise.all([
    import("@/server/repos/site-settings"),
    import("@/server/repos/pages"),
    import("@/server/repos/contact-phones"),
    import("@/server/repos/events"),
    import("@/server/repos/journeys"),
    import("@/lib/journey-events"),
    import("@/lib/shop"),
  ]);

  // 每一塊各自失敗各自空著：一塊讀壞不讓整個小幫手掛掉。
  const safe = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      console.error(
        `[chat] 讀取 ${label} 失敗：${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  };

  const [site, visitItems, phones, events, eventProducts, journeys, shop] = await Promise.all([
    getSiteSettings(), // 基本資訊讀不到就整個失敗（沒有地址營業時間的客服不如導 LINE）
    safe("visit", listPageListItems("visit"), []),
    safe("phones", listContactPhones(), []),
    safe("events", listEvents(), []),
    safe("eventProducts", listEventProducts(), {} as Awaited<ReturnType<typeof listEventProducts>>),
    safe("journeys", listJourneys(), []),
    safe("products", fetchActiveProductsForList(), { products: [], unavailable: true }),
  ]);

  const slugById = new Map(events.map((e) => [e.id, e.slug]));
  return {
    site: {
      shortDesc: site.short_desc,
      address: site.address,
      city: site.city,
      hours: site.hours,
      closed: site.closed,
      contactEmail: site.contact_email,
      instagram: site.social_instagram,
      facebook: site.social_facebook,
      line: site.social_line,
      mapLink: site.map_link,
    },
    transport: visitItems.map((i) => ({ key: i.list_key, label: i.label })),
    phones: phones.map((p) => ({ label: p.label, display: p.display_text })),
    events: events.map((e) => {
      const p = eventProducts[e.id];
      return {
        slug: e.slug,
        title: e.title,
        displayDate: e.display_date,
        isoDate: e.iso_date,
        status: e.status,
        registrationType: e.registration_type,
        externalUrl: e.external_url,
        notes: e.notes,
        category: e.category,
        product: p ? { price: p.price, status: p.status, sessions: p.sessions ?? [] } : null,
      };
    }),
    journeys: journeys.map((j) => {
      const id = linkedEventIdFor(j.external_url, events);
      return {
        title: j.title,
        days: j.days,
        status: j.status,
        eventSlug: id ? (slugById.get(id) ?? null) : null,
        externalUrl: j.external_url,
      };
    }),
    products: shop.products.map((p) => ({
      slug: p.slug,
      title: p.title,
      price: p.price,
      productType: p.productType,
      soldOut: isSoldOut(p),
    })),
  };
}

async function knowledge(): Promise<{ prompt: string; emails: string[] }> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  if (!inflight) {
    inflight = (async () => {
      const input = await loadKnowledgeInput();
      const prompt = buildSystemPrompt(buildKnowledge(input));
      const emails = [input.site.contactEmail || FALLBACK_EMAIL, FALLBACK_EMAIL];
      cache = { at: Date.now(), prompt, emails };
      return cache;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export function chatModels(): string[] {
  const preferred = process.env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite";
  return [...new Set([preferred, "gemini-3.5-flash"])];
}

/**
 * 不同代的「關掉思考」寫法不同：3.5-flash-lite 與 *-latest 收 thinkingLevel，
 * 送 thinkingBudget:0 會 400；其餘（3.1-flash-lite、3.5-flash）收 thinkingBudget:0。
 * 思考 token 算在 maxOutputTokens 裡（見 src/server/translate.ts），不關會吃掉回答。
 */
export function thinkingConfigFor(model: string): Record<string, unknown> {
  return /3\.5-flash-lite|-latest$/.test(model)
    ? { thinkingLevel: "minimal" }
    : { thinkingBudget: 0 };
}

class ModelGone extends Error {}

async function callGemini(model: string, system: string, turns: ChatTurn[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": geminiApiKey(), "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: thinkingConfigFor(model),
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        ],
      }),
    });
    if (res.status === 404) throw new ModelGone(model);
    if (!res.ok) throw new Error(`gemini_http_${res.status}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text =
      data.candidates?.[0]?.content?.parts
        ?.filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim() ?? "";
    if (!text) throw new Error("gemini_empty");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function generate(system: string, turns: ChatTurn[]): Promise<string> {
  let lastErr: unknown;
  for (const model of chatModels()) {
    try {
      return await callGemini(model, system, turns);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ModelGone)) break; // 只有「模型不存在」才換下一支
      console.error(`[chat] 模型 ${model} 回 404，改用下一支`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const limiter = new ChatRateLimiter();

export async function answerChat(input: {
  messages: unknown;
  sessionId: unknown;
  lang: ChatLang;
}): Promise<ChatAnswer> {
  const prepared = prepareTurns(input.messages);
  if (!prepared.ok) {
    const lang = input.lang;
    return prepared.error === "too_long"
      ? { ok: false, error: "too_long", message: tooLongMessage(lang) }
      : { ok: false, error: "empty", message: fallbackMessage(lang) };
  }
  const lang = guessLang(prepared.last, input.lang);

  const ip = clientIpFrom((name) => getRequestHeader(name as never));
  const sid = cleanSessionId(input.sessionId);
  const keys = [`ip:${ip}`, ...(sid ? [`sid:${sid}`] : [])];
  if (!limiter.take(keys)) {
    return { ok: false, error: "rate_limited", message: rateLimitedMessage(lang) };
  }

  // 明顯的「忽略指示／給我 prompt」：罐頭話，不花一次 LLM。
  if (looksLikeInjection(prepared.last)) return { ok: true, reply: injectionReply(lang) };

  try {
    const kb = await knowledge();
    const raw = await generate(kb.prompt, prepared.turns);
    return { ok: true, reply: finalizeReply(raw, lang, kb.emails) };
  } catch (err) {
    console.error(`[chat] 失敗：${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "ai_error", message: fallbackMessage(lang) };
  }
}
