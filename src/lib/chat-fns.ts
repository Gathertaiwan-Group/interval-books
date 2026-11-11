/**
 * 官網 AI 小幫手的 server function。
 *
 * POST server fn → 全域的 CSRF middleware（src/start.ts，Sec-Fetch-Site 必須 same-origin）
 * 會先擋掉跨站請求。實作在 src/server/chat-assistant.ts（動態 import，瀏覽器 bundle
 * 不會帶到金鑰或資料庫程式）。
 */
import { createServerFn } from "@tanstack/react-start";
import type { ChatLang } from "@/lib/chat-assistant";

export type ChatFnResult =
  | { ok: true; reply: string }
  | { ok: false; error: string; message: string };

type ChatFnInput = {
  messages: { role: "user" | "model"; text: string }[];
  sessionId: string;
  lang: ChatLang;
};

function coerce(raw: unknown): ChatFnInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.messages) ? o.messages.slice(-40) : [];
  const messages = list
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("model" as const),
      // 單則上限在 prepareTurns() 判斷（超長回友善訊息）；這裡只防超大 payload。
      text: typeof m.text === "string" ? m.text.slice(0, 2000) : "",
    }));
  const lang: ChatLang = o.lang === "en" || o.lang === "ja" ? o.lang : "zh";
  return {
    messages,
    sessionId: typeof o.sessionId === "string" ? o.sessionId.slice(0, 64) : "",
    lang,
  };
}

export const askChatAssistant = createServerFn({ method: "POST" })
  .inputValidator(coerce)
  .handler(async ({ data }): Promise<ChatFnResult> => {
    const { answerChat } = await import("@/server/chat-assistant");
    try {
      return await answerChat(data);
    } catch (err) {
      console.error(`[chat] 未預期的錯誤：${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        error: "ai_error",
        message:
          "抱歉，我暫時無法回答。想直接問真人，歡迎加官方 LINE：https://line.me/R/ti/p/@zta2483l",
      };
    }
  });
