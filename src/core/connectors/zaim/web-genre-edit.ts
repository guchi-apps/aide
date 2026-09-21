import {
  isZaimAutoReloginFailed,
  isZaimReceiptFormFailure,
  isZaimReceiptSubmitted,
  isZaimSessionExpired,
  zaimSessionExpiredMessage,
} from "./errors.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import { MAX_AMOUNT, MAX_REQUEST_ID_LENGTH, isValidDate, normalizeId, normalizeText } from "./write.ts";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "./web-screen-lock.ts";
import {
  abandonWebGenreEdit,
  beginWebGenreEdit,
  completeWebGenreEdit,
} from "./web-genre-edit-idempotency.ts";

/**
 * 既存明細（自動連携明細を含む）のカテゴリ・内訳だけをWeb版の編集画面から変更する（#273）。
 *
 * ## なぜ要るのか
 *
 * asset-manager の「内訳の提案」（asset-manager#420）が、AIDEが巡回したZaim Web版の一覧
 * （`money-list.ts`・#244）から自動連携明細（カード・スマートレシート等）の内訳を提案するように
 * なった。しかし提案をZaimへ書き戻す口が無かった。
 *
 * - 公式API（`write.ts`）は自動連携明細を編集できない（Zaim APIの仕様。`write.ts` 冒頭）
 * - `write.ts`（新規登録）・`web-payment.ts`（Web版での新規登録）はどちらも**新規作成だけ**で、
 *   既存明細を編集する口を持たない
 *
 * そこでWeb版の編集モーダル（一覧の鉛筆アイコンから開く。`/money/<moneyId>/edit` を直接開いても編集UIは出ない。#409）をPlaywrightで操作し、**カテゴリ・内訳だけ**を
 * 選び直す。金額・日付・口座・品目・お店・集計対象外はこの経路では変えない。
 *
 * ## 新規登録（`web-payment.ts`）との違い
 *
 * | | 新規登録（`web-payment.ts`） | 既存明細の変更（ここ） |
 * |---|---|---|
 * | 開く画面 | `/money/new` | 一覧（`/money?month=YYYYMM`）の編集モーダル |
 * | 触る項目 | 全項目を埋める | **カテゴリ・内訳だけ** |
 * | 返せるID | `null`（画面にIDが出ない） | **呼び出し元が渡した `moneyId` をそのまま返せる** |
 * | 取り違えの検知 | 無い（新規なので取り違えようがない） | **開いた明細の日付・金額が本文と一致しなければ、何も触らず止める** |
 * | 結果不明の再送 | **止める**（`conflict`。同じ内容の再送は二重登録になりうる） | **止めない**（べき等かつ取り違えを検知できるため。`web-genre-edit-idempotency.ts` 冒頭のコメント参照） |
 *
 * 同時実行のロック（`web-screen-lock.ts`）はログイン状態（storage state）を共有する
 * `web-payment.ts` と同じものを使う。片方が画面を開いている間はもう片方も待たせずに断る。
 */

/** 1回の実行の上限。`web-payment.ts` の `WEB_PAYMENT_TIMEOUT_MS` と同じ考え方。 */
export const WEB_GENRE_EDIT_TIMEOUT_MS = 180_000;

const WEB_GENRE_EDIT_SCRIPT = zaimScriptPath("edit-genre.mjs");

export interface ZaimWebGenreEditInput {
  /** 呼び出し元がレコードごとに一意に決める冪等キー（例: `asset-manager:genre-suggestion:1234`）。 */
  requestId: string;
  /** 変更対象の明細のZaimレコードID（一覧の `id`・行の `data-url`（`/money/<moneyId>/edit`）に載る値）。 */
  moneyId: number;
  /** `YYYY-MM-DD`。開いた明細と一致しなければ取り違えとみなして止める。 */
  date: string;
  /** 開いた明細と一致しなければ取り違えとみなして止める。 */
  amount: number;
  /** カテゴリ名（Zaimのカテゴリ設定にある表記そのまま）。 */
  categoryName: string;
  /** ジャンル名（内訳。Zaimのカテゴリ設定にある表記そのまま）。 */
  genreName: string;
  /** 立てると**「更新する」だけ押さない**。画面の当て方を確かめるためのモード。 */
  dryRun?: boolean | undefined;
}

export type CreateWebGenreEditOutcome =
  | { ok: true; moneyId: number; duplicated: boolean }
  | {
      ok: false;
      /**
       * - `invalid` … 入力が不正。直して送り直せばよい
       * - `conflict` … 現状のこの実装では返さない（`web-genre-edit-idempotency.ts` 冒頭の
       *   コメント参照）。`statusFor()` を新規登録と共用するために型としてだけ残している
       * - `rejected` … 送信の前に止まった（取り違えの検知も含む）。**Zaimには何も変更されていない**
       * - `failed` … 送信後に確認できない・打ち切り。変更されたかは不明
       */
      kind: "invalid" | "conflict" | "rejected" | "failed";
      reason: string;
    };

/** 既存明細を編集画面から変更する経路が共通で受け取る、対象の明細を指す4項目。 */
export interface ZaimWebEditTarget {
  requestId: string;
  moneyId: number;
  date: string;
  amount: number;
}

/**
 * 対象の明細を指す `requestId`・`moneyId`・`date`・`amount` を検査する。
 *
 * カテゴリの変更（ここ）とメモの変更（`web-memo-edit.ts`・#354）で共用する。**経路によって
 * 受け付ける値の範囲を変えない**ためで、`write.ts` の `normalizeId` / `isValidDate` を再利用する
 * （`web-payment.ts` と同じ方針）。
 */
export function normalizeWebEditTarget(
  body: Record<string, unknown>,
): { target: ZaimWebEditTarget } | { error: string } {
  const requestId = typeof body["requestId"] === "string" ? body["requestId"].trim() : "";
  if (!requestId) return { error: "requestId が必要です（呼び出し元のレコードごとに一意な文字列）" };
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { error: `requestId が長すぎます（${MAX_REQUEST_ID_LENGTH}文字まで）` };
  }
  // 制御文字はログにも記録にも入るため落とす。
  if (/[\u0000-\u001f\u007f]/.test(requestId)) return { error: "requestId に制御文字は使えません" };

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

  return { target: { requestId, moneyId: moneyId.value!, amount, date } };
}

/**
 * 受け取ったJSONを検査して入力へ変換する。
 *
 * `write.ts` の `normalizeText` を再利用する。対象の明細を指す項目は `normalizeWebEditTarget()`。
 */
export function normalizeWebGenreEditInput(
  raw: unknown,
): { input: ZaimWebGenreEditInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSONオブジェクトを送ってください" };
  }
  const body = raw as Record<string, unknown>;

  const target = normalizeWebEditTarget(body);
  if ("error" in target) return { error: target.error };

  const required: Array<[string, string]> = [
    ["categoryName", "categoryName（カテゴリ名）"],
    ["genreName", "genreName（ジャンル名）"],
  ];
  const texts: Record<string, string> = {};
  for (const [key, label] of required) {
    const normalized = normalizeText(body[key], label);
    if ("error" in normalized) return { error: normalized.error };
    if (normalized.value === undefined) return { error: `${label} が必要です` };
    texts[key] = normalized.value;
  }

  return {
    input: {
      ...target.target,
      categoryName: texts["categoryName"]!,
      genreName: texts["genreName"]!,
      ...(body["dryRun"] === true ? { dryRun: true } : {}),
    },
  };
}

export interface ZaimWebGenreEditScriptResult {
  submitted: boolean;
  url: string;
  resultUrl?: string;
  filled: {
    genre: string;
    amount: number | null;
    date: string;
  };
}

/**
 * 失敗を「Zaimに変更されていないと言い切れるか」で分ける。`web-payment.ts` の
 * `classifyWebFailure()` と同じ考え方（マーカーも共通、`errors.ts` を参照）。
 *
 * **開いた明細の日付・金額が一致しない（取り違え）も、送信前に止まる失敗の1つ**として
 * `ZAIM_RECEIPT_FORM` に含める。カテゴリを選ぶ前に検知するため、この場合もZaimには
 * 何も変更されていない。
 */
export function classifyWebGenreEditFailure(
  message: string,
): { kind: "rejected" | "failed"; reason: string } {
  if (isZaimReceiptSubmitted(message)) {
    return {
      kind: "failed",
      reason:
        "Zaimへ保存しましたが、変更できたかを確認できませんでした。" +
        "Zaimの画面で内容を確認してください。",
    };
  }
  if (isZaimReceiptFormFailure(message)) {
    const detail = message.split("ZAIM_RECEIPT_FORM:")[1]?.split("\n")[0] ?? message;
    return { kind: "rejected", reason: `Zaimの編集画面と噛み合いませんでした: ${detail}` };
  }
  return {
    kind: "failed",
    reason: `Zaimの編集画面を操作できませんでした: ${message.split("\n")[0]}`,
  };
}

/**
 * Web版の編集画面から既存明細のカテゴリ・内訳を1件変更する。
 *
 * 画面を触る前に記録を置き、変更できたら確定させる（`web-genre-edit-idempotency.ts`）。
 * 同じ `requestId` の再送は画面を開かず `duplicated: true` と、記録した `moneyId` を返す。
 *
 * **一時的な失敗をやり直さない**（`retryTransient: false`）。やり直すと同じ明細へ
 * 二重に変更が送られうるため。セッション失効時の自動再ログインは従来どおり通る。
 *
 * **ヘッドレスChromiumを起動するため数十秒かかる。** 呼び出し元は同期リクエストで待つことに
 * なるので、タイムアウトを長めに取ること。
 */
export async function createZaimWebGenreEdit(
  input: ZaimWebGenreEditInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebGenreEditOutcome> {
  // 新規登録（`web-payment.ts`）と同じロックを取り合う。ログイン状態のファイルは1つで、
  // 2つのChromiumが同時に開くと更新が競合するため（#215）。
  if (!acquireZaimWebScreenLock()) {
    return {
      ok: false,
      kind: "rejected",
      reason:
        "別のZaim Web版の操作を処理中です。Zaimには何も変更されていません。" +
        "1件ずつ順に送り直してください。",
    };
  }
  try {
    return await runZaimWebGenreEdit(input, deps);
  } finally {
    releaseZaimWebScreenLock();
  }
}

async function runZaimWebGenreEdit(
  input: ZaimWebGenreEditInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebGenreEditOutcome> {
  // dryRun は変更しない。記録も残さない（残すと本番の変更が「変更済み」で弾かれる）。
  // 確定済み（done）以外は常に new が返る——結果不明の再送も、この経路はべき等かつ
  // 取り違えを検知できるため塞がない（`web-genre-edit-idempotency.ts` 冒頭のコメント参照）。
  if (input.dryRun !== true) {
    const begun = await beginWebGenreEdit(input.requestId, input.moneyId);
    if (begun.status === "done") {
      console.log(`[zaim] Web版で変更済み: requestId=${input.requestId} moneyId=${begun.moneyId}`);
      return { ok: true, moneyId: begun.moneyId, duplicated: true };
    }
  }

  let stdout: string;
  try {
    stdout = await runZaimScript(
      WEB_GENRE_EDIT_SCRIPT,
      {
        timeout: WEB_GENRE_EDIT_TIMEOUT_MS,
        retryTransient: false,
        // moneyId や金額を引数に置くと `ps` に出る。環境変数で渡す。
        env: { ZAIM_WEB_GENRE_EDIT_INPUT: JSON.stringify(input) },
      },
      deps,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      if (input.dryRun !== true) await abandonWebGenreEdit(input.requestId);
      return {
        ok: false,
        kind: "rejected",
        reason: zaimSessionExpiredMessage(isZaimAutoReloginFailed(message)),
      };
    }
    const failure = classifyWebGenreEditFailure(message);
    if (failure.kind === "rejected" && input.dryRun !== true) await abandonWebGenreEdit(input.requestId);
    console.warn(`[zaim] Web版での変更に失敗: requestId=${input.requestId} ${failure.reason}`);
    return { ok: false, ...failure };
  }

  let result: ZaimWebGenreEditScriptResult;
  try {
    result = JSON.parse(stdout) as ZaimWebGenreEditScriptResult;
  } catch {
    return { ok: false, kind: "failed", reason: "Zaim編集スクリプトの応答を読めませんでした" };
  }

  if (input.dryRun === true) {
    return { ok: true, moneyId: input.moneyId, duplicated: false };
  }
  if (result.submitted !== true) {
    return { ok: false, kind: "failed", reason: "Zaim編集スクリプトが保存を行いませんでした" };
  }

  await completeWebGenreEdit(input.requestId, input.moneyId);
  console.log(`[zaim] Web版で変更: requestId=${input.requestId} moneyId=${input.moneyId}`);
  return { ok: true, moneyId: input.moneyId, duplicated: false };
}
