import type { AssetManagerSubscriptionsSnapshot } from "./types.ts";

/**
 * Asset Manager コネクタ。
 *
 * 月額固定費と次の請求日は Asset Manager が既に持っている（サブスク管理は asset-manager#491 で
 * 旧 subscription-lists から移管された）。**AIDEは持ち直さず、サーバー間参照用の読み取りAPI
 * （`GET /api/subscriptions`）を叩くだけにする。**
 *
 * 月額換算・次回請求日・契約状況・円換算は向こうが計算済みで、こちらで再実装すれば必ずズレる。
 * そのため**計算済みの値を受け取る**（相手の仕様は `docs/subscriptions.md`）。
 *
 * 認証・宛先は MCP の `asset_manager_*` ツール（取り込み・サブスクの読み書き）と同じ
 * `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET` と `AIDE_ASSET_MANAGER_URL`。**新しい環境変数・secret は要らない。**
 * `fetch` しか使わないので実行時依存も増えない。
 */

/** 本番の Asset Manager。デプロイ時は GitHub の variable（`AIDE_ASSET_MANAGER_URL`）で上書きされる。 */
export const DEFAULT_ASSET_MANAGER_URL = "https://asset.gucchii.com";

/**
 * 固定費の取得の制限時間。
 *
 * `GET /api/money/summary` の中で叩くため、相手が落ちていても残高まで返せなくならないよう切る。
 * **その `/api/money/summary` を読む Asset Manager 自身の待ち時間（10秒）より短くしておく**
 * （Asset Manager → AIDE → Asset Manager と往復するため、ここが長いと向こうが先に諦める）。
 */
const TIMEOUT_MS = 5_000;

export interface AssetManagerConfig {
  baseUrl: string;
  secret: string;
}

/**
 * 設定を読む。シークレットが無ければ null（＝401を叩きに行かない）。
 *
 * **シークレットは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readAssetManagerConfig(): AssetManagerConfig | null {
  const secret = process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
  if (!secret) return null;

  const baseUrl = process.env["AIDE_ASSET_MANAGER_URL"] || DEFAULT_ASSET_MANAGER_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがあり、URLが出ると内部の構成が漏れる。
 * HTTPステータスと例外の種別だけに落とす。
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof Response) {
    // 401（シークレット不一致）と404（相手側で対象ユーザーが決まらない）は原因が違うので、意味を添える。
    if (cause.status === 401) return "HTTP 401（シークレットが一致しない）";
    if (cause.status === 404) return "HTTP 404（Asset Manager側で対象ユーザーが見つからない）";
    return `HTTP ${cause.status}`;
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    if (cause.name === "UnexpectedResponseError") return "想定と異なる形の応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

/** 使うフィールドが揃っているかだけを確かめる。相手の仕様変更で黙って空になるのを防ぐ。 */
function isSnapshot(value: unknown): value is AssetManagerSubscriptionsSnapshot {
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const summary = body["summary"];
  return (
    typeof body["asOf"] === "string" &&
    Array.isArray(body["subscriptions"]) &&
    summary !== null &&
    typeof summary === "object" &&
    typeof (summary as Record<string, unknown>)["fixedCostMonthlyTotalJpy"] === "number"
  );
}

/**
 * 固定費の一覧を取得する。整形は行わない（`src/core/views/money.ts` の仕事）。
 *
 * 解約済み（`ENDED`）は既定で除外されるため、クエリでは指定しない。
 */
export async function fetchSubscriptions(
  config: AssetManagerConfig,
): Promise<AssetManagerSubscriptionsSnapshot> {
  const res = await fetch(`${config.baseUrl}/api/subscriptions`, {
    headers: { authorization: `Bearer ${config.secret}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
  if (!res.ok) throw res;

  const body: unknown = await res.json();
  if (!isSnapshot(body)) {
    const error = new Error("unexpected response shape");
    error.name = "UnexpectedResponseError";
    throw error;
  }
  return body;
}
