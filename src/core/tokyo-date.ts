/**
 * 日本時間での `YYYY-MM-DD`。
 *
 * **VPSのタイムゾーンはUTC。** `new Date().toISOString().slice(0, 10)` だと、日本時間の
 * 00:00〜09:00 は前日の日付になる。`Intl` は標準で使えるので、これだけのために日付ライブラリを足さない。
 */
export function tokyoDate(now: Date): string {
  // en-CA は YYYY-MM-DD 形式。
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
}
