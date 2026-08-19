import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { loadZaimOAuthCredentials } from "../core/connectors/zaim/oauth.ts";
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
 * ただし**`/api` を丸ごと外部から遮断することはできない**（workerがサブPCから
 * `POST /api/cache/:key` を外向けURLへ送るため）。Apacheで `/api/zaim` を落とすまでのあいだ、
 * シークレット1本だけが盾になるので、認可画面と同じ総当たり対策をここにも掛けている。
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
 * `GET /api/zaim/master`
 *
 * 口座・カテゴリ・ジャンルのID一覧。登録時に渡す `categoryId` / `genreId` / `fromAccountId` を
 * 呼び出し元が引くための口で、**連携先の設定時に使うことを想定している**（毎回は叩かない）。
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
