import { forgetSharedToken, getSharedToken } from "../core/connectors/issue-deck/shared-tokens.ts";

/**
 * 画面を開いてよい人かの判定。StatusHubの共通アクセス設定（判定API）が正本。
 *
 * 契約は guchi-apps/status-hub の `docs/access-control.md`。要点:
 * - `POST /api/access/v1/decision` にアプリ別トークン（Bearer）と、**サーバーが検証した**
 *   `sub`・メール・`emailVerified` だけを送る
 * - 結果は `ttlSeconds` だけ使い回し、取得できないときは直前の判定を `maxStaleSeconds` まで使う。
 *   超えたら拒否し、一度も判定できていない利用者は拒否する（許可は広げない）
 * - 5分以内ごとにハートビート（`subject` 無し）を送り、適用中の版を `appliedVersion` で申告する
 *
 * **旧環境変数（許可メールの一覧）は判定にもフォールバックにも使わない。** 判定APIが使えないときに
 * 旧リストで通すと、StatusHubで取り消した利用者が通ってしまう。
 */

export interface AccessSubject {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  permissions: string[];
}

interface DecisionResponse {
  appVersion: number;
  ttlSeconds: number;
  maxStaleSeconds: number;
  decision: AccessDecision | null;
}

interface DecisionRequest {
  appliedVersion?: number;
  subject?: AccessSubject;
}

export type AccessFetcher = (body: DecisionRequest) => Promise<DecisionResponse>;

const TOKEN_NAME = "AIDE_ACCESS_APP_TOKEN";
const TOKEN_CONSUMER = "ACCESS_APP_TOKEN";
/** StatusHubの本番オリジン。 */
const DEFAULT_ACCESS_API_URL = "https://admin.gucchii.com";
const REQUEST_TIMEOUT_MS = 5_000;
/** 契約は「5分以内に1回」。余裕を持って4分ごとに送る。 */
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
/** 判定の保持が際限なく増えないようにする上限。1人用の画面なので十分に大きい。 */
const MAX_CACHE_ENTRIES = 200;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 応答の形を確かめる。形が違うものは失敗として扱い、判定には使わない。 */
export function parseAccessResponse(raw: unknown, expectDecision: boolean): DecisionResponse {
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new Error("応答がオブジェクトではない");
  const { appVersion, ttlSeconds, maxStaleSeconds } = body;
  if (typeof appVersion !== "number" || !Number.isSafeInteger(appVersion) || appVersion < 0) {
    throw new Error("appVersion が不正");
  }
  if (!isPositiveNumber(ttlSeconds) || !isPositiveNumber(maxStaleSeconds)) {
    throw new Error("ttlSeconds / maxStaleSeconds が不正");
  }

  const rawDecision = body["decision"] as Record<string, unknown> | null | undefined;
  if (!expectDecision) {
    return { appVersion, ttlSeconds, maxStaleSeconds, decision: null };
  }
  if (!rawDecision || typeof rawDecision["allowed"] !== "boolean") throw new Error("decision が不正");
  const permissions = Array.isArray(rawDecision["permissions"])
    ? rawDecision["permissions"].filter((value): value is string => typeof value === "string")
    : [];
  return {
    appVersion,
    ttlSeconds,
    maxStaleSeconds,
    decision: { allowed: rawDecision["allowed"], permissions },
  };
}

async function post(baseUrl: string, token: string, body: DecisionRequest): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}/api/access/v1/decision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * StatusHubの判定APIを呼ぶ。トークンは管理画面の「トークン発行」が issue-deck の共有トークン
 * `AIDE_ACCESS_APP_TOKEN` へ書き込んだもので、無ければ通信せず失敗にする
 * （＝一度も判定できないので全員拒否。未設定が「誰でも通す」に化けない）。
 * 再発行で古いトークンは即失効するため、401ならキャッシュを捨てて読み直し、1回だけ再試行する。
 * トークンの値はログへ出さない。
 */
export const defaultFetcher: AccessFetcher = async (body) => {
  const baseUrl = DEFAULT_ACCESS_API_URL;
  const token = await getSharedToken(TOKEN_NAME, TOKEN_CONSUMER);
  if (!token) throw new Error(`${TOKEN_NAME} が取得できない`);

  let response = await post(baseUrl, token, body);
  if (response.status === 401) {
    forgetSharedToken(TOKEN_NAME);
    const renewed = await getSharedToken(TOKEN_NAME, TOKEN_CONSUMER);
    if (renewed && renewed !== token) response = await post(baseUrl, renewed, body);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseAccessResponse(await response.json(), body.subject !== undefined);
};

interface CachedDecision {
  decision: AccessDecision;
  fetchedAt: number;
  ttlMs: number;
  maxStaleMs: number;
}

const DENIED: AccessDecision = { allowed: false, permissions: [] };

export interface AccessClient {
  decide(subject: AccessSubject): Promise<AccessDecision>;
  heartbeat(): Promise<boolean>;
}

export function createAccessClient(
  fetcher: AccessFetcher = defaultFetcher,
  now: () => number = Date.now,
  onError: (cause: unknown) => void = () => {},
): AccessClient {
  const cache = new Map<string, CachedDecision>();
  let appliedVersion: number | undefined;
  /** 同じ利用者への同時の問い合わせを1回にまとめる。 */
  const inflight = new Map<string, Promise<AccessDecision>>();

  function remember(key: string, entry: CachedDecision): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function refresh(subject: AccessSubject, key: string): Promise<AccessDecision> {
    try {
      const response = await fetcher({
        ...(appliedVersion !== undefined ? { appliedVersion } : {}),
        subject,
      });
      appliedVersion = response.appVersion;
      const decision = response.decision ?? DENIED;
      remember(key, {
        decision,
        fetchedAt: now(),
        ttlMs: response.ttlSeconds * 1000,
        maxStaleMs: response.maxStaleSeconds * 1000,
      });
      return decision;
    } catch (cause) {
      onError(cause);
      // 取得できないときだけ、直前の判定を上限の範囲で使う。超えたら・一度も無ければ拒否。
      const previous = cache.get(key);
      if (previous && now() - previous.fetchedAt < previous.maxStaleMs) return previous.decision;
      return DENIED;
    }
  }

  return {
    async decide(subject) {
      // ブラウザの申告ではなくサーバーが検証した値だけが来る前提。確認済みでなければ問い合わせない。
      if (!subject.sub || !subject.email || !subject.emailVerified) return DENIED;

      const key = `${subject.sub}:${subject.email.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && now() - cached.fetchedAt < cached.ttlMs) return cached.decision;

      const pending = inflight.get(key);
      if (pending) return pending;
      const request = refresh(subject, key).finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },

    async heartbeat() {
      try {
        const response = await fetcher({ ...(appliedVersion !== undefined ? { appliedVersion } : {}) });
        appliedVersion = response.appVersion;
        return true;
      } catch (cause) {
        onError(cause);
        return false;
      }
    },
  };
}

let shared: AccessClient | null = null;

function client(): AccessClient {
  shared ??= createAccessClient(defaultFetcher, Date.now, (cause) => {
    console.warn("[access] アクセス判定の取得に失敗:", cause instanceof Error ? cause.message : "unknown");
  });
  return shared;
}

/** この利用者に画面を開かせてよいか。判定できなければ拒否。 */
export async function isAllowedSubject(subject: AccessSubject | null): Promise<boolean> {
  if (!subject) return false;
  return (await client().decide(subject)).allowed;
}

/** 起動時に1回送り、以後は5分以内ごとに送る。タイマーはプロセスの終了を妨げない。 */
export function startAccessHeartbeat(): void {
  void client().heartbeat();
  setInterval(() => void client().heartbeat(), HEARTBEAT_INTERVAL_MS).unref();
}
