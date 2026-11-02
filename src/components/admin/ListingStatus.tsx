/**
 * 活動與策旅的「單一上架狀態」三個小元件（0052，見 src/lib/listing-status.ts）：
 *   ListingStatusBadge   列表的狀態欄：草稿／上架／下架，上架中旁邊小字報名狀況
 *   ListingFilterTabs    列表上方的篩選：全部／草稿／上架／下架（附各自筆數）
 *   ListingStatusSelect  編輯頁唯一的狀態選擇器
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BOOKING_PHASE_LABEL,
  LISTING_FILTER_LABEL,
  LISTING_FILTERS,
  LISTING_STATUS_HINT,
  LISTING_STATUS_LABEL,
  LISTING_STATUSES,
  type BookingPhase,
  type ListingFilter,
  type ListingStatus,
} from "@/lib/listing-status";

const BADGE_VARIANT: Record<ListingStatus, "default" | "secondary" | "outline"> = {
  live: "default",
  draft: "secondary",
  archived: "outline",
};

export function ListingStatusBadge({
  status,
  phase,
}: {
  status: ListingStatus;
  /** 只有上架中才顯示（草稿／下架時客人看不到，報名狀況沒有意義）。 */
  phase?: BookingPhase | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Badge variant={BADGE_VARIANT[status]} data-testid="listing-status">
        {LISTING_STATUS_LABEL[status]}
      </Badge>
      {status === "live" && phase ? (
        <span className="text-xs text-muted-foreground" data-testid="booking-phase">
          {BOOKING_PHASE_LABEL[phase]}
        </span>
      ) : null}
    </span>
  );
}

export function ListingFilterTabs({
  value,
  counts,
  onChange,
}: {
  value: ListingFilter;
  counts: Record<ListingFilter, number>;
  onChange: (next: ListingFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="依上架狀態篩選">
      {LISTING_FILTERS.map((f) => (
        <Button
          key={f}
          type="button"
          size="sm"
          variant={value === f ? "default" : "outline"}
          aria-pressed={value === f}
          onClick={() => onChange(f)}
        >
          {LISTING_FILTER_LABEL[f]}
          <span className="ml-1 text-xs opacity-70">{counts[f]}</span>
        </Button>
      ))}
    </div>
  );
}

export function countByStatus(rows: ReadonlyArray<{ status: ListingStatus }>) {
  const counts: Record<ListingFilter, number> = {
    all: rows.length,
    draft: 0,
    live: 0,
    archived: 0,
  };
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

export function ListingStatusSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: ListingStatus;
  onChange: (next: ListingStatus) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={(v) => onChange(v as ListingStatus)} disabled={disabled}>
        <SelectTrigger id={id} className="w-48" data-testid="listing-status-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LISTING_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {LISTING_STATUS_LABEL[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{LISTING_STATUS_HINT[value]}</p>
    </div>
  );
}
