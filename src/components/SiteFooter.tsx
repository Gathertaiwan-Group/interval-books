import { Link } from "@tanstack/react-router";
import { Facebook, Instagram } from "lucide-react";
import { useT } from "@/i18n/LanguageContext";
import { useSiteContent } from "@/lib/site-content";

export function SiteFooter() {
  const t = useT();
  const { ui, site, contactEmail, siteUrl, phones, social } = useSiteContent();
  return (
    <footer className="mt-32 border-t border-border/60 bg-[oklch(0.96_0.014_82)]/60">
      <div className="container-editorial py-16 grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <h3 className="font-serif text-2xl">{t(ui.brand)}</h3>
          <p className="eyebrow mt-2 text-[0.6rem]">{t(ui.brandSub)}</p>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground max-w-sm">
            {t(site.shortDesc)}
          </p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow text-2xl mb-4">{t(ui.footer.visit)}</p>
          <p>{t(site.address)}</p>
          <p className="text-muted-foreground mt-1">{t(site.city)}</p>
          <p className="mt-3">{t(site.hours)}</p>
          <p className="text-muted-foreground">{t(ui.footer.everyday)}</p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow text-2xl mb-4">{t(ui.footer.contact)}</p>
          <a href={`mailto:${contactEmail}`} className="hover-underline break-all">
            {contactEmail}
          </a>
          <div className="mt-2 space-y-1">
            {phones.map((p) => (
              <a
                key={p.tel}
                href={`tel:${p.tel}`}
                className="block hover-underline text-muted-foreground"
              >
                {p.display}
              </a>
            ))}
          </div>
          <a
            href={siteUrl}
            target="_blank"
            rel="noreferrer"
            className="block mt-3 text-muted-foreground hover-underline"
          >
            {siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
          {/* 社群改成圖示。⚠️ 圖示沒有文字，所以 aria-label 是這些連結**唯一**的無障礙
              名稱——拿掉的話螢幕閱讀器只會唸出網址。title 是給滑鼠停留看的，兩個都要。
              LINE 沒有對應的 lucide 圖示，維持文字，這是刻意的不對稱。 */}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground">
            {social.instagram && (
              <a
                href={social.instagram}
                target="_blank"
                rel="noreferrer"
                aria-label="Instagram"
                title="Instagram"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 transition-colors hover:border-foreground hover:text-foreground"
              >
                <Instagram className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {social.facebook && (
              <a
                href={social.facebook}
                target="_blank"
                rel="noreferrer"
                aria-label="Facebook"
                title="Facebook"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 transition-colors hover:border-foreground hover:text-foreground"
              >
                <Facebook className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {social.line && (
              <a href={social.line} target="_blank" rel="noreferrer" className="hover-underline">
                LINE
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="container-editorial flex flex-col md:flex-row gap-3 md:items-center md:justify-between py-6 text-xs text-muted-foreground">
          <p>
            © {new Date().getFullYear()} {t(ui.footer.rights)}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link to="/account" className="hover-underline">
              {t(ui.footer.account)}
            </Link>
            <Link to="/curation" className="hover-underline">
              {t(ui.nav.curation)}
            </Link>
            <Link to="/partnership" className="hover-underline">
              {t(ui.nav.partnership)}
            </Link>
            <Link to="/privacy" className="hover-underline">
              {t(ui.nav.privacy)}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
