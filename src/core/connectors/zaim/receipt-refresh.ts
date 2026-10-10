import {
  isZaimAutoReloginFailed,
  isZaimSessionExpired,
  zaimSessionExpiredMessage,
} from "./errors.ts";
import { buildZaimMoneyList } from "./parse.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import type { ZaimMoneyEntry, ZaimRawMoneyEntry } from "./types.ts";
import { MAX_AMOUNT, isValidDate, normalizeId } from "./write.ts";
import { zaimMonthOfDate, zaimMonthStartDay } from "./zaim-month.ts";

/**
 * 対象の1取引だけ、商品内訳をZaimから最新取得する（#600）。
 *
 * 定期巡回（`money-list.ts`）は当月・前月の全取引ぶん編集画面を開くが、こちらは月の一覧JSONを
 * 1回読み、対象の取引の編集画面だけを開く。**読むだけで、Zaimの取引は登録・更新・削除しない。**
 *
 * Playwrightで数十秒かかるため、同期リクエストの中で呼ばない（呼び出しは `worker/receipt-refresh-jobs.ts`
 * のジョブ経由）。
 */

const RECEIPT_REFRESH_TIMEOUT_MS = 120_000;
const RECEIPT_REFRESH_SCRIPT = zaimScriptPath("receipt-refresh.mjs");

/** 手動再取得の結果を、定期巡回のキャッシュへ重ねて持つキャッシュキーの接頭辞。 */
export const ZAIM_RECEIPT_DETAIL_CACHE_PREFIX = "zaim-money-detail-";

export function zaimReceiptDetailCacheKey(moneyId: number): string {
  return `${ZAIM_RECEIPT_DETAIL_CACHE_PREFIX}${moneyId}`;
}

/** キャッシュキーが商品内訳の手動再取得結果のものか（受け口の許可判定に使う）。 */
export function isZaimReceiptDetailCacheKey(key: string): boolean {
  return /^zaim-money-detail-[1-9][0-9]{0,15}$/.test(key);
}

export interface ZaimReceiptRefreshInput {
  moneyId: number;
  /** 取り違えの検知に使う。取得した取引の日付・金額が一致しなければ失敗にする。 */
  date: string;
  amount: number;
}

/** 受け取ったJSONを検査して入力へ変換する。 */
export function normalizeReceiptRefreshInput(
  raw: unknown,
): { input: ZaimReceiptRefreshInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSONオブジェクトを送ってください" };
  }
  const body = raw as Record<string, unknown>;

  const moneyId = normalizeId(body["moneyId"], "moneyId", true);
  if ("error" in moneyId) return { error: moneyId.error };

  const amount = body["amount"];
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    return { error: "amount は1以上の整数で指定してください" };
  }
  if (amount > MAX_AMOUNT) return { error: `amount が大きすぎます（${MAX_AMOUNT}まで）` };

  const date = body["date"];
  if (typeof date !== "string" || !isValidDate(date)) {
    return { error: "date は YYYY-MM-DD 形式の実在する日付で指定してください" };
  }

  return { input: { moneyId: moneyId.value!, amount, date } };
}

/** 取得に成功した1取引の内訳。`items` は `complete`・`partial` のときだけ付く（既存の items 契約のまま）。 */
export type ZaimReceiptDetailEntry = Pick<
  ZaimMoneyEntry,
  "id" | "date" | "amount" | "items" | "itemsStatus" | "itemsNote"
>;

export type ZaimReceiptRefreshFailureKind =
  /** ログインセッションが失効している（自動再ログインも含めて直らなかった）。 */
  | "session_expired"
  /** 指定の取引がZaimに見つからない、または日付・金額が一致しない。 */
  | "not_found"
  /** 取引は見つかったが、商品内訳の読み取りに失敗した（`itemsStatus: failed`）。 */
  | "detail_failed"
  /** 画面の操作・通信に失敗した。 */
  | "fetch_failed";

export type FetchReceiptDetailOutcome =
  | { ok: true; entry: ZaimReceiptDetailEntry }
  | { ok: false; kind: ZaimReceiptRefreshFailureKind; reason: string };

/**
 * 1取引の商品内訳をZaimから取得する。
 *
 * - 成功は `complete`・`partial`・`none`（子明細を持たない通常明細）。**`failed` は成功にしない**
 *   （`detail_failed`）。古い値や代表商品へ合計を載せた行を、新規取得の成功として返さないため
 * - 一時的な失敗のやり直しはしない（呼び出し元が押し直せる。Zaimへの余計なアクセスを増やさない）。
 *   セッション失効時の自動再ログインは `runZaimScript` が行う
 */
export async function fetchZaimReceiptDetail(
  input: ZaimReceiptRefreshInput,
  deps?: ZaimScriptDeps,
): Promise<FetchReceiptDetailOutcome> {
  const month = zaimMonthOfDate(input.date, zaimMonthStartDay());

  let stdout: string;
  try {
    stdout = await runZaimScript(
      RECEIPT_REFRESH_SCRIPT,
      {
        timeout: RECEIPT_REFRESH_TIMEOUT_MS,
        retryTransient: false,
        env: { ZAIM_RECEIPT_REFRESH_INPUT: JSON.stringify({ month, moneyId: input.moneyId }) },
      },
      deps,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      return {
        ok: false,
        kind: "session_expired",
        reason: zaimSessionExpiredMessage(isZaimAutoReloginFailed(message)),
      };
    }
    return {
      ok: false,
      kind: "fetch_failed",
      reason: `Zaimからの取得に失敗しました: ${message.split("\n")[0] ?? message}`,
    };
  }

  let result: { month?: string; entry?: ZaimRawMoneyEntry | null };
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    return { ok: false, kind: "fetch_failed", reason: "Zaim取得スクリプトの応答を読めませんでした" };
  }
  if (!result.entry) {
    return {
      ok: false,
      kind: "not_found",
      reason: `Zaimの${month}月の明細に moneyId=${input.moneyId} が見つかりませんでした`,
    };
  }

  const [entry] = buildZaimMoneyList({ url: "", month, entries: [result.entry] }).entries;
  if (!entry || entry.id !== input.moneyId || entry.date !== input.date || entry.amount !== input.amount) {
    return {
      ok: false,
      kind: "not_found",
      reason: "Zaimの取引の日付・金額が依頼の内容と一致しませんでした（別の取引の可能性があります）",
    };
  }

  if (entry.itemsStatus === "failed") {
    return {
      ok: false,
      kind: "detail_failed",
      reason: entry.itemsNote ?? "商品内訳を取得できませんでした",
    };
  }

  return {
    ok: true,
    entry: {
      id: entry.id,
      date: entry.date,
      amount: entry.amount,
      // 内訳を持たない明細は `none`。定期巡回のキャッシュでは省略される値だが、再取得の結果としては
      // 「確かめたうえで内訳が無い」ことを呼び出し元へ伝えるため明示する。
      itemsStatus: entry.itemsStatus ?? "none",
      ...(entry.items ? { items: entry.items } : {}),
      ...(entry.itemsNote ? { itemsNote: entry.itemsNote } : {}),
    },
  };
}
