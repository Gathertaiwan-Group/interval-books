/**
 * 門市排班規劃（/admin/staff-schedule 的資料來源）
 *
 * 這一頁只讀、不進資料庫：班表要改，就改這個檔，頁面（src/routes/admin/_shell.staff-schedule.tsx）
 * 只負責畫出來。每人每週時數是從 WEEK 算出來的（staffWeeklyHours），不是另外手填，
 * 所以改了班表，時數表會自己跟著對。
 *
 * ⚠️ 不要在這裡放真實個資（電話、身分證、住址）。要填真名只改 STAFF 的 name。
 *
 * 這支檔案不 import 任何東西：scripts/staff-schedule-selftest.mjs 直接用 Node 原生型別剝離
 * import 它，驗的是同一份資料。
 */

export type StaffCode = "A" | "B" | "C" | "D";

export interface StaffMember {
  code: StaffCode;
  /** 顯示用名字。目前先用代號，之後換成真名即可。 */
  name: string;
}

export const STAFF: readonly StaffMember[] = [
  { code: "A", name: "A" },
  { code: "B", name: "B" },
  { code: "C", name: "C" },
  { code: "D", name: "D" },
];

export const HEADLINE =
  "每天早班＋晚班兩班，週末加一個加強班、平日加一個整理班，四位兼職夥伴輪流。";

export const PLACEHOLDER_NOTE = "A、B、C、D 為代號，實際姓名請於資料檔替換。";

export const STAFFING_FACTS: readonly { label: string; value: string }[] = [
  { label: "營業時間", value: "每天 11:00–19:00" },
  { label: "需要有人在店", value: "每天 10:30–19:30（含開店準備與收尾）" },
  { label: "可用人力", value: "四位兼職，每人每週約 20 小時，共約 80 小時" },
  {
    label: "顧店所需",
    value: "早晚兩班一週 63 小時，多出約 17 小時用於週末加強與平日整理",
  },
];

export type ShiftKey = "early" | "late" | "weekend" | "tidy";

export interface ShiftDef {
  key: ShiftKey;
  label: string;
  time: string;
  /** 計薪工時（已扣休息）。 */
  hours: number;
  duty: string;
}

export const SHIFTS: readonly ShiftDef[] = [
  {
    key: "early",
    label: "早班",
    time: "10:30–15:30（14:30 起休息 30 分）",
    hours: 4.5,
    duty: "開店、顧店",
  },
  {
    key: "late",
    label: "晚班",
    time: "14:30–19:30（15:00 起休息 30 分）",
    hours: 4.5,
    duty: "顧店、結帳、關店",
  },
  {
    key: "weekend",
    label: "週末加強班",
    time: "週六、日 12:30–16:30",
    hours: 4,
    duty: "人潮高峰多一人",
  },
  {
    key: "tidy",
    label: "整理班",
    time: "平日一天 4 小時",
    hours: 4,
    duty: "進貨上架、整理刊物、盤點、活動準備",
  },
];

export const SHIFT_NOTE =
  "早晚班重疊 1 小時，讓兩人輪流休息（勞基法：連續工作 4 小時須休息 30 分）。";

export interface DayPlan {
  /** 一、二、…、日 */
  day: string;
  weekend: boolean;
  early: StaffCode;
  late: StaffCode;
  /** 加強班（週末）或整理班（平日），沒有就省略。 */
  extra?: { shift: "weekend" | "tidy"; staff: StaffCode };
}

export const WEEK: readonly DayPlan[] = [
  { day: "一", weekend: false, early: "A", late: "B" },
  { day: "二", weekend: false, early: "C", late: "D" },
  { day: "三", weekend: false, early: "B", late: "A", extra: { shift: "tidy", staff: "C" } },
  { day: "四", weekend: false, early: "D", late: "C" },
  { day: "五", weekend: false, early: "A", late: "B", extra: { shift: "tidy", staff: "D" } },
  { day: "六", weekend: true, early: "C", late: "D", extra: { shift: "weekend", staff: "D" } },
  { day: "日", weekend: true, early: "B", late: "A", extra: { shift: "weekend", staff: "C" } },
];

export const HOURS_NOTE =
  "A、B 可支援講座／活動晚場湊滿 20 小時，或每月與 C、D 對調一次讓時數平均。";

export const LEGAL_REMINDERS: readonly string[] = [
  "每 7 天至少 1 天例假＋1 天休息日，不可連續上班超過 6 天（兼職同樣適用）。",
  "單日超過 8 小時屬加班，需另計加班費（上述每班皆在 5 小時內）。",
  "時薪 200 元，高於現行基本時薪。",
  "以打卡紀錄計薪，休息 30 分不計工時。",
];

export const PROCESS_STEPS: readonly string[] = [
  "每月 20 號前，交下個月可上班的時段。",
  "依範本排班，週末輪流，每月週末班數盡量平均。",
  "月底前公告下個月班表。",
  "要換班請自行找人，並經店長確認。",
];

export function shiftByKey(key: ShiftKey): ShiftDef {
  const found = SHIFTS.find((s) => s.key === key);
  if (!found) throw new Error(`unknown shift ${key}`);
  return found;
}

export interface StaffWeekSummary {
  code: StaffCode;
  name: string;
  hours: number;
  /** 例如「週六早班＋週日加強」 */
  weekendShifts: string;
}

/** 從 WEEK 算出每人每週時數與週末班別。 */
export function staffWeeklyHours(week: readonly DayPlan[] = WEEK): StaffWeekSummary[] {
  return STAFF.map((member) => {
    let hours = 0;
    const weekend: string[] = [];
    for (const d of week) {
      const slots: { key: ShiftKey; staff: StaffCode; short: string }[] = [
        { key: "early", staff: d.early, short: "早班" },
        { key: "late", staff: d.late, short: "晚班" },
      ];
      if (d.extra) {
        slots.push({
          key: d.extra.shift,
          staff: d.extra.staff,
          short: d.extra.shift === "weekend" ? "加強" : "整理",
        });
      }
      for (const slot of slots) {
        if (slot.staff !== member.code) continue;
        hours += shiftByKey(slot.key).hours;
        if (d.weekend) weekend.push(`週${d.day}${slot.short}`);
      }
    }
    return {
      code: member.code,
      name: member.name,
      hours,
      weekendShifts: weekend.join("＋") || "—",
    };
  });
}
