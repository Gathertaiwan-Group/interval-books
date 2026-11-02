/**
 * 休止符記號（2026-11 改版）。INTERVAL 取自樂譜上的「休止符」，這個記號是全休止符：
 * 一條五線譜線，底下掛一塊實心短方塊。純裝飾，螢幕閱讀器略過（aria-hidden）。
 * 顏色跟著 currentColor。
 */
export function RestMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 16"
      width="48"
      height="16"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <line x1="0" y1="3.5" x2="48" y2="3.5" stroke="currentColor" strokeWidth="1" />
      <rect x="16" y="4" width="16" height="6" fill="currentColor" />
    </svg>
  );
}
