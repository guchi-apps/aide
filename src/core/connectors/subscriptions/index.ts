import type { SubscriptionsSnapshot } from "./types.ts";

/**
 * subscription-lists コネクタ。
 *
 * 月額固定費と次の支払予定は subscription-lists が既に持っている。**AIDEは持ち直さず、
 * サーバー間参照用の読み取りAPI（`GET /api/internal/subscriptions`）を叩くだけにする。**
 *
 * 月末クランプ（`billingDay=31` の2月）・料金改定履歴の期間切り替え・請求サイクルの判定は
 * 向こうの `src/lib/billing.ts` にあり、こちらで再実装すれば必ずズレる。そのため
 * **月額換算と次回支払日は計算済みの値を受け取る**（相手の仕様は `docs/internal-api.md`）。
 *
 * 両方とも同じVPS上で動くため localhost 経由で届き、相手を外部公開する必要がない。
 * `fetch` しか使わないので実行時依存も増えない。ops-dashboard コネクタと同じ形。
 */

/** subscription-lists は同じVPS上のPM2プロセス（ポート3107）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:3107";

/**
 * 1本あたりの制限時間。
 * MCPの同期リクエストの中で叩くため、相手が落ちていてもツールが固まらないよう短く切る。
 * localhost で数ミリ秒で返るものなので、3秒は十分な余裕にあたる。
 */
const TIMEOUT_MS = 3_000;

export interface SubscriptionsConfig {
  baseUrl: string;
  token: string;
}

/**
 * 設定を読む。トークンが無ければ null（＝401を叩きに行かない）。
 *
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readSubscriptionsConfig(): SubscriptionsConfig | null {
  const token = process.env["AIDE_SUBSCRIPTIONS_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_SUBSCRIPTIONS_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/**
 * 日本時間での `YYYY-MM-DD`。
 *
 * **VPSのタイムゾーンはUTC。** 基準日を渡さないと相手はサーバー時刻で計算するため、
 * 日本時間の 00:00〜09:00 は前日を基準にした月額・次回支払日が返る。
 * `Intl` は標準で使えるので、これだけのために日付ライブラリを足さない。
 */
export function tokyoDate(now: Date): string {
  // en-CA は YYYY-MM-DD 形式。
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがあり、URLが出ると内部の構成が漏れる。
 * HTTPステータスと例外の種別だけに落とす。
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof Response) {
    // 401（キー不一致）と503（相手側が未設定）は原因が違うので、意味を添える。
    if (cause.status === 401) return "HTTP 401（トークンが一致しない）";
    if (cause.status === 503) return "HTTP 503（相手側でAPIキーが未設定）";
    return `HTTP ${cause.status}`;
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

/**
 * 固定費の一覧を取得する。整形は行わない（`src/core/views/money.ts` の仕事）。
 *
 * 解約済み（`ENDED`）は既定で除外されるため、クエリでは指定しない。
 */
export async function fetchSubscriptions(
  config: SubscriptionsConfig,
  referenceDate: string,
): Promise<SubscriptionsSnapshot> {
  const url = `${config.baseUrl}/api/internal/subscriptions?referenceDate=${encodeURIComponent(referenceDate)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
  if (!res.ok) throw res;
  return (await res.json()) as SubscriptionsSnapshot;
}
