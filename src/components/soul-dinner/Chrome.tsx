import { Link } from "@tanstack/react-router";
import { BRAND, BUTTON_CLAY, EVENT_PATH, TAGLINE } from "@/components/soul-dinner/data";

/**
 * 頁首（黏在頂端）。稿上還有一顆「登入」，那是給「映後小客廳」留言用的；站上這幾頁
 * 不做留言區（業主決定），所以拿掉。
 */
export function SoulHeader({ bookingClosed }: { bookingClosed: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-3">
        <Link to={EVENT_PATH} className="font-serif text-base tracking-widest text-primary">
          小時光<span className="text-clay">｜</span>靈魂飯桌
        </Link>
        <nav className="flex items-center gap-2 text-sm">
          {bookingClosed ? (
            <span className="text-xs text-muted-foreground">活動已結束</span>
          ) : (
            <Link
              to={EVENT_PATH}
              hash="reserve"
              className={`${BUTTON_CLAY} h-8 rounded-md px-3 text-xs`}
            >
              預約一張飯票
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SoulFooter() {
  return (
    <footer className="mt-24 border-t border-border/60 py-10 text-center text-xs leading-6 text-muted-foreground">
      <p className="font-serif tracking-widest text-primary">{BRAND}</p>
      <p>{TAGLINE}</p>
      <p className="mt-2">所有日期皆為暫訂，地點確認後另行通知。</p>
    </footer>
  );
}

/** 章節：小標、標題、內容。稿上每一段都是這個形狀。 */
export function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-5xl scroll-mt-20 px-5 pt-20 sm:pt-28">
      <p className="text-xs tracking-[0.35em] text-clay">{eyebrow}</p>
      <h2 className="mt-3 text-2xl leading-snug text-primary sm:text-3xl">{title}</h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}
