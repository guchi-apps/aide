/**
 * issue-deck の共有トークンAPIから値を取得するコネクタ（aide#509。起点 guchi-apps/question#75）。
 *
 * 他アプリのAPIを呼ぶための認証値を、1Passwordから複製せず issue-deck の共有トークンAPIから
 * 実行時に取得する（方式A）。1本目が ops-dashboard 向け動作状況APIの `AIDE_STATUS_TOKEN`
 * （利用元 `src/api/status.ts`）で、後続で他のトークン（`AIDE_OPS_DASHBOARD_TOKEN` 等）も
 * 同じ経路へ移すため、`getSharedToken()` はトークン名を引数に取る形にして使い回せるようにしてある。
 *
 * APIの仕様: guchi-apps/issue-deck の `docs/shared-token-api.md`。
 *   `GET /api/shared-tokens?name=<名前>` に `Authorization: Bearer <SHARED_TOKEN_API_SECRET>` と
 *   `X-Shared-Token-Consumer: <利用元>` を付けると `{ name, value }` が返る。
 *
 * 取得した値はメモリに一定時間（既定10分）キャッシュし、取得に失敗しても直前の値があれば
 * それを使い続ける（issue-deck側の一時的な不調で呼び出し元まで止めないため）。一度も
 * 取得できていなければ null を返すので、そこから先（環境変数へのフォールバック等）は
 * 呼び出し元の判断に委ねる。
 */

export interface SharedTokenApiConfig {
  baseUrl: string;
  secret: string;
}

/** どちらかが無ければ null（＝APIを叩きに行かない）。 */
export function readSharedTokenApiConfig(env: NodeJS.ProcessEnv = process.env): SharedTokenApiConfig | null {
  const baseUrl = (env["AIDE_ISSUE_DECK_URL"] ?? "").trim().replace(/\/+$/, "");
  const secret = (env["SHARED_TOKEN_API_SECRET"] ?? "").trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

const REQUEST_TIMEOUT_MS = 5_000;

/** 外へ出してよい粒度の理由に丸める（例外の message にはURLが載りうる）。 */
function describeFailure(cause: unknown): string {
  if (cause instanceof Response) return `HTTP ${cause.status}`;
  if (cause instanceof DOMException && cause.name === "AbortError") return "タイムアウトした";
  if (cause instanceof Error) return cause.message || cause.name;
  return "取得に失敗した";
}

/**
 * 共有トークンAPIを1回だけ叩く。キャッシュ・失敗時のフォールバックは持たない
 * （`getSharedToken()` の仕事）。
 */
export async function fetchSharedToken(
  config: SharedTokenApiConfig,
  name: string,
  consumer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/shared-tokens?name=${encodeURIComponent(name)}`, {
      headers: {
        Authorization: `Bearer ${config.secret}`,
        "X-Shared-Token-Consumer": consumer,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw response;
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || !body.value) throw new Error("応答にvalueが含まれていません");
    return body.value;
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

/** トークン名ごとのキャッシュ。サーバーは1プロセスで動くためモジュールスコープで共有する。 */
const cache = new Map<string, CacheEntry>();

export interface GetSharedTokenOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /** テスト用の時刻注入。既定は `Date.now`。 */
  now?: () => number;
}

/**
 * 共有トークンAPIから値を取得する。
 *
 * - 直近 `ttlMs`（既定10分）以内に取得済みならAPIを叩かずキャッシュを返す
 * - 取得に失敗しても、直前に取得できていた値があればそれを返す
 * - 設定が無い、または一度も取得できていなければ null（フォールバックは呼び出し元の仕事）
 */
export async function getSharedToken(
  name: string,
  consumer: string,
  options: GetSharedTokenOptions = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cached = cache.get(name);
  if (cached && now() - cached.fetchedAt < ttlMs) return cached.value;

  const config = readSharedTokenApiConfig(options.env);
  if (!config) return cached?.value ?? null;

  try {
    const value = await fetchSharedToken(config, name, consumer, options.fetchImpl ?? fetch);
    cache.set(name, { value, fetchedAt: now() });
    return value;
  } catch (cause) {
    console.warn(`[shared-tokens] ${name} の取得に失敗しました（利用元: ${consumer}, 理由: ${describeFailure(cause)}）`);
    return cached?.value ?? null;
  }
}

/** 判定APIが401を返したときなど、再発行された値を読み直すために1件だけ捨てる。 */
export function forgetSharedToken(name: string): void {
  cache.delete(name);
}

/** テスト専用。プロセス内キャッシュを空にする。 */
export function resetSharedTokenCacheForTest(): void {
  cache.clear();
}
