import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { getSharedToken } from "../core/connectors/issue-deck/shared-tokens.ts";
import { buildMoneySummary } from "../core/views/money.ts";
import {
  buildMoneyTransactions,
  type MoneyTransactionsRange,
  type MoneyTransactionsView,
} from "../core/views/money-transactions.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * 既存の個人アプリ向けの読み取りAPI。
 *
 * AIDEは同じデータを、LLMクライアントへはMCPで、個人アプリへはRESTで出す。
 * ここはその後者にあたる。**キャッシュを読むだけで、取得は行わない**
 * （Zaim巡回は worker の仕事。README「取得と提供の分離」）。
 *
 * 出すのは横断ビュー（`buildMoneySummary()`）で、キャッシュの生の形は出さない。
 * 外へ見せる契約を1本に保ち、キャッシュの構造を後から変えられる余地を残すため。
 *
 * 認証は共有シークレット1本で、**書き込み用の `AIDE_INGEST_SECRET` とは別の値**にする。
 * 同じ値を使うと、読み取りたいだけのアプリへ書き込み権限まで渡すことになる。
 */

/**
 * 値は issue-deck の共有トークンAPI（`AIDE_READ_SECRET`。aide#513）から取得する。
 * 取得できなければ環境変数 `AIDE_READ_SECRET` へフォールバックする。
 */
export async function readSecret(): Promise<string | null> {
  const shared = await getSharedToken("AIDE_READ_SECRET", "aide");
  if (shared) return shared;
  return process.env["AIDE_READ_SECRET"] || null;
}

/**
 * 認証を通す。通れば true。通らなければ応答を書き終えて false。
 *
 * シークレット未設定は503で、401とは分ける。「設定していないから開いていない」と
 * 「値が違う」を同じ応答にすると、連携時にどちらなのか切り分けられない。
 */
async function authorize(req: IncomingMessage, res: ServerResponse, label: string): Promise<boolean> {
  const expected = await readSecret();
  if (!expected) {
    res
      .writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "AIDE_READ_SECRET が未設定のため利用できません" }));
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    console.warn(`[read] 認証失敗: ${label}`);
    res
      .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

/**
 * `GET /api/money/summary`
 *
 * MCPツール `aide_balances` と `aide_fixed_costs` を合わせた内容を返す。呼び出し側（asset-manager）が要る
 * `balances`・`holdings` に加えて、`fetchedAt`・`ageMinutes`・`stale` を必ず併せて返す。
 * **鮮度の判断は呼び出し側に委ねる**（`src/core/views/money.ts` と同じ方針）。
 */
export async function handleMoneySummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 認証の前にメソッドを見る。未対応のメソッドに401を返すと、
  // 呼び出し側が「鍵が違うのか叩き方が違うのか」を切り分けられない。
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!(await authorize(req, res, "GET /api/money/summary"))) return;

  // キャッシュが空でも200を返す。「まだ一度も取得していない」は状態であってエラーではなく、
  // empty / fetchedAt を見れば呼び出し側で区別できる（MCP側が isError:false にしているのと同じ理由）。
  const summary = await buildMoneySummary();
  res
    .writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      // 残高は変わるうえ、値そのものが個人情報にあたる。中間に残させない。
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(summary));
}

const gzipAsync = promisify(gzip);

/** `YYYY-MM-DD` で、実在する日付か。 */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` を読む。どちらも無ければ undefined（従来どおり全件）。
 * 不正な値はエラー文言を返す（黙って全件を返すと、呼び出し側が絞れたつもりで突き合わせを誤る）。
 */
export function parseTransactionsRange(url: string | undefined): MoneyTransactionsRange | undefined | { error: string } {
  const params = new URL(url ?? "/", "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (from === null && to === null) return undefined;
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value !== null && !isValidDate(value)) return { error: `${name} は YYYY-MM-DD の実在する日付で指定してください` };
  }
  if (from !== null && to !== null && from > to) return { error: "from は to 以前の日付で指定してください" };
  return { from, to };
}

/**
 * 明細一覧のETag（弱いETag）。
 *
 * 呼び出しごとに動く `ageMinutes`・`stale`・`note` は**含めない**（含めると一致する日が来ない）。
 * `fetchedAt` だけでなく `entries` まで含めるのは、巡回の間に手動再取得した商品内訳の差し替え
 * （`itemsFetchedAt`）を304で隠さないため。期間指定は `range` と絞った `entries` に表れるので、
 * 期間ごとに別の値になる。gzipの有無で同じ値を使うため弱いETagにする。
 */
export function transactionsEtag(view: MoneyTransactionsView): string {
  const { ageMinutes: _age, stale: _stale, note: _note, ...stable } = view;
  const hash = createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 32);
  return `W/"${hash}"`;
}

/** `If-None-Match` がETagに一致するか（弱い比較。`*` も一致とみなす）。 */
function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return raw.split(",").some((tag) => tag.trim() === "*" || strip(tag) === strip(etag));
}

/** `Accept-Encoding` が gzip を受け付けるか（`q=0` は拒否の意味なので除く）。 */
function acceptsGzip(header: string | string[] | undefined): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * `GET /api/money/transactions`
 *
 * Zaim Web版の家計簿明細一覧（当月＋先月ぶん、JST）をキャッシュから返す。公式API
 * （`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も含む（aide#244・aide#286）。
 *
 * 受け取る量を減らすための口（aide#785）。パラメータもヘッダーも無ければ従来どおり全件を返す。
 * - `?from=YYYY-MM-DD&to=YYYY-MM-DD`（片側だけも可）: その期間の明細だけを返す。`months` は期間に
 *   月まるごと入る月だけに絞る
 * - `If-None-Match`: 前回の `ETag` と一致すれば本文無しの304
 * - `Accept-Encoding: gzip`: 圧縮して返す
 * - 鮮度は304でも分かるよう `X-AIDE-Fetched-At`・`X-AIDE-Age-Minutes`・`X-AIDE-Stale` ヘッダーでも返す
 */
export async function handleMoneyTransactions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!(await authorize(req, res, "GET /api/money/transactions"))) return;

  const range = parseTransactionsRange(req.url);
  if (range && "error" in range) {
    res
      .writeHead(400, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: range.error }));
    return;
  }

  const transactions = await buildMoneyTransactions(range ? { range } : {});
  const etag = transactionsEtag(transactions);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-AIDE-Stale": String(transactions.stale),
    ...(transactions.fetchedAt !== null ? { "X-AIDE-Fetched-At": transactions.fetchedAt } : {}),
    ...(transactions.ageMinutes !== null ? { "X-AIDE-Age-Minutes": String(transactions.ageMinutes) } : {}),
  };

  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, headers).end();
    return;
  }

  const json = JSON.stringify(transactions);
  if (acceptsGzip(req.headers["accept-encoding"])) {
    const body = await gzipAsync(json);
    res
      .writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" })
      .end(body);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" }).end(json);
}
