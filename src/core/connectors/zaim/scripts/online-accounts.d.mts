/**
 * `online-accounts.mjs` の型。
 *
 * 抽出関数はPlaywrightがブラウザへ文字列として渡すため実装は `.mjs` に置いているが、
 * DOMの当て方がこのコネクタでもっとも壊れやすい箇所なので、テストから呼べるようにしている。
 */

export interface ZaimRawOnlineAccountEntry {
  name: string;
  lastUpdatedAt: string;
}

/** ページ内で実行される。要素の配列を受け取り、口座名と最終更新の表示文字列を返す。 */
export declare function extractOnlineAccounts(elements: unknown[]): ZaimRawOnlineAccountEntry[];

export declare function extractOnlineAccountsByRow(
  rows: unknown[],
  selectors: { name: string },
): ZaimRawOnlineAccountEntry[];

export declare function resolveOnlineAccountsUrl(): string;

export declare function readOnlineAccounts(page: unknown): Promise<ZaimRawOnlineAccountEntry[]>;
