/**
 * 包場活動的報名區（src/lib/private-booking.ts）：左邊照列場次時間（每一場標「包場」，
 * 不印票價與名額），右邊只有「本場為包場活動，不開放對外報名。」。
 *
 * 🔴 這裡沒有 SessionPicker／PlanPicker／QuantityStepper，也沒有任何 /checkout 連結——
 *    包場不收報名。結帳那一層另外會擋（sellableEventStatus → ticketSellable）。
 *
 * 場次的形狀轉換放在這裡、不放在路由：活動頁的自檢守「路由不自己 map 場次、不碰名額欄位」。
 */
import { useT } from "@/i18n/LanguageContext";
import { SessionList } from "@/components/shop/SessionPicker";
import { PRIVATE_BOOKING_COPY, type PrivateSessionTime } from "@/lib/private-booking";
import type { ShopSession } from "@/lib/shop";

/** 包場的場次（只有時間與地點）→ SessionList 吃的形狀。名額填 0：包場不賣位子，也不會被印出來。 */
function toShopSession(s: PrivateSessionTime): ShopSession {
  return {
    id: s.id,
    productId: "",
    title: s.title,
    location: s.location,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    capacity: 0,
    seatsTaken: 0,
    sortOrder: 0,
    plans: [],
  };
}

export function PrivateBookingPanel({
  sessions,
  ended,
  now,
  heading,
}: {
  sessions: PrivateSessionTime[];
  /** 活動已結束：每一場改標「已結束」。 */
  ended: boolean;
  now: number;
  heading: string;
}) {
  const t = useT();
  return (
    <>
      <SessionList
        sessions={sessions.map(toShopSession)}
        showSeatsRemaining={false}
        basePrice={null}
        ended={ended}
        privateBooking
        now={now}
      />
      <div data-private-booking="true">
        <p className="eyebrow text-2xl">{heading}</p>
        <p className="mt-6 text-sm leading-relaxed text-foreground/80">
          {t(PRIVATE_BOOKING_COPY.notice)}
        </p>
      </div>
    </>
  );
}
