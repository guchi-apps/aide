/**
 * Zaimの「月」の扱い（aide#481）。
 *
 * **Zaimの月は暦月ではない。** 「月の開始日」設定（既定は1日。運用中の値は25日）に従い、
 * 開始日が25日なら `month=202609` は 2026-08-25〜2026-09-24 を指す。暦月で `YYYYMM` を
 * 作ると、毎月25日〜月末の明細はどちらの月にも入らない。
 *
 * 開始日はJSONから読めないため設定で持つ（`ZAIM_MONTH_START_DAY`。既定25）。
 * すべて純粋関数で、日付は `YYYY-MM-DD` の文字列として扱う。
 */

export const DEFAULT_ZAIM_MONTH_START_DAY = 25;

export function zaimMonthStartDay(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.ZAIM_MONTH_START_DAY);
  return Number.isInteger(value) && value >= 1 && value <= 28 ? value : DEFAULT_ZAIM_MONTH_START_DAY;
}

function shiftMonth(yyyymm: string, delta: number): string {
  const total = Number(yyyymm.slice(0, 4)) * 12 + (Number(yyyymm.slice(4, 6)) - 1) + delta;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
}

function toDate(yyyymm: string, day: number): string {
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-${String(day).padStart(2, "0")}`;
}

/** 日付（JST・`YYYY-MM-DD`）が属するZaimの月を `YYYYMM` で返す。 */
export function zaimMonthOfDate(date: string, startDay: number): string {
  const calendar = date.slice(0, 4) + date.slice(5, 7);
  return startDay > 1 && Number(date.slice(8, 10)) >= startDay ? shiftMonth(calendar, 1) : calendar;
}

/** Zaimの月が覆う日付の範囲（両端を含む）。 */
export function zaimMonthRange(zaimMonth: string, startDay: number): { from: string; to: string } {
  if (startDay <= 1) {
    return { from: toDate(zaimMonth, 1), to: lastDayOf(zaimMonth) };
  }
  return { from: toDate(shiftMonth(zaimMonth, -1), startDay), to: toDate(zaimMonth, startDay - 1) };
}

/**
 * 「今日を含むZaimの月」と、その前月を返す（古い順）。
 * 開始日が25日なら、9/24までは `202609`・`202608`、9/25からは `202610`・`202609`。
 */
export function zaimMonthsToRead(today: string, startDay: number): string[] {
  const current = zaimMonthOfDate(today, startDay);
  return [shiftMonth(current, -1), current];
}

/**
 * 読んだZaimの月から、**全日を読めた暦月**（`YYYYMM`）を返す。
 *
 * asset-managerは `months` を暦月として読み、範囲内で見つからなければ「なし」、範囲外なら
 * 「対象外」と判定する。読めていない日を含む暦月を返すと、実際にはある明細を「なし」と
 * 誤判定するため、覆えた暦月だけを返す。今日より後の日は明細がまだ無いため、
 * 読んだ範囲の末尾が今日以降なら、その月の残りの日は覆えたものとみなす。
 */
export function coveredCalendarMonths(
  zaimMonths: readonly string[],
  today: string,
  startDay: number,
): string[] {
  if (zaimMonths.length === 0) return [];
  const ranges = zaimMonths.map((m) => zaimMonthRange(m, startDay));
  const from = ranges.map((r) => r.from).sort()[0] as string;
  const to = ranges.map((r) => r.to).sort().reverse()[0] as string;

  const covered: string[] = [];
  const lastMonth = to.slice(0, 4) + to.slice(5, 7);
  for (let month = from.slice(0, 4) + from.slice(5, 7); month <= lastMonth; month = shiftMonth(month, 1)) {
    if (toDate(month, 1) >= from && (lastDayOf(month) <= to || to >= today)) covered.push(month);
  }
  return covered;
}

/** 暦月の末日（`YYYY-MM-DD`）。 */
function lastDayOf(month: string): string {
  const next = shiftMonth(month, 1);
  return new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(4, 6)) - 1, 0)).toISOString().slice(0, 10);
}
