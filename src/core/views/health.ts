import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAuthSummary, type AuthSummary } from "../../auth/store.ts";
import { JOB_CATALOG, type JobInfo } from "../../worker/jobs/catalog.ts";
import { jobRecordKey, type JobRecord } from "../../worker/record.ts";
import { ZAIM_CACHE_KEY } from "../../worker/jobs/zaim-sync.ts";
import { readCache, type CachedValue } from "../cache/store.ts";
import { REPO_ROOT } from "../paths.ts";
import { readGitHubConfig } from "../connectors/github/index.ts";
import { readOpsDashboardConfig } from "../connectors/ops-dashboard/index.ts";
import { readSubscriptionsConfig } from "../connectors/subscriptions/index.ts";
import { findStaleZaimAccounts } from "../connectors/zaim/parse.ts";
import type { ZaimSnapshot } from "../connectors/zaim/types.ts";
import { STALE_AFTER_MINUTES } from "./money.ts";

/**
 * AIDE自身の動作状況の横断ビュー。
 *
 * 他の横断ビュー（`money` / `ops` / `dev`）が**外の世界**を畳むのに対し、ここは
 * **AIDE自身**が正しく動いているかを畳む。「Zaimの残高がいくらか」ではなく
 * 「巡回が動いているか・キャッシュが古くないか・接続先の設定が残っているか」に答える。
 *
 * 材料はすべて手元にあるもので、**この関数は外部サービスへ問い合わせない**。
 * ページを開くたびに GitHub や ops-dashboard を叩くと、相手が落ちているだけで画面が
 * 開かなくなる。疎通の確認は利用者が押したときだけ走らせる（`src/web/status.ts`）。
 *
 * 判定の基準はここに集める。表示側（`src/web/status.ts`）は色と並べ方だけを決める。
 */

export type HealthSeverity = "ok" | "warn" | "danger" | "unknown";

export interface HealthAttention {
  severity: "warn" | "danger";
  message: string;
  /** 何をすれば直るか。分かる場合だけ。 */
  action?: string;
}

export interface HealthServer {
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  startedAt: string;
  /** パスワード認証が有効か。**無効なら誰でも実データを読める状態にある。** */
  authEnabled: boolean;
  baseUrl: string;
  mcpUrl: string;
}

export interface HealthJob extends JobInfo {
  severity: HealthSeverity;
  /** 最後に実行した記録。まだ1件も無ければ null。 */
  lastRun: {
    ok: boolean;
    /** 記録が書かれた時刻（＝実行の終了時刻）。 */
    at: string;
    ageMinutes: number;
    seconds: number;
    message: string;
    host: string;
  } | null;
}

export interface HealthCache {
  key: string;
  /** まだ一度も取得していなければ true。 */
  empty: boolean;
  fetchedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  balances: number;
  holdings: number;
  /** Zaim側の最終更新が当日でない連携口座の名前。 */
  staleAccounts: string[];
  severity: HealthSeverity;
}

export interface HealthConnector {
  key: string;
  label: string;
  configured: boolean;
  /** この画面から疎通を確認できるか。false の理由は `note` に書く。 */
  probeable: boolean;
  note: string;
}

export interface Health {
  checkedAt: string;
  severity: HealthSeverity;
  attention: HealthAttention[];
  server: HealthServer;
  jobs: HealthJob[];
  cache: HealthCache;
  connectors: HealthConnector[];
  mcp: AuthSummary;
}

/** 悪いほうを採る。`unknown`（材料が無い）は判定に影響させない。 */
export function worst(severities: HealthSeverity[]): HealthSeverity {
  if (severities.includes("danger")) return "danger";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間${minutes % 60}分`;
  return `${Math.floor(hours / 24)}日${hours % 24}時間`;
}

/**
 * ジョブ1つぶんの判定。**純粋関数。テストはここに当てる。**
 *
 * 記録が無い状態を「異常」にしない。デプロイ直後や、そのジョブをまだ一度も動かして
 * いない環境では記録が無いのが正しく、異常として出すと本物の失敗が埋もれる。
 */
export function summarizeJob(info: JobInfo, cached: CachedValue<JobRecord> | null): HealthJob {
  if (!cached) return { ...info, severity: "unknown", lastRun: null };

  const record = cached.data;
  const lastRun = {
    ok: record.ok,
    at: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    seconds: record.seconds,
    message: record.message,
    host: record.host,
  };

  if (!record.ok) return { ...info, severity: "danger", lastRun };
  // 成功しているのに間隔ぶん動いていない＝スケジューラ側が止まっている疑い。
  // ジョブ自身は何も報告しないため、この経路でしか気づけない。
  const severity = cached.ageMinutes > info.staleAfterMinutes ? "warn" : "ok";
  return { ...info, severity, lastRun };
}

function jobAttention(job: HealthJob): HealthAttention[] {
  if (!job.lastRun) return [];

  if (!job.lastRun.ok) {
    return [
      {
        severity: "danger",
        message: `${job.name} が失敗しています（${job.lastRun.message}）`,
        action: "サブPCで systemctl status aide-" + job.name + ".service を見る",
      },
    ];
  }
  if (job.severity === "warn") {
    return [
      {
        severity: "warn",
        message: `${job.name} が ${formatDuration(job.lastRun.ageMinutes)} 実行されていません（想定は${job.interval}）`,
        action: "サブPCで systemd timer が有効か確認する",
      },
    ];
  }
  return [];
}

/** キャッシュ（Zaim巡回の結果）の判定。**純粋関数。** */
export function summarizeCache(
  cached: CachedValue<ZaimSnapshot> | null,
  now: Date,
): HealthCache {
  if (!cached) {
    return {
      key: ZAIM_CACHE_KEY,
      empty: true,
      fetchedAt: null,
      ageMinutes: null,
      stale: false,
      balances: 0,
      holdings: 0,
      staleAccounts: [],
      severity: "unknown",
    };
  }

  const stale = cached.ageMinutes > STALE_AFTER_MINUTES;
  const staleAccounts = findStaleZaimAccounts(cached.data.onlineAccounts ?? [], now).map(
    (account) => account.name,
  );

  return {
    key: ZAIM_CACHE_KEY,
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    balances: cached.data.balances.length,
    holdings: cached.data.holdings.length,
    staleAccounts,
    // 更新できない口座があるのは Zaim 側の連携設定の問題で、AIDEの障害ではない。
    // 気づけるように出すが、鮮度切れ（巡回が届いていない）より軽く扱う。
    severity: stale ? "warn" : staleAccounts.length > 0 ? "warn" : "ok",
  };
}

/**
 * 接続先の設定状況。**トークンの値は読まず、設定されているかどうかだけを見る。**
 *
 * 本番の `.env` はデプロイのたびに丸ごと上書きされるため、配線を1か所落とすと
 * 静かに「未設定」へ戻る（#55）。それに気づける場所がこれまで無かった。
 */
export function readConnectors(): HealthConnector[] {
  return [
    {
      key: "ops-dashboard",
      label: "ops-dashboard",
      configured: readOpsDashboardConfig() !== null,
      probeable: true,
      note: "VPS・サブPCの稼働状況の取得元（aide_ops_status）。",
    },
    {
      key: "github",
      label: "GitHub",
      configured: readGitHubConfig() !== null,
      probeable: true,
      note: "開発状況の取得元（aide_dev_status）。",
    },
    {
      key: "subscription-lists",
      label: "subscription-lists",
      configured: readSubscriptionsConfig() !== null,
      probeable: true,
      note: "月額固定費の取得元（aide_money_summary の固定費）。",
    },
    {
      key: "zaim",
      label: "Zaim（自動再ログイン）",
      configured: Boolean(process.env["ZAIM_EMAIL"] && process.env["ZAIM_PASSWORD"]),
      probeable: false,
      note: "巡回は worker が担当する。ログインは重く、この画面からは触らない。",
    },
    {
      key: "signaly",
      label: "Signaly（通知）",
      configured: Boolean(process.env["AIDE_SIGNALY_WEBHOOK_URL"]?.trim()),
      probeable: false,
      note: "ジョブの失敗と復旧の通知先。送信専用で、確認のために送らない。",
    },
  ];
}

/**
 * 未設定の接続先は**1件にまとめる。** 1つずつ並べると、同じ対応方法の行が接続先の数だけ
 * 続き、他の注意（ジョブの失敗など）が押し出される。
 */
function connectorAttention(connectors: HealthConnector[]): HealthAttention[] {
  const missing = connectors.filter((connector) => !connector.configured);
  if (missing.length === 0) return [];
  return [
    {
      severity: "warn",
      message: `接続先の設定がありません: ${missing.map((connector) => connector.label).join("・")}`,
      action:
        "本番の .env は deploy.yml が毎回上書きする。5か所すべてに通っているか確認する（README「環境変数の配線」）",
    },
  ];
}

/** package.json のバージョン。読めなければ空文字（表示側で「不明」にする）。 */
async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
}

export interface HealthInput {
  /** 起動時に決まった認証の有効・無効。ここで読み直すと未設定時に例外になる。 */
  authEnabled: boolean;
  baseUrl: string;
  now?: Date;
}

/** 画面から呼ばれる入口。手元の材料を集めて畳む。 */
export async function buildHealth(input: HealthInput): Promise<Health> {
  const now = input.now ?? new Date();

  const [version, jobRecords, zaimCache, mcp] = await Promise.all([
    readVersion(),
    Promise.all(JOB_CATALOG.map((job) => readCache<JobRecord>(jobRecordKey(job.name)))),
    readCache<ZaimSnapshot>(ZAIM_CACHE_KEY),
    readAuthSummary(),
  ]);

  const jobs = JOB_CATALOG.map((job, index) => summarizeJob(job, jobRecords[index] ?? null));
  const cache = summarizeCache(zaimCache, now);
  const connectors = readConnectors();

  const attention: HealthAttention[] = [
    ...jobs.flatMap(jobAttention),
    ...connectorAttention(connectors),
  ];

  if (!input.authEnabled) {
    attention.unshift({
      severity: "danger",
      message: "パスワード認証が無効です（AIDE_AUTH_DISABLED=1）",
      action: "公開されている場合は今すぐ AIDE_AUTH_PASSWORD を設定して再起動する",
    });
  }
  if (cache.stale) {
    attention.push({
      severity: "warn",
      message: `残高のキャッシュが ${formatDuration(cache.ageMinutes ?? 0)} 前のものです`,
      action: "zaim-sync が動いているか確認する",
    });
  }
  if (cache.staleAccounts.length > 0) {
    attention.push({
      severity: "warn",
      message: `Zaim側で当日更新されていない連携口座が ${cache.staleAccounts.length}件（${cache.staleAccounts.join("・")}）`,
      action: "Zaimの「口座の連携」から設定を直す。AIDE側では直せない",
    });
  }

  return {
    checkedAt: now.toISOString(),
    severity: worst([
      ...attention.map((item) => item.severity),
      ...jobs.map((job) => job.severity),
      cache.severity,
    ]),
    attention,
    server: {
      version,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(now.getTime() - process.uptime() * 1000).toISOString(),
      authEnabled: input.authEnabled,
      baseUrl: input.baseUrl,
      mcpUrl: `${input.baseUrl}/mcp`,
    },
    jobs,
    cache,
    connectors,
    mcp,
  };
}
