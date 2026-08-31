import {
  isZaimAutoReloginFailed,
  isZaimReceiptFormFailure,
  isZaimReceiptSubmitted,
  isZaimSessionExpired,
  zaimSessionExpiredMessage,
} from "./errors.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import {
  MAX_AMOUNT,
  MAX_REQUEST_ID_LENGTH,
  MAX_TEXT_LENGTH,
  isValidDate,
  normalizeId,
  normalizeText,
} from "./write.ts";
import { abandonWebPayment, beginWebPayment, completeWebPayment } from "./web-idempotency.ts";

/**
 * Zaim Web版の入力画面からの品目明細の登録（#214）。
 *
 * ## なぜ公式API（`write.ts`）と別に要るのか
 *
 * Zaimの「レシート置き換え」（カード明細と手入力を突き合わせて1件にまとめる機能）の候補に
 * なるのは、**Web版の入力画面で作った明細だけ**。品目・出金元・日付・金額がまったく同じでも、
 * `POST /v2/home/money/payment` で作ったものは候補にならない（guchi-apps/asset-manager#300 で
 * 実測）。分かれ目は内容ではなく**作成経路**にある。
 *
 * したがって、置き換えに載せたい明細だけはブラウザで画面を操作して作る。
 * 置き換えの操作そのものはスマートフォンアプリ限定なので、**ここは登録までを担い、
 * 置き換えは人が行う**。
 *
 * ## 公式API経由との違い
 *
 * | | 公式API（`write.ts`） | Web版の入力画面（ここ） |
 * |---|---|---|
 * | 手段 | OAuth 1.0a でのHTTP | Playwrightでの画面操作 |
 * | 資格情報 | `AIDE_ZAIM_*` | ログイン状態（storage state。Cookieそのもの） |
 * | 動く場所 | どこでも（VPSのサーバー内で完結） | **storage state と Playwright があるマシンだけ**（サブPC） |
 * | 所要 | 1秒未満 | ヘッドレスChromiumの起動を含めて数十秒 |
 * | カテゴリの指定 | `categoryId` / `genreId` | **名前**（画面がIDを受け取らない） |
 * | 返せるID | `money_id` | **返せない**（画面にIDが出ない。冪等キーをメモへ載せる） |
 * | 置き換えの候補になるか | ならない | **なる** |
 *
 * カテゴリの対応（「ガソリン代 → 交通費/ガソリン」など）は `write.ts` と同じく**持たない**。
 * 呼び出し元がカテゴリ名・ジャンル名まで決めて渡す。名前は `fetchZaimMaster()`
 * （`GET /api/zaim/master`）で引ける。
 */

/**
 * 1回の実行の上限。
 *
 * Chromiumの起動とページ読み込みで30秒近くかかり、そのうえで欄を1つずつ埋めて
 * 送信の完了まで待つ。巡回（5分）ほどは要らないが、`keep-alive`（2分）では足りない。
 */
export const WEB_PAYMENT_TIMEOUT_MS = 180_000;

const WEB_PAYMENT_SCRIPT = zaimScriptPath("web-payment.mjs");

export interface ZaimWebPaymentInput {
  /** 呼び出し元がレコードごとに一意に決める冪等キー（例: `asset-manager:receipt-item:1234`）。 */
  requestId: string;
  amount: number;
  /** `YYYY-MM-DD`。 */
  date: string;
  /** 品目名。**置き換えの条件に入るため必須**。 */
  name: string;
  /** 店舗名。 */
  place: string;
  /** カテゴリ名（Zaimのカテゴリ設定にある表記そのまま）。 */
  categoryName: string;
  /** ジャンル名（内訳。Zaimのカテゴリ設定にある表記そのまま）。 */
  genreName: string;
  /**
   * 出金元の口座ID。`fetchZaimMaster()` の `accounts[].id` と同じ値。
   *
   * **自動連携しているクレジットカードを指定する。** 置き換えの候補になる条件で、
   * 「反映待ち」などの手動口座を指定すると登録はできても置き換えに載らない。
   * どの口座が自動連携かはAIDEでは判断しないので、呼び出し元が決める。
   */
  fromAccountId: number;
  comment?: string | undefined;
  /** 立てると**送信だけ行わない**。画面の当て方を確かめるためのモード。 */
  dryRun?: boolean | undefined;
}

export interface ZaimWebPaymentRegistered {
  date: string;
  amount: number;
  name: string;
  place: string;
  genre: string;
  /** 実際に選ばれた出金元の口座名。桁違いや口座の取り違えに呼び出し元が気づけるように返す。 */
  accountName: string;
  /** 実際にメモ欄へ入った文字列（冪等キーを含む）。 */
  comment: string;
}

export type CreateWebPaymentOutcome =
  | {
      ok: true;
      /**
       * **常に null。** この画面から登録した明細のIDは画面に出ない。
       * 呼び出し元は `requestId` で登録済みを持ち、Zaim側で引くときはメモに載った
       * `#<requestId>` を手掛かりにする。
       */
      moneyId: null;
      duplicated: boolean;
      registered: ZaimWebPaymentRegistered | null;
    }
  | {
      ok: false;
      /**
       * - `invalid` … 入力が不正。直して送り直せばよい
       * - `conflict` … 前回の結果が不明。**勝手に再送しない**（人がZaimを確認する）
       * - `rejected` … 送信の前に止まった。**Zaimには何も登録されていない**
       * - `failed` … 送信後に確認できない・打ち切り。登録されたかは不明
       */
      kind: "invalid" | "conflict" | "rejected" | "failed";
      reason: string;
    };

/**
 * 受け取ったJSONを検査して入力へ変換する。
 *
 * **ここを通ったものだけがZaimへ届く。** この経路は編集も削除も持たないので、
 * 疑わしいものは画面を開く前に断る（`normalizePaymentInput()` と同じ考え方）。
 *
 * 公式API経由と違って `name`・`place`・カテゴリ・出金元がすべて必須。**置き換えの成立条件が
 * 「品目・出金元・日付・金額の一致」なので、欠けた明細を作っても目的を果たさない。**
 */
export function normalizeWebPaymentInput(
  raw: unknown,
): { input: ZaimWebPaymentInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSONオブジェクトを送ってください" };
  }
  const body = raw as Record<string, unknown>;

  const requestId = typeof body["requestId"] === "string" ? body["requestId"].trim() : "";
  if (!requestId) return { error: "requestId が必要です（呼び出し元のレコードごとに一意な文字列）" };
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { error: `requestId が長すぎます（${MAX_REQUEST_ID_LENGTH}文字まで）` };
  }
  // 制御文字はログにも記録にもメモ欄にも入るため落とす。
  if (/[\u0000-\u001f\u007f]/.test(requestId)) return { error: "requestId に制御文字は使えません" };

  const amount = body["amount"];
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    return { error: "amount は1以上の整数で指定してください" };
  }
  if (amount > MAX_AMOUNT) return { error: `amount が大きすぎます（${MAX_AMOUNT}まで）` };

  const date = body["date"];
  if (typeof date !== "string" || !isValidDate(date)) {
    return { error: "date は YYYY-MM-DD 形式の実在する日付で指定してください" };
  }

  const required: Array<[keyof ZaimWebPaymentInput, string]> = [
    ["name", "name（品目名）"],
    ["place", "place（店舗名）"],
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

  const fromAccountId = normalizeId(body["fromAccountId"], "fromAccountId", true);
  if ("error" in fromAccountId) return { error: fromAccountId.error };

  const comment = normalizeText(body["comment"], "comment");
  if ("error" in comment) return { error: comment.error };

  // メモには冪等キーも載せる。長さの検査はスクリプト側（`composeComment`）が持つが、
  // 画面を開く前に弾けるものはここで弾く。
  const commentLength = (comment.value ? comment.value.length + 1 : 0) + requestId.length + 1;
  if (commentLength > MAX_TEXT_LENGTH) {
    return {
      error:
        `comment と requestId の合計が ${MAX_TEXT_LENGTH} 文字を超えます（${commentLength} 文字）。` +
        "メモには冪等キーも書き込むため、どちらかを短くしてください",
    };
  }

  return {
    input: {
      requestId,
      amount,
      date,
      name: texts["name"]!,
      place: texts["place"]!,
      categoryName: texts["categoryName"]!,
      genreName: texts["genreName"]!,
      fromAccountId: fromAccountId.value!,
      ...(comment.value === undefined ? {} : { comment: comment.value }),
      ...(body["dryRun"] === true ? { dryRun: true } : {}),
    },
  };
}

export interface ZaimWebPaymentScriptResult {
  submitted: boolean;
  url: string;
  resultUrl?: string;
  filled: {
    name: string;
    genre: string;
    amount: number | null;
    comment: string;
    place: string;
    date: string;
    accountName: string;
  };
}

/**
 * 失敗を「Zaimに登録されていないと言い切れるか」で分ける。
 *
 * **ここの判断が二重登録の分かれ目になる。** 言い切れるのは、スクリプトが送信ボタンを押す前に
 * 止まった場合（`ZAIM_RECEIPT_FORM`）だけ。それ以外——送信後に確認できなかった、
 * 実行が打ち切られた、Chromiumが落ちた——は**登録された可能性が残る**ため記録を残し、
 * 次の再送を `conflict` で止める。
 */
export function classifyWebFailure(message: string): { kind: "rejected" | "failed"; reason: string } {
  if (isZaimReceiptSubmitted(message)) {
    return {
      kind: "failed",
      reason:
        "Zaimへ送信しましたが、登録できたかを確認できませんでした。" +
        "Zaimの画面で登録されているかを確認してください。",
    };
  }
  if (isZaimReceiptFormFailure(message)) {
    // 画面の作りと噛み合わなかった理由をそのまま返す。Zaimの仕様変更を人が読んで気づけるように。
    const detail = message.split("ZAIM_RECEIPT_FORM:")[1]?.split("\n")[0] ?? message;
    return { kind: "rejected", reason: `Zaimの入力画面と噛み合いませんでした: ${detail}` };
  }
  return {
    kind: "failed",
    reason: `Zaimの入力画面を操作できませんでした: ${message.split("\n")[0]}`,
  };
}

/**
 * Web版の入力画面から品目明細を1件登録する。
 *
 * 画面を触る前に記録を置き、登録できたら確定させる（`web-idempotency.ts`）。
 * 同じ `requestId` の再送は画面を開かずに `duplicated: true` を返す。
 *
 * **一時的な失敗をやり直さない**（`retryTransient: false`）。巡回と違って、やり直すと
 * 同じ明細が2件できうるため。セッション失効時の自動再ログインは従来どおり通る——
 * 失効はページを開いた時点で分かるので、送信より前で必ず起きる。
 *
 * **ヘッドレスChromiumを起動するため数十秒かかる。** 呼び出し元は同期リクエストで待つことに
 * なるので、タイムアウトを長めに取ること。
 */
export async function createZaimWebPayment(
  input: ZaimWebPaymentInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebPaymentOutcome> {
  // **同時に2件流さない**（#215）。#214 の時点では手元から1件ずつ叩くだけだったが、
  // VPSから中継が届くようになると、呼び出し元の作り次第で並行して来る。ログイン状態
  // （storage state）はファイル1つで、2つのChromiumが同時に開くと更新が競合し、
  // 巡回まで巻き込んでセッションを失う。
  //
  // 待たせずに断るのは、待たせると呼び出し元のタイムアウトに掛かって
  // 「登録されたか分からない」（`failed`）になるため。**画面を開く前に断れば
  // `rejected` と言い切れる**ので、呼び出し元はそのまま送り直せる。
  if (inFlight) {
    return {
      ok: false,
      kind: "rejected",
      reason:
        "別のZaim Web版の登録を処理中です。Zaimには何も登録されていません。" +
        "1件ずつ順に送り直してください。",
    };
  }
  inFlight = true;
  try {
    return await runZaimWebPayment(input, deps);
  } finally {
    inFlight = false;
  }
}

/** 実行中かどうか。プロセス内でしか見ないので、受け口は1プロセスに限る。 */
let inFlight = false;

async function runZaimWebPayment(
  input: ZaimWebPaymentInput,
  deps?: ZaimScriptDeps,
): Promise<CreateWebPaymentOutcome> {
  // dryRun は登録しない。記録も残さない（残すと本番の登録が「登録済み」で弾かれる）。
  if (input.dryRun !== true) {
    const begun = await beginWebPayment(input.requestId);
    if (begun.status === "done") {
      console.log(`[zaim] Web版から登録済み: requestId=${input.requestId}`);
      return { ok: true, moneyId: null, duplicated: true, registered: null };
    }
    if (begun.status === "unresolved") {
      return {
        ok: false,
        kind: "conflict",
        reason:
          `同じ requestId の登録を ${begun.at} に試みており、結果が確定していません。` +
          "Zaimを確認し、登録されていなければ別の requestId で送り直してください。",
      };
    }
  }

  let stdout: string;
  try {
    stdout = await runZaimScript(
      WEB_PAYMENT_SCRIPT,
      {
        timeout: WEB_PAYMENT_TIMEOUT_MS,
        retryTransient: false,
        // 金額・店名を引数に置くと `ps` に出る。環境変数で渡す。
        env: { ZAIM_WEB_PAYMENT_INPUT: JSON.stringify(input) },
      },
      deps,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      // 失効はページを開いた時点で分かるので、送信前に止まっている＝登録されていない。
      if (input.dryRun !== true) await abandonWebPayment(input.requestId);
      return {
        ok: false,
        kind: "rejected",
        reason: zaimSessionExpiredMessage(isZaimAutoReloginFailed(message)),
      };
    }
    const failure = classifyWebFailure(message);
    // 送信の前に止まった場合だけ記録を消す。それ以外は残し、次の再送を止める。
    if (failure.kind === "rejected" && input.dryRun !== true) await abandonWebPayment(input.requestId);
    console.warn(`[zaim] Web版からの登録に失敗: requestId=${input.requestId} ${failure.reason}`);
    return { ok: false, ...failure };
  }

  let result: ZaimWebPaymentScriptResult;
  try {
    result = JSON.parse(stdout) as ZaimWebPaymentScriptResult;
  } catch {
    // スクリプトは最後まで走ったのに応答を読めない。登録された可能性が残るため記録は消さない。
    return { ok: false, kind: "failed", reason: "Zaim登録スクリプトの応答を読めませんでした" };
  }

  const registered: ZaimWebPaymentRegistered = {
    date: input.date,
    amount: input.amount,
    name: result.filled?.name ?? input.name,
    place: result.filled?.place ?? input.place,
    genre: result.filled?.genre ?? input.genreName,
    accountName: result.filled?.accountName ?? "",
    comment: result.filled?.comment ?? "",
  };

  if (input.dryRun === true) {
    return { ok: true, moneyId: null, duplicated: false, registered };
  }
  if (result.submitted !== true) {
    // 送信していないのに成功として返ってきた。想定外なので記録は残したまま失敗させる。
    return { ok: false, kind: "failed", reason: "Zaim登録スクリプトが送信を行いませんでした" };
  }

  await completeWebPayment(input.requestId);
  console.log(`[zaim] Web版から登録: requestId=${input.requestId}`);
  return { ok: true, moneyId: null, duplicated: false, registered };
}
