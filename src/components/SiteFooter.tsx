import { Link } from "@tanstack/react-router";
import { Clock, Facebook, Instagram, Mail, Map as MapIcon, MapPin, Phone } from "lucide-react";
import { useLang } from "@/i18n/LanguageContext";
import { useSiteContent } from "@/lib/site-content";
import { DAILY, dailyHours } from "@/lib/daily-hours";

// 44px 圓形 icon 按鈕（點擊區 ≥44px）。
const ICON_BTN =
  "inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/70 transition-colors hover:border-foreground hover:text-foreground";

// footer 專用的小字串（三語），不進 CMS。「每日」與抽屜共用，在 lib/daily-hours.ts。
const CALL = { zh: "致電", en: "Call", ja: "電話" };

export function SiteFooter() {
  const { t, lang } = useLang();
  const { ui, site, contactEmail, phones, social, map } = useSiteContent();
  // 只放市話：label "Tel" 那支；找不到就退回第一支。手機號碼不在 footer 顯示（業主 2026-11-10）。
  const landline = phones.find((p) => p.label === "Tel") ?? phones[0];
  return (
    <footer className="mt-24 md:mt-32 border-t border-border/60 bg-[oklch(0.96_0.014_82)]/60">
      {/* 2026-11-10 業主要求「更簡潔、重複資訊移除、能變 icon 就變 icon」：
          - 拿掉大字店名（頁首已有）與「來訪」「聯繫」小標、「每日開放」、intervalbooks.tw 文字連結
          - 地址＋時間各一行加 icon；聯繫改成一排 44px 圓形 icon 按鈕
          - 只放市話（phones 的第一支，label "Tel"）；手機不在 footer 顯示 */}
      <div className="container-editorial py-12 md:py-16 grid gap-8 md:grid-cols-2 md:gap-16">
        <p className="text-[0.8rem] leading-[1.9] text-muted-foreground max-w-sm">
          {t(ui.footer.aboutBlurb ?? site.shortDesc)}
        </p>

        <div className="text-sm leading-relaxed space-y-3">
          <a
            href={map.link}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-2.5 hover-underline"
          >
            <MapPin className="mt-[0.2em] h-4 w-4 shrink-0 text-clay" aria-hidden="true" />
            <span>
              {lang === "en"
                ? `${site.address.en}, ${site.city.en}`
                : `${t(site.city)} ${t(site.address)}`}
            </span>
          </a>
          <p className="flex items-start gap-2.5">
            <Clock className="mt-[0.2em] h-4 w-4 shrink-0 text-clay" aria-hidden="true" />
            <span>{dailyHours(t(site.hours), t(DAILY))}</span>
          </p>

          <div className="pt-3 flex flex-wrap items-center gap-2 text-muted-foreground">
            <a
              href={`mailto:${contactEmail}`}
              aria-label={`Email ${contactEmail}`}
              title={`Email ${contactEmail}`}
              className={ICON_BTN}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
            </a>
            {landline && (
              <a
                href={`tel:${landline.tel}`}
                aria-label={`${t(CALL)} ${landline.display}`}
                title={`${t(CALL)} ${landline.display}`}
                className={ICON_BTN}
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {/* 社群圖示沒有文字，aria-label 是這些連結**唯一**的無障礙名稱；title 給滑鼠停留看。 */}
            {social.instagram && (
              <a
                href={social.instagram}
                target="_blank"
                rel="noreferrer"
                aria-label="Instagram"
                title="Instagram"
                className={ICON_BTN}
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
                className={ICON_BTN}
              >
                <Facebook className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {/* LINE 沒有對應的 lucide 圖示，圓鈕裡維持文字。 */}
            {social.line && (
              <a
                href={social.line}
                target="_blank"
                rel="noreferrer"
                title="LINE"
                className={`${ICON_BTN} text-[0.6rem] font-medium tracking-wide`}
              >
                LINE
              </a>
            )}
            <a
              href={map.link}
              target="_blank"
              rel="noreferrer"
              aria-label={t(ui.buttons.navigate)}
              title={t(ui.buttons.navigate)}
              className={ICON_BTN}
            >
              <MapIcon className="h-4 w-4" aria-hidden="true" />
            </a>
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
