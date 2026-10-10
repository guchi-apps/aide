import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { loadZaimOAuthCredentials } from "../core/connectors/zaim/oauth.ts";
import {
  ZAIM_WEB_FORWARDED_HEADER,
  forwardZaimWebGenreEdit,
  forwardZaimWebMemoEdit,
  forwardZaimWebPayment,
  zaimWebUpstreamUrl,
} from "../core/connectors/zaim/web-payment-forward.ts";
import {
  createZaimWebPayment,
  normalizeWebPaymentInput,
  type CreateWebPaymentOutcome,
  type ZaimWebPaymentInput,
} from "../core/connectors/zaim/web-payment.ts";
import {
  createZaimWebGenreEdit,
  normalizeWebGenreEditInput,
  type CreateWebGenreEditOutcome,
} from "../core/connectors/zaim/web-genre-edit.ts";
import {
  createZaimWebMemoEdit,
  normalizeWebMemoEditInput,
} from "../core/connectors/zaim/web-memo-edit.ts";
import { normalizeReceiptRefreshInput } from "../core/connectors/zaim/receipt-refresh.ts";
import { forwardReceiptRefresh } from "../core/connectors/zaim/receipt-refresh-forward.ts";
import { receiptRefreshJobs } from "../worker/receipt-refresh-jobs.ts";
import {
  createZaimPayment,
  fetchZaimMaster,
  normalizePaymentInput,
  type CreatePaymentOutcome,
} from "../core/connectors/zaim/write.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * 個人アプリ向けのZaim登録API（aide#37）。
 *
 * car-care（給油記録）・asset-manager（レシート由来の支出）が「Zaimへ支出を登録する」ための口。
 * **Zaimの資格情報を持つのはAIDEだけ**にして、各アプリがそれぞれZaimクライアントと
 * 認証情報を抱える状態（asset-manager#191 が読み取り側で起きた重複）を書き込み側で作らない。
 *
 * 認証は共有シークレット1本で、**読み取り（`AIDE_READ_SECRET`）・受け口（`AIDE_INGEST_SECRET`）
 * とは別の値**にする。残高を読みたいだけのアプリへ、Zaimへ書き込む権限まで渡さないため。
 *
 * 呼び出し元は同じVPS上で動くので `http://127.0.0.1:<port>` で届く。外向けURLは要らない。
 * 公開URL（`aide.gucchii.com`）からはApacheの `<LocationMatch>` で `/api/zaim` と `/api/money` を
 * 落とす（guchi-apps/vps#101。`/api` を丸ごとは落とせない。workerがサブPCから
 * `POST /api/cache/:key` を外向けURLへ送るため）。
 *
 * **遮断が入っても、この口のシークレットと総当たり対策は要る。** Apacheを通らない
 * `127.0.0.1` 経由ではここが唯一の盾になるため、認可画面と同じ対策を掛けている。
 */

/** ボディの上限。登録1件のJSONは数百バイトで、これを大きく超えるものは読み切らない。 */
const MAX_BODY_BYTES = 64 * 1024;

export function zaimWriteSecret(): string | null {
  return process.env["AIDE_ZAIM_WRITE_SECRET"] || null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      // 支出の内容とZaimのマスタはどちらも個人情報。中間に残させない。
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
}

/**
 * 認証を通す。通れば true。通らなければ応答を書き終えて false。
 *
 * シークレット未設定は503で401とは分ける（`src/api/read.ts` と同じ理由。
 * 「設定していないから開いていない」と「値が違う」を切り分けられるようにする）。
 */
async function authorize(req: IncomingMessage, res: ServerResponse, label: string): Promise<boolean> {
  const expected = zaimWriteSecret();
  if (!expected) {
    json(res, 503, { error: "AIDE_ZAIM_WRITE_SECRET が未設定のため利用できません" });
    return false;
  }

  // 回数制限は画面のログインとは別の枠で数える（守っている値が別なので、
  // 片方の失敗でもう片方が止まると切り分けられない）。
  const key = `zaim:${clientKey(req)}`;
  const locked = lockedFor(key);
  if (locked !== null) {
    json(res, 429, { error: `試行回数の上限に達しています。${locked}秒後に再試行してください` });
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    recordFailure(key);
    console.warn(`[zaim-api] 認証失敗: ${label} from=${key}`);
    // 固定の待ちを挟んで、スクリプトによる高速な試行の速度を落とす。
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  recordSuccess(key);
  return true;
}

/** ボディを読む。上限を超えたら null を返し、応答は書き終えている。 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { error: "payload too large" });
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    json(res, 400, { error: "invalid json" });
    return null;
  }
}

/**
 * 失敗の種類をHTTPステータスへ移す。
 *
 * **`conflict`（409）だけは呼び出し元が再送してはいけない。** 前回の結果が確定しておらず、
 * 送り直すと同じ支出が二重に登録されうるため、人がZaimを確認するまで止める。
 */
function statusFor(kind: Exclude<CreatePaymentOutcome, { ok: true }>["kind"]): number {
  if (kind === "invalid") return 400;
  if (kind === "conflict") return 409;
  if (kind === "rejected") return 422;
  return 502;
}

/**
 * `POST /api/zaim/payment`
 *
 * 支出を1件登録し、Zaim側のレコードID（`moneyId`）を返す。呼び出し元はこれを自分のレコードへ
 * 保存して、登録済みかどうかを持つ。`requestId` が同じ再送はZaimへ送らず、前回の
 * `moneyId` を `duplicated: true` で返す。
 */
export async function handleZaimPayment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 認証の前にメソッドを見る（読み取りAPIと同じ理由。叩き方の誤りを401で隠さない）。
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res, "POST /api/zaim/payment"))) return;

  const credentials = loadZaimOAuthCredentials();
  if (!credentials) {
    json(res, 503, { error: "ZaimのOAuth設定（AIDE_ZAIM_*）が揃っていないため利用できません" });
    return;
  }

  const body = await readBody(req, res);
  if (body === null) return;

  const normalized = normalizePaymentInput(body);
  if ("error" in normalized) {
    json(res, 400, { ok: false, error: normalized.error });
    return;
  }

  const outcome = await createZaimPayment(credentials, normalized.input);
  if (!outcome.ok) {
    json(res, statusFor(outcome.kind), {
      ok: false,
      kind: outcome.kind,
      error: outcome.reason,
      requestId: normalized.input.requestId,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    moneyId: outcome.moneyId,
    duplicated: outcome.duplicated,
    requestId: normalized.input.requestId,
  });
}

/**
 * 中継するか、自分のところで画面を操作するかを決めて実行する（#215）。
 *
 * **中継してきたリクエストは二度と中継しない。** 受け側の `.env` に中継先URLが残っていると
 * 2台のあいだで永久に回り続けるため、ヘッダ1つで1往復に閉じる。この場合は画面の操作を
 * 試みる——storage state が無ければ `rejected` で返り、設定の誤りが呼び出し元まで伝わる。
 */
async function runOrForwardWebPayment(
  req: IncomingMessage,
  input: ZaimWebPaymentInput,
): Promise<CreateWebPaymentOutcome> {
  const upstream = zaimWebUpstreamUrl();
  if (!upstream) return createZaimWebPayment(input);

  if (req.headers[ZAIM_WEB_FORWARDED_HEADER] === "1") {
    console.warn(
      "[zaim-api] 中継されたリクエストに AIDE_ZAIM_WEB_UPSTREAM_URL が設定されています。" +
        "受け口側では設定しないでください。ここでは中継せず画面の操作を試みます。",
    );
    return createZaimWebPayment(input);
  }

  const secret = zaimWriteSecret();
  // `authorize()` を通っている以上ここには来ないが、型のために見る。
  if (!secret) return { ok: false, kind: "rejected", reason: "AIDE_ZAIM_WRITE_SECRET が未設定です" };

  console.log(`[zaim-api] Web版の登録を中継: requestId=${input.requestId}`);
  return forwardZaimWebPayment(input, { baseUrl: upstream, secret });
}

/**
 * `POST /api/zaim/payment/web`
 *
 * **Web版の入力画面を操作して**品目明細を1件登録する（#214）。公式APIで作った明細は
 * Zaimの「レシート置き換え」の候補にならないため、置き換えに載せたいものはこちらを使う。
 *
 * 上の `POST /api/zaim/payment` との違い。
 *
 * | | `/api/zaim/payment` | `/api/zaim/payment/web` |
 * |---|---|---|
 * | 資格情報 | ZaimのOAuth（`AIDE_ZAIM_*`） | ログイン状態（storage state） |
 * | 分類の指定 | `categoryId` / `genreId` | `categoryName` / `genreName` |
 * | 返す `moneyId` | Zaimのレコードid | **常に null**（画面にidが出ない） |
 * | 応答までの時間 | 1秒未満 | **数十秒**（ヘッドレスChromiumを起動する） |
 *
 * **この口はどのマシンでも画面を操作できるわけではない。** Playwrightとログイン状態
 * （`data/zaim/storage-state.json`）があるのはサブPCだけで、VPSのサーバーには無い。
 * そこで `AIDE_ZAIM_WEB_UPSTREAM_URL` が設定されていれば、**同じ口を開いているサブPCの
 * 受け口へ中継する**（#215。受け口は `src/worker/zaim-web-server.ts`）。未設定なら
 * 従来どおり自分のところで画面を操作する——サブPC側の受け口がこちらの経路を通る。
 *
 * **呼び出し元はタイムアウトを長く取ること。** 画面の操作は数十秒かかるので、既定の
 * 短いタイムアウトで切ると「登録されたか分からない」状態を作ることになる。中継する場合も
 * 待ち時間は変わらない（VPSは応答を待つだけで、Chromiumは起動しない）。
 */
export async function handleZaimWebPayment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res, "POST /api/zaim/payment/web"))) return;

  // **OAuthの設定は見ない。** この経路が使うのはログイン状態だけで、`AIDE_ZAIM_*` は要らない。
  // ここで503にすると、Zaimへ書ける環境なのに口が開かないことになる。
  const body = await readBody(req, res);
  if (body === null) return;

  const normalized = normalizeWebPaymentInput(body);
  if ("error" in normalized) {
    json(res, 400, { ok: false, kind: "invalid", error: normalized.error });
    return;
  }

  const outcome = await runOrForwardWebPayment(req, normalized.input);
  if (!outcome.ok) {
    json(res, statusFor(outcome.kind), {
      ok: false,
      kind: outcome.kind,
      error: outcome.reason,
      requestId: normalized.input.requestId,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    moneyId: outcome.moneyId,
    duplicated: outcome.duplicated,
    requestId: normalized.input.requestId,
    registered: outcome.registered,
  });
}

/**
 * 既存明細を編集画面から変更する経路（カテゴリ・内訳の #273、メモの #354）が共通で通る処理。
 *
 * 中継するか、自分のところで画面を操作するかを決めて実行する。`runOrForwardWebPayment` と同じ
 * 考え方で、同じ `AIDE_ZAIM_WEB_UPSTREAM_URL` を見る（受け口は新規登録と既存明細の変更の
 * どれも同じマシン・同じサーバーで受ける）。
 */
async function runOrForwardWebEdit<
  Input extends { requestId: string },
  Outcome extends CreateWebGenreEditOutcome,
>(
  req: IncomingMessage,
  input: Input,
  run: (input: Input) => Promise<Outcome>,
  forward: (input: Input, options: { baseUrl: string; secret: string }) => Promise<Outcome>,
): Promise<Outcome | { ok: false; kind: "rejected"; reason: string }> {
  const upstream = zaimWebUpstreamUrl();
  if (!upstream) return run(input);

  if (req.headers[ZAIM_WEB_FORWARDED_HEADER] === "1") {
    console.warn(
      "[zaim-api] 中継されたリクエストに AIDE_ZAIM_WEB_UPSTREAM_URL が設定されています。" +
        "受け口側では設定しないでください。ここでは中継せず画面の操作を試みます。",
    );
    return run(input);
  }

  const secret = zaimWriteSecret();
  if (!secret) return { ok: false, kind: "rejected", reason: "AIDE_ZAIM_WRITE_SECRET が未設定です" };

  console.log(`[zaim-api] Web版の変更を中継: requestId=${input.requestId}`);
  return forward(input, { baseUrl: upstream, secret });
}

/**
 * 既存明細を編集画面から変更する経路のハンドラの骨格。405 → 認証 → 本文 → 検査 → 実行 → 応答の
 * 順と、失敗の割り当て（`statusFor`）を、カテゴリ・内訳とメモで同じにするために1か所へ置く。
 */
async function handleWebEdit<
  Input extends { requestId: string },
  Outcome extends CreateWebGenreEditOutcome,
>(
  req: IncomingMessage,
  res: ServerResponse,
  label: string,
  normalize: (raw: unknown) => { input: Input } | { error: string },
  run: (input: Input) => Promise<Outcome>,
  forward: (input: Input, options: { baseUrl: string; secret: string }) => Promise<Outcome>,
): Promise<void> {
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res, label))) return;

  const body = await readBody(req, res);
  if (body === null) return;

  const normalized = normalize(body);
  if ("error" in normalized) {
    json(res, 400, { ok: false, kind: "invalid", error: normalized.error });
    return;
  }

  const outcome = await runOrForwardWebEdit(req, normalized.input, run, forward);
  if (!outcome.ok) {
    json(res, statusFor(outcome.kind), {
      ok: false,
      kind: outcome.kind,
      error: outcome.reason,
      requestId: normalized.input.requestId,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    moneyId: outcome.moneyId,
    duplicated: outcome.duplicated,
    requestId: normalized.input.requestId,
  });
}

/**
 * `POST /api/zaim/payment/web/genre`
 *
 * **Web版の編集画面を操作して**既存明細（自動連携明細を含む）のカテゴリ・内訳だけを変更する（#273）。
 * 公式APIは自動連携明細を編集できず、新規登録（`/api/zaim/payment/web`）とは別に、既存の明細を
 * 対象にした経路として設ける。
 *
 * 上の `POST /api/zaim/payment/web` との違い。
 *
 * | | `/api/zaim/payment/web` | `/api/zaim/payment/web/genre` |
 * |---|---|---|
 * | 対象 | 新規の明細を作る | **既存の明細（`moneyId` で指定）を変更する** |
 * | 触る項目 | 全項目 | **カテゴリ・内訳だけ** |
 * | 返す `moneyId` | 常に `null` | **渡した `moneyId` をそのまま** |
 * | 取り違えの検知 | 無し | **開いた明細の `date`・`amount` が一致しなければ422で止める** |
 *
 * 中継・同時実行ロックの考え方は上と同じ。呼び出し元はタイムアウトを長く取ること。
 */
export async function handleZaimWebGenreEdit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleWebEdit(
    req,
    res,
    "POST /api/zaim/payment/web/genre",
    normalizeWebGenreEditInput,
    createZaimWebGenreEdit,
    forwardZaimWebGenreEdit,
  );
}

/**
 * `POST /api/zaim/payment/web/memo`
 *
 * **Web版の編集画面を操作して**既存明細（自動連携明細を含む）の**メモだけ**を書き換える（#354）。
 * 銀行口座・デビットカードの連携明細はZaimの「置き換え」の対象外なので、asset-manager の家計簿連携
 * （asset-manager#514）は買った物をメモへ直接書き込む。`/web/genre` と同じ画面・同じ約束で、
 * 触る項目だけが違う。
 *
 * | | `/api/zaim/payment/web/genre` | `/api/zaim/payment/web/memo` |
 * |---|---|---|
 * | 触る項目 | カテゴリ・内訳だけ | **メモだけ**（空文字なら消す） |
 * | 本文 | `categoryName` / `genreName` | `comment`（100文字まで。超過は400） |
 * | 取り違えの検知・冪等・ロック・ステータス | 同じ | 同じ |
 *
 * **`requestId` はメモへ混ぜない**（利用者が読むメモが汚れる）。冪等は記録だけで担う。
 */
export async function handleZaimWebMemoEdit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleWebEdit(
    req,
    res,
    "POST /api/zaim/payment/web/memo",
    normalizeWebMemoEditInput,
    createZaimWebMemoEdit,
    forwardZaimWebMemoEdit,
  );
}

/**
 * `GET /api/zaim/master`
 *
 * 口座・カテゴリ・ジャンルのID一覧。登録時に渡す `categoryId` / `genreId` / `fromAccountId` を
 * 呼び出し元が引くための口で、**連携先の設定時に使うことを想定している**（毎回は叩かない）。
 *
 * **この口はキャッシュを挟まない。** 設定時にしか呼ばれないので毎回Zaimを叩いてよい。
 * MCP経由（`aide_zaim_master`）は登録のたびに引かれるため24時間キャッシュしており、
 * **経路によって鮮度が違う**（aide#135）。
 */
export async function handleZaimMaster(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res, "GET /api/zaim/master"))) return;

  const credentials = loadZaimOAuthCredentials();
  if (!credentials) {
    json(res, 503, { error: "ZaimのOAuth設定（AIDE_ZAIM_*）が揃っていないため利用できません" });
    return;
  }

  const outcome = await fetchZaimMaster(credentials);
  if (!outcome.ok) {
    json(res, 502, { ok: false, error: outcome.reason });
    return;
  }
  json(res, 200, { ok: true, ...outcome.master });
}

/**
 * `POST /api/zaim/receipt-detail/refresh` / `GET /api/zaim/receipt-detail/refresh/<jobId>`（#600）
 *
 * **対象の1取引の商品内訳（スマートレシート・Amazon等）をZaimから最新取得する。** `GET /api/money/transactions`
 * は定期巡回（11:30 / 23:30）のキャッシュを返すので、最大約12時間古い。こちらは依頼した時点のZaimを読む。
 * **読むだけで、Zaimの取引の登録・更新・削除はしない。**
 *
 * 取得はPlaywrightで数十秒かかるため、**非同期**にしている。
 *
 * 1. `POST`（本文 `{ moneyId, date, amount }`。`date`・`amount` は取り違えの検知用）→ **202** と
 *    `job`（`status: "running"`）。**受付は成功ではない。**
 * 2. `GET .../<jobId>` を繰り返し読み、`job.status` が `succeeded` / `failed` になるまで待つ
 *
 * 成功の判定は `job.status === "succeeded"` かつ `job.fetchedAt`（今回Zaimから読み取れた時刻）。
 * `job.result.entry` が `GET /api/money/transactions` の `entries[]` と同じ `items` / `itemsStatus` /
 * `itemsNote` 契約で、`itemsStatus` が `complete` のときだけ商品明細として確定してよい。
 * 失敗は `job.failure.kind`（`busy`・`session_expired`・`not_found`・`detail_failed`・`fetch_failed`）と
 * `retryable` で判別する。中継先（サブPC）の問題は `subpc_unreachable`・`subpc_timeout`・
 * `subpc_rejected`・`subpc_bad_response`（HTTP 502）で、取得を試みていない。
 *
 * 認証は他のZaim口と同じ `AIDE_ZAIM_WRITE_SECRET`。実行はサブPCの受け口（`zaim-web-server.ts`）で、
 * VPSでは `AIDE_ZAIM_WEB_UPSTREAM_URL` へ中継する（ジョブの状態はサブPCのメモリにあり、受け口の
 * 再起動で消える。そのときの `GET` は `job_not_found`〔404〕で、依頼し直せばよい）。
 */
export async function handleZaimReceiptRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string | null,
): Promise<void> {
  const method = jobId === null ? "POST" : "GET";
  if (req.method !== method) {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: method })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res, `${method} /api/zaim/receipt-detail/refresh`))) return;

  let body: unknown = null;
  if (jobId === null) {
    body = await readBody(req, res);
    if (body === null) return;
    const normalized = normalizeReceiptRefreshInput(body);
    if ("error" in normalized) {
      json(res, 400, { ok: false, failure: { kind: "invalid", retryable: false, message: normalized.error } });
      return;
    }
    body = normalized.input;
  }

  const upstream = zaimWebUpstreamUrl();
  const secret = zaimWriteSecret();
  if (upstream && req.headers[ZAIM_WEB_FORWARDED_HEADER] !== "1" && secret) {
    const forwarded = await forwardReceiptRefresh(
      jobId === null ? { method: "POST", body } : { method: "GET", jobId },
      { baseUrl: upstream, secret },
    );
    json(res, forwarded.status, forwarded.body);
    return;
  }

  if (jobId === null) {
    const outcome = receiptRefreshJobs.submit(
      body as Parameters<typeof receiptRefreshJobs.submit>[0],
    );
    if (!outcome.ok) {
      json(res, 429, { ok: false, failure: outcome.failure });
      return;
    }
    json(res, 202, { ok: true, job: outcome.job, deduplicated: outcome.deduplicated });
    return;
  }

  const job = receiptRefreshJobs.get(jobId);
  if (!job) {
    json(res, 404, {
      ok: false,
      failure: {
        kind: "job_not_found",
        retryable: true,
        message: "ジョブが見つかりません（期限切れか、サブPCの受け口が再起動しました）。依頼し直してください。",
      },
    });
    return;
  }
  json(res, 200, { ok: true, job });
}
