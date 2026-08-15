import type {
  OpsAiUsage,
  OpsDashboardRaw,
  OpsGitHubUsage,
  OpsHostStatsView,
  OpsKumaMonitor,
  OpsOnePasswordUsage,
  OpsRobotMonitor,
  OpsSourceFailure,
} from "./types.ts";

/**
 * ops-dashboard コネクタ。
 *
 * VPS・サブPCの稼働状況は ops-dashboard が既に集約している（ホスト指標・外形監視・
 * AI/GitHub/1Password の残枠）。**AIDEは集め直さず、その読み取りAPIを叩くだけにする。**
 *
 * 両方とも同じVPS上で動くため localhost 経由で届き、相手を外部公開する必要がない。
 * `fetch` しか使わないので実行時依存も増えない。方式は aide#27 と同じ。
 *
 * ops-dashboard 側の読み取りAPIは元々ログインセッション必須で、サーバー間用の
 * トークン認証は guchi-apps/ops-dashboard#85 で追加する。それが入るまで、ここは
 * 401 を受けて「取得できなかった」を返す。
 */

/** ops-dashboard は同じVPS上のPM2プロセス（ポート3110）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:3110";

/**
 * 1本あたりの制限時間。
 * MCPの同期リクエストの中で叩くため、ops-dashboard が落ちていてもツールが固まらないよう
 * 短く切る。localhost で数ミリ秒で返るものなので、3秒は十分な余裕にあたる。
 */
const TIMEOUT_MS = 3_000;

export interface OpsDashboardConfig {
  baseUrl: string;
  token: string;
}

/**
 * 設定を読む。トークンが無ければ null（＝401を叩きに行かない）。
 *
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readOpsDashboardConfig(): OpsDashboardConfig | null {
  const token = process.env["AIDE_OPS_DASHBOARD_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_OPS_DASHBOARD_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがあり、URLが出ると内部の構成が漏れる。
 * HTTPステータスと例外の種別だけに落とす。
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof Response) return `HTTP ${cause.status}`;
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

async function getJson<T>(config: OpsDashboardConfig, path: string): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
  if (!res.ok) throw res;
  return (await res.json()) as T;
}

/**
 * 1ソース分の取得。**失敗しても他のソースを巻き込まない。**
 * ops-dashboard の6本のうち1本だけ落ちるケース（1Password CLIが無い等）は普通に起きるため、
 * 全体を失敗させると「他は正常だった」という情報まで失う。
 */
async function collect<T>(
  source: string,
  load: () => Promise<T>,
  failures: OpsSourceFailure[],
): Promise<T | null> {
  try {
    return await load();
  } catch (cause) {
    failures.push({ source, reason: describeFailure(cause) });
    return null;
  }
}

/**
 * ops-dashboard の読み取りAPIをまとめて叩く。整形は行わない（`src/core/views/ops.ts` の仕事）。
 *
 * 6本を並行に叩く。直列にすると最悪で TIMEOUT_MS × 6 かかる。
 */
export async function fetchOpsDashboard(config: OpsDashboardConfig): Promise<OpsDashboardRaw> {
  const failures: OpsSourceFailure[] = [];

  const [hostStats, kumaMonitors, robotMonitors, aiUsage, githubUsage, onePasswordUsage] =
    await Promise.all([
      collect("host-stats", () => getJson<OpsHostStatsView>(config, "/api/host-stats"), failures),
      collect(
        "uptime-kuma",
        async () =>
          (await getJson<{ monitors: OpsKumaMonitor[] }>(config, "/api/uptime-kuma")).monitors,
        failures,
      ),
      collect(
        "uptimerobot",
        async () =>
          (await getJson<{ monitors: OpsRobotMonitor[] }>(config, "/api/monitors")).monitors,
        failures,
      ),
      collect("ai-usage", () => getJson<OpsAiUsage>(config, "/api/ai-usage"), failures),
      collect("github-usage", () => getJson<OpsGitHubUsage>(config, "/api/github-usage"), failures),
      collect(
        "onepassword-usage",
        () => getJson<OpsOnePasswordUsage>(config, "/api/onepassword-usage"),
        failures,
      ),
    ]);

  return {
    hostStats,
    kumaMonitors,
    robotMonitors,
    aiUsage,
    githubUsage,
    onePasswordUsage,
    failures,
  };
}
