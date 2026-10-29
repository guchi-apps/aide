/**
 * Zaimへ送る入力の共通の検査（Web版の入力画面・編集画面・内訳の再取得が使う）。
 *
 * もとは公式APIでの登録（`write.ts`）にあったもの。公式APIの終了（aide#714）で `write.ts` を
 * 撤去したため、Web経路が使う検査だけをここへ移した。**受け付ける値の範囲は経路で変えない**。
 */

/** 文字列項目の上限。Zaimは100文字を超えると受け付けない。 */
export const MAX_TEXT_LENGTH = 100;

/** 冪等キーの上限。呼び出し元のレコードを指す文字列なので、これで十分足りる。 */
export const MAX_REQUEST_ID_LENGTH = 200;

/** 金額の上限。桁を1つ間違えた登録を機械的に止めるための歯止め。 */
export const MAX_AMOUNT = 100_000_000;

/** 文字列項目を整える。空文字は「指定なし」として落とす。 */
export function normalizeText(value: unknown, label: string): { value?: string } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: `${label} は文字列で指定してください` };
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { error: `${label} が長すぎます（${MAX_TEXT_LENGTH}文字まで）` };
  }
  return { value: trimmed };
}

/** IDの項目を整える。`required` なら未指定を誤りとして扱う。 */
export function normalizeId(value: unknown, label: string, required: boolean): { value?: number } | { error: string } {
  if (value === undefined || value === null) {
    return required ? { error: `${label} が必要です` } : {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { error: `${label} は正の整数で指定してください` };
  }
  return { value };
}

/**
 * 日付を検査する。
 *
 * 形だけでなく実在する日かまで見る。`2026-02-31` を素通しするとZaim側で丸められ、
 * 呼び出し元のレコードと違う日付で登録される。
 */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
