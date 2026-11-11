/**
 * AI 小幫手的對話面板（lazy chunk，由 ChatLauncher 第一次點開時載入）。
 *
 * 手機：近全螢幕的底部抽屜；桌機（sm 以上）：右下 380px 浮窗。
 * 無障礙：role=dialog＋aria-labelledby、Esc 關閉、開啟時焦點進輸入框、Tab 在面板內循環、
 * 關閉時焦點回泡泡（ChatLauncher 處理）、訊息區 aria-live=polite。
 *
 * 對話只存在這個元件的 state（不存資料庫、不進 localStorage）；session id 放
 * sessionStorage，只用來做伺服器端限流。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Send, X } from "lucide-react";
import { askChatAssistant } from "@/lib/chat-fns";
import { LINE_URL, MAX_INPUT_CHARS, type ChatLang } from "@/lib/chat-assistant";

type Msg = { role: "user" | "model"; text: string };

const COPY = {
  zh: {
    title: "小時光 AI 小幫手",
    subtitle: "回答根據網站資料，細節請以頁面為準",
    greeting:
      "你好，我是小時光書店的 AI 小幫手。可以問我活動、策旅、書刊、營業時間與交通；需要真人協助，也可以直接加官方 LINE。",
    suggestions: ["最近有什麼活動？", "營業時間與交通", "可以包場或合作嗎？", "怎麼買書？"],
    placeholder: "輸入你的問題…",
    send: "送出",
    close: "關閉",
    typing: "正在輸入",
    human: "想找真人？",
    line: "加官方 LINE",
    network: `連線出了點問題，請稍後再試；也可以加官方 LINE：${LINE_URL}`,
  },
  en: {
    title: "Interval Books AI assistant",
    subtitle: "Answers are based on our website — please check each page for details",
    greeting:
      "Hi! I'm the AI assistant of Interval Books. Ask me about events, journeys, books, opening hours or directions. For a person, message us on LINE.",
    suggestions: [
      "What events are coming up?",
      "Hours & directions",
      "Private bookings or partnerships?",
      "How do I buy books?",
    ],
    placeholder: "Type your question…",
    send: "Send",
    close: "Close",
    typing: "Typing",
    human: "Prefer a person?",
    line: "Message us on LINE",
    network: `Connection problem — please try again, or message us on LINE: ${LINE_URL}`,
  },
  ja: {
    title: "小時光 AI アシスタント",
    subtitle: "サイトの情報をもとに回答します。詳細は各ページをご確認ください",
    greeting:
      "こんにちは、小時光書店の AI アシスタントです。イベント、旅、本、営業時間やアクセスについてお気軽にどうぞ。スタッフへのご相談は公式 LINE から。",
    suggestions: [
      "最近のイベントは？",
      "営業時間とアクセス",
      "貸切やコラボはできますか？",
      "本の買い方は？",
    ],
    placeholder: "ご質問を入力…",
    send: "送信",
    close: "閉じる",
    typing: "入力中",
    human: "スタッフに相談：",
    line: "公式 LINE",
    network: `接続に問題が発生しました。LINE からもお問い合わせいただけます：${LINE_URL}`,
  },
} as const;

const TOKEN_RE =
  /(https?:\/\/[^\s<>"'，。、；：！？（）「」]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** 回覆文字 → 可點的站內連結／LINE／Email（React 會轉義其餘文字，不會注入 HTML）。 */
function linkify(text: string): ReactNode[] {
  return text.split(TOKEN_RE).map((part, i) => {
    if (!part) return null;
    if (/^https?:\/\//.test(part)) {
      let url: URL | null = null;
      try {
        url = new URL(part);
      } catch {
        url = null;
      }
      if (!url) return part;
      const internal = /(^|\.)intervalbooks\.tw$/i.test(url.hostname);
      const href = internal ? `${url.pathname}${url.search}${url.hash}` : url.href;
      const label = internal
        ? `intervalbooks.tw${decodeURIComponent(url.pathname)}`
        : url.hostname === "line.me"
          ? "LINE @zta2483l"
          : part;
      return (
        <a
          key={i}
          href={href}
          {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
          className="break-all font-medium underline underline-offset-2"
        >
          {label}
        </a>
      );
    }
    if (part.includes("@") && !part.startsWith("http")) {
      return (
        <a
          key={i}
          href={`mailto:${part}`}
          className="break-all font-medium underline underline-offset-2"
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

function sessionId(): string {
  const KEY = "ib-chat-sid";
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(
      /[^A-Za-z0-9_-]/g,
      "",
    );
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return `t${Date.now()}`;
  }
}

export default function ChatPanel({
  open,
  onClose,
  lang,
  bottomOffset,
}: {
  open: boolean;
  onClose: () => void;
  lang: ChatLang;
  bottomOffset: number;
}) {
  const c = COPY[lang] ?? COPY.zh;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sidRef = useRef<string>("");

  useEffect(() => {
    sidRef.current = sessionId();
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, loading, open]);

  // 手機上開著時鎖住背景捲動
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 639px)");
    if (!mq.matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function send(text: string) {
    const q = text.trim().slice(0, MAX_INPUT_CHARS);
    if (!q || loading) return;
    const next: Msg[] = [...msgs, { role: "user", text: q }];
    setMsgs(next);
    setInput("");
    setLoading(true);
    try {
      const res = await askChatAssistant({
        data: { messages: next.slice(-12), sessionId: sidRef.current, lang },
      });
      setMsgs((m) => [...m, { role: "model", text: res.ok ? res.reply : res.message }]);
    } catch {
      setMsgs((m) => [...m, { role: "model", text: c.network }]);
    } finally {
      setLoading(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled])",
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={panelRef}
      id="ib-chat-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="ib-chat-title"
      hidden={!open}
      onKeyDown={onKeyDown}
      style={{ ["--chat-lift" as string]: `${bottomOffset}px` }}
      className="fixed inset-x-0 bottom-0 top-[6vh] z-50 flex flex-col overflow-hidden rounded-t-2xl border border-border bg-background text-foreground shadow-2xl sm:inset-x-auto sm:top-auto sm:right-6 sm:bottom-[calc(88px+var(--chat-lift)+env(safe-area-inset-bottom,0px))] sm:h-[min(600px,calc(100vh-140px))] sm:w-[380px] sm:rounded-2xl"
    >
      <div className="flex items-center gap-3 bg-primary px-4 py-3 text-primary-foreground">
        <div className="min-w-0 flex-1">
          <h2 id="ib-chat-title" className="truncate text-sm font-medium">
            {c.title}
          </h2>
          <p className="truncate text-[11px] opacity-75">{c.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={c.close}
          className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-contain bg-oat/60 px-4 py-4"
        aria-live="polite"
        aria-busy={loading}
      >
        <Bubble role="model">{c.greeting}</Bubble>
        {msgs.map((m, i) => (
          <Bubble key={i} role={m.role}>
            {m.role === "model" ? linkify(m.text) : m.text}
          </Bubble>
        ))}
        {loading && (
          <div className="mb-3 flex justify-start">
            <div
              className="flex items-center gap-1 rounded-2xl bg-background px-4 py-3 shadow-sm"
              role="status"
            >
              <span className="sr-only">{c.typing}</span>
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  aria-hidden
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
                  style={{ animationDelay: `${d * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}
        {msgs.length === 0 && !loading && (
          <div className="mt-2 flex flex-wrap gap-2">
            {c.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-center gap-2 border-t border-border bg-background px-3 py-3"
      >
        <label htmlFor="ib-chat-input" className="sr-only">
          {c.placeholder}
        </label>
        <input
          id="ib-chat-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={c.placeholder}
          maxLength={MAX_INPUT_CHARS}
          autoComplete="off"
          enterKeyHint="send"
          className="min-w-0 flex-1 rounded-full border border-input bg-background px-4 py-2.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          aria-label={c.send}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Send className="h-4 w-4" aria-hidden />
        </button>
      </form>
      <p className="bg-background px-3 pb-2 text-center text-[11px] text-muted-foreground max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
        {c.human}{" "}
        <a
          href={LINE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-2"
        >
          {c.line}
        </a>
      </p>
    </div>
  );
}

function Bubble({ role, children }: { role: Msg["role"]; children: ReactNode }) {
  const mine = role === "user";
  return (
    <div className={`mb-3 flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          mine ? "bg-primary text-primary-foreground" : "bg-background text-foreground shadow-sm"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
