import { isZaimAutoReloginFailed, isZaimSessionExpired, zaimSessionExpiredMessage } from "./errors.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import { normalizeText } from "./write.ts";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "./web-screen-lock.ts";
import {
  abandonWebGenreEdit,
  beginWebGenreEdit,
  completeWebGenreEdit,
} from "./web-genre-edit-idempotency.ts";
import {
  type CreateWebGenreEditOutcome,
  WEB_GENRE_EDIT_TIMEOUT_MS,
  type ZaimWebEditTarget,
  classifyWebGenreEditFailure,
  normalizeWebEditTarget,
} from "./web-genre-edit.ts";

/**
 * 既存明細（自動連携明細を含む）の**メモだけ**をWeb版の編集画面から書き換える（#354）。
 *
 * ## なぜ要るのか
 *
 * Zaimの「置き換え」はカード・電子マネーの連携明細にしか効かず、銀行口座・デビットカードの
 * 連携明細は置き換えられない。asset-manager の家計簿連携（asset-manager#514）は、代わりに
 * **その連携明細のメモへ買った物を直接書き込む**。自動連携明細は公式APIから編集できず
 * （`write.ts` 冒頭）、既存の `web-genre-edit.ts`（#273）はカテゴリ・内訳しか触らないため、
 * 同じ編集モーダル（一覧の鉛筆アイコンから開く。#409）を操作してメモ（`input[name="comment"]`）だけを書き換える。
 *
 * ## カテゴリの変更（`web-genre-edit.ts`）との違い
 *
 * - **触るのはメモの入力欄だけ。** カテゴリ・金額・日付・口座・品目・お店・集計対象外は触らない
 * - **空文字の `comment` はメモを消す。** 省略・null は消し忘れではなく誤送信として弾く
 * - **`requestId` をメモ本文へ混ぜない。** 新規登録（`web-payment.mjs` の `composeComment`）は
 *   二重登録を探す手掛かりとして混ぜているが、ここでは利用者が読むメモが汚れるだけで、
 *   冪等は記録（`web-genre-edit-idempotency.ts`）で足りる
 *
 * 取り違えの検知（開いた明細の日付・金額が本文と違えば何も触らず止める）・冪等の記録・同時実行の
 * ロック・失敗の分類は `web-genre-edit.ts` と**同じものを使う**。冪等の記録も同じファイルへ書く
 * （`requestId` の接頭辞が違うので衝突しない）。
 */

/** 1回の実行の上限。画面を開いて保存するまでの流れはカテゴリの変更と同じ。 */
export const WEB_MEMO_EDIT_TIMEOUT_MS = WEB_GENRE_EDIT_TIMEOUT_MS;

const WEB_MEMO_EDIT_SCRIPT = zaimScriptPath("edit-memo.mjs");

export interface ZaimWebMemoEditInput extends ZaimWebEditTarget {
  /** 書き込むメモの本文。空文字ならメモを消す。 */
  comment: string;
  /** 立てると**「更新する」だけ押さない**。画面の当て方を確かめるためのモード。 */
  dryRun?: boolean | undefined;
}

/** 結果の形・`kind` の意味はカテゴリの変更と同じ（`web-genre-edit.ts` の `CreateWebGenreEditOutcome`）。 */
export type CreateWebMemoEditOutcome = CreateWebGenreEditOutcome;

/**
 * 受け取ったJSONを検査して入力へ変換する。
 *
 * `comment` は文字列で必須。**空文字は「メモを消す」として通す**が、省略・null・文字列以外は
 * 弾く（呼び出し側の項目名の取り違えで、メモが黙って消えるのを防ぐ）。上限を超えたら**切らずに**
 * 弾く。呼び出し側も同じ値で切っており、こちらで黙って切ると書いた内容と残る内容がずれる。
 */
export function normalizeWebMemoEditInput(
  raw: unknown,
): { input: ZaimWebMemoEditInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSONオブジェクトを送ってください" };
  }
  const body = raw as Record<string, unknown>;

  const target = normalizeWebEditTarget(body);
  if ("error" in target) return { error: target.error };

  const comment = body["comment"];
  if (typeof comment !== "string") {
    return { error: "comment は文字列で指定してください（メモを消すときは空文字）" };
  }
  // メモ欄は1行の入力。改行・タブは入らないので、黙って落とさず弾く。
  if (/[\u0000-\u001f\u007f]/.test(comment.trim())) {
    return { error: "comment に改行・制御文字は使えません" };
  }
  const normalized = normalizeText(comment, "comment（メモ）");
  if ("error" in normalized) return { error: normalized.error };

  return {
    input: {
      ...target.target,
      comment: normalized.value ?? "",
      ...(body["dryRun"] === true ? { dryRun: true } : {}),
    },
  };
}

export interface ZaimWebMemoEditScriptResult {
  submitted: boolean;
  url: string;
  resultUrl?: string;
  filled: {
    comment: string;
    amount: number | null;
    date: string;
  };
}

/**
 * Web版の編集画面から既存明細のメモを1件書き換える。
 *
 * 画面を触る前に記録を置き、変更できたら確定させる。同じ `requestId` の再送は画面を開かず
 * `duplicated: true` と、記録した `moneyId` を返す。
 *
 * **一時的な失敗をやり直さない**（`retryTransient: false`）。セッション失効時の自動再ログインは
 * 従来どおり通る。**ヘッドレスChromiumを起動するため数十秒かかる。**
 */
export async function createZaimWebMemoEdit(
  input: ZaimWebMemoEditInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebMemoEditOutcome> {
  // 新規登録・カテゴリの変更と同じロックを取り合う。ログイン状態のファイルは1つで、
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
    return await runZaimWebMemoEdit(input, deps);
  } finally {
    releaseZaimWebScreenLock();
  }
}

async function runZaimWebMemoEdit(
  input: ZaimWebMemoEditInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebMemoEditOutcome> {
  // dryRun は変更しない。記録も残さない（残すと本番の変更が「変更済み」で弾かれる）。
  if (input.dryRun !== true) {
    const begun = await beginWebGenreEdit(input.requestId, input.moneyId);
    if (begun.status === "done") {
      console.log(`[zaim] Web版でメモ変更済み: requestId=${input.requestId} moneyId=${begun.moneyId}`);
      return { ok: true, moneyId: begun.moneyId, duplicated: true };
    }
  }

  let stdout: string;
  try {
    stdout = await runZaimScript(
      WEB_MEMO_EDIT_SCRIPT,
      {
        timeout: WEB_MEMO_EDIT_TIMEOUT_MS,
        retryTransient: false,
        // moneyId や金額、メモの本文を引数に置くと `ps` に出る。環境変数で渡す。
        env: { ZAIM_WEB_MEMO_EDIT_INPUT: JSON.stringify(input) },
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
    // 送信の前に止まった失敗（マーカー `ZAIM_RECEIPT_FORM`。取り違えの検知を含む）と、送信後に
    // 確認できなかった失敗の分け方はカテゴリの変更と同じ。
    const failure = classifyWebGenreEditFailure(message);
    if (failure.kind === "rejected" && input.dryRun !== true) await abandonWebGenreEdit(input.requestId);
    // メモの本文はログへ出さない。
    console.warn(`[zaim] Web版でのメモ変更に失敗: requestId=${input.requestId} ${failure.reason}`);
    return { ok: false, ...failure };
  }

  let result: ZaimWebMemoEditScriptResult;
  try {
    result = JSON.parse(stdout) as ZaimWebMemoEditScriptResult;
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
  console.log(`[zaim] Web版でメモ変更: requestId=${input.requestId} moneyId=${input.moneyId}`);
  return { ok: true, moneyId: input.moneyId, duplicated: false };
}
