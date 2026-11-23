/** `points.mjs` の型。抽出関数はブラウザへ文字列として渡すため実装は `.mjs` にある。 */

export interface ZaimRawPointEntry {
  name: string;
  /** `.point-currency` を除いた表示。`12,345 pt` や、残高が無いときの `-`。 */
  amount: string;
  id: string;
}

export declare const POINT_ROW_SELECTOR: string;

export declare function extractPointRows(elements: unknown[]): ZaimRawPointEntry[];

export declare function readPoints(page: unknown): Promise<ZaimRawPointEntry[]>;

export interface ZaimRawExpirationEntry {
  /** `2027-01-31` の表示のまま。 */
  date: string;
  /** `1,729 pt` の表示のまま。 */
  amount: string;
}

export declare const EXPIRATION_ROW_SELECTOR: string;

export declare function extractExpirationRows(rows: unknown[]): ZaimRawExpirationEntry[];

export declare function readExpirations(page: unknown): Promise<ZaimRawExpirationEntry[]>;
