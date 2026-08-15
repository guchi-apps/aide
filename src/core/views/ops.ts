import { fetchOpsDashboard, readOpsDashboardConfig } from "../connectors/ops-dashboard/index.ts";
import type {
  OpsDashboardRaw,
  OpsHostView,
  OpsSourceFailure,
  OpsTmuxSession,
} from "../connectors/ops-dashboard/types.ts";

/**
 * 運用状況の横断ビュー。
 *
 * ホスト指標（VPS・サブPC）・外形監視・AI/GitHub/1Password の残枠を1回に畳む。
 * 情報源は ops-dashboard 1つだが、**向こうが束ねている6本のAPIを1つの答えにする**という点で
 * 横断ビューにあたる。
 *
 * 返すのは「いま異常があるか」に答えられる粒度まで。24時間分の履歴・上位プロセス・
 * tmuxセッションの名前や作業ディレクトリ・全ディスクマウントは**返さない**。
 * 生の指標をそのまま渡すと、Claudeのコンテキストを食うだけで答えは良くならない。
 *
 * **キャッシュを挟まず、呼ばれるたびに取得する。** README「取得と提供の分離」が分離を
 * 要求しているのはPlaywright巡回のような重い取得で、ここは localhost へのHTTP GETだけ。
 * かつ ops-dashboard 側が30秒間隔で更新しているため、キャッシュを挟むとジョブ間隔ぶん
 * 必ず古くなり、「いまどうなっているか」という問いに答えられなくなる。
 */

/** 逼迫の度合い。ops-dashboard の画面（SummaryTone）と同じ考え方。 */
export type OpsSeverity = "ok" | "warn" | "danger";

/**
 * しきい値。**ここだけを見れば判定基準が分かる**ようにまとめている。
 * 残枠の 15 / 35 は ops-dashboard の `remainingTone()` に合わせてある。
 */
const THRESHOLDS = {
  cpuPercent: { warn: 85, danger: 95 },
  memoryPercent: { warn: 85, danger: 95 },
  swapPercent: { warn: 25, danger: 50 },
  diskPercent: { warn: 80, danger: 90 },
  temperatureCelsius: { warn: 75, danger: 85 },
  /** 残枠は「残りが少ないほど悪い」ので向きが逆。 */
  quotaRemainingPercent: { warn: 35, danger: 15 },
} as const;

/** これを超えて活動の無い tmux セッションを「放置」とみなす。 */
const TMUX_IDLE_HOURS = 24;

export interface OpsProblem {
  severity: Exclude<OpsSeverity, "ok">;
  message: string;
}

export interface OpsTmuxSummary {
  /** 上限で切られる前の総数。 */
  total: number;
  /**
   * シェル以外のコマンドが動いているセッション数。
   * 一覧が上限で切られている場合は下限値になる。
   */
  busy: number;
  idleOver24h: number;
}

export interface OpsHostSummary {
  id: string;
  label: string;
  online: boolean;
  ageSeconds: number;
  uptimeHours: number;
  cpuPercent: number;
  memoryPercent: number;
  swapPercent: number | null;
  loadAverage1: number | null;
  temperatureCelsius: number | null;
  /** 最も逼迫しているマウントだけ。全マウントを並べても読む側の負担になるだけ。 */
  disk: { path: string; usedPercent: number } | null;
  /** `active` でない systemd サービス。 */
  failedServices: { name: string; state: string }[];
  rebootRequired: boolean;
  securityUpdatesAvailable: number | null;
  tmux: OpsTmuxSummary | null;
}

export interface OpsMonitorSummary {
  /** 一時停止中・メンテナンス中を除いた監視対象の数。 */
  total: number;
  down: string[];
  pending: number;
}

export interface OpsQuotaSummary {
  name: string;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface OpsStatus {
  checkedAt: string;
  /** ops-dashboard への接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  /** 判定できた範囲で異常が無いか。**材料を1つも取得できなかった場合も false。** */
  ok: boolean;
  severity: OpsSeverity;
  /** 全ソースを取得できたか。false なら `ok` は「見えている範囲では」の意味になる。 */
  complete: boolean;
  problems: OpsProblem[];
  hosts: OpsHostSummary[];
  monitors: OpsMonitorSummary | null;
  quotas: OpsQuotaSummary[];
  /** 取得できなかった／設定されていないソース。 */
  unavailable: OpsSourceFailure[];
  note: string;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分前`;
  return `${Math.round(seconds / 3600)}時間前`;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 上振れが悪い指標（CPU・メモリ等）の判定。 */
function highIsBad(value: number, limits: { warn: number; danger: number }): OpsSeverity {
  if (value >= limits.danger) return "danger";
  if (value >= limits.warn) return "warn";
  return "ok";
}

/** 下振れが悪い指標（残枠）の判定。 */
function lowIsBad(value: number, limits: { warn: number; danger: number }): OpsSeverity {
  if (value <= limits.danger) return "danger";
  if (value <= limits.warn) return "warn";
  return "ok";
}

function worst(severities: OpsSeverity[]): OpsSeverity {
  if (severities.includes("danger")) return "danger";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

function summarizeTmux(sessions: OpsTmuxSession[], total: number, now: Date): OpsTmuxSummary {
  const idleBefore = now.getTime() - TMUX_IDLE_HOURS * 3600_000;
  const idleOver24h = sessions.filter((session) => {
    if (!session.lastActivityAt) return false;
    const at = new Date(session.lastActivityAt).getTime();
    return Number.isFinite(at) && at < idleBefore;
  }).length;

  return {
    total,
    busy: sessions.filter((session) => session.busy === true).length,
    idleOver24h,
  };
}

function summarizeHost(host: OpsHostView, now: Date): OpsHostSummary {
  const latest = host.latest;
  // 一番逼迫しているマウントだけを見る。空配列でも落ちないように reduce ではなく sort + [0]。
  const disk = [...latest.disks].sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? null;
  const sessions = latest.tmuxSessions;

  return {
    id: host.id,
    label: host.label,
    online: host.online,
    ageSeconds: Math.round(host.ageSeconds),
    uptimeHours: Math.round(latest.uptimeSeconds / 3600),
    cpuPercent: round1(latest.cpuPercent),
    memoryPercent: round1(latest.memory.usedPercent),
    swapPercent: latest.swap ? round1(latest.swap.usedPercent) : null,
    loadAverage1: latest.loadAverage[0] ?? null,
    temperatureCelsius: latest.temperatureCelsius ?? null,
    disk: disk ? { path: disk.path, usedPercent: round1(disk.usedPercent) } : null,
    failedServices: latest.services
      .filter((service) => !service.active)
      .map(({ name, state }) => ({ name, state })),
    rebootRequired: latest.maintenance?.rebootRequired ?? false,
    securityUpdatesAvailable: latest.maintenance?.securityUpdatesAvailable ?? null,
    tmux: sessions
      ? summarizeTmux(sessions, latest.tmuxSessionTotal ?? sessions.length, now)
      : null,
  };
}

/**
 * ホスト1台ぶんの異常を洗い出す。
 *
 * **オフラインのホストでは指標を見ない。** 最後に受け取った値をそのまま評価すると、
 * 落ちる直前のCPU100%を「いま高負荷」として報告してしまう。
 */
function hostProblems(host: OpsHostSummary): OpsProblem[] {
  if (!host.online) {
    return [
      {
        severity: "danger",
        message: `${host.label} が応答なし（最終受信 ${formatAge(host.ageSeconds)}）`,
      },
    ];
  }

  const problems: OpsProblem[] = [];
  const add = (severity: OpsSeverity, message: string): void => {
    if (severity !== "ok") problems.push({ severity, message });
  };

  add(
    highIsBad(host.cpuPercent, THRESHOLDS.cpuPercent),
    `${host.label} のCPU使用率が ${host.cpuPercent}%`,
  );
  add(
    highIsBad(host.memoryPercent, THRESHOLDS.memoryPercent),
    `${host.label} のメモリ使用率が ${host.memoryPercent}%`,
  );
  if (host.swapPercent !== null) {
    add(
      highIsBad(host.swapPercent, THRESHOLDS.swapPercent),
      `${host.label} のSwap使用率が ${host.swapPercent}%`,
    );
  }
  if (host.disk) {
    add(
      highIsBad(host.disk.usedPercent, THRESHOLDS.diskPercent),
      `${host.label} の ${host.disk.path} が ${host.disk.usedPercent}%`,
    );
  }
  if (host.temperatureCelsius !== null) {
    add(
      highIsBad(host.temperatureCelsius, THRESHOLDS.temperatureCelsius),
      `${host.label} の温度が ${host.temperatureCelsius}℃`,
    );
  }

  for (const service of host.failedServices) {
    problems.push({ severity: "danger", message: `${host.label}: ${service.name} が ${service.state}` });
  }
  if (host.rebootRequired) {
    problems.push({ severity: "warn", message: `${host.label} は再起動待ち` });
  }
  if (host.tmux && host.tmux.idleOver24h > 0) {
    problems.push({
      severity: "warn",
      message: `${host.label} に ${TMUX_IDLE_HOURS}時間以上 放置の tmux セッションが ${host.tmux.idleOver24h}件`,
    });
  }

  return problems;
}

function summarizeMonitors(raw: OpsDashboardRaw): OpsMonitorSummary | null {
  const kuma = raw.kumaMonitors;
  const robot = raw.robotMonitors;
  if (!kuma && !robot) return null;

  // メンテナンス中（Kuma）と一時停止中（UptimeRobot の 0）は意図して止めているので数に入れない。
  const kumaActive = (kuma ?? []).filter((monitor) => monitor.status !== "maintenance");
  const robotActive = (robot ?? []).filter((monitor) => monitor.status !== 0);

  return {
    total: kumaActive.length + robotActive.length,
    down: [
      ...kumaActive.filter((m) => m.status === "down").map((m) => m.name),
      // UptimeRobot は 8（応答なし）・9（停止）を停止として扱う。
      ...robotActive.filter((m) => m.status >= 8).map((m) => m.friendly_name),
    ],
    // Kuma の pending と UptimeRobot の 1（未チェック）はどちらも「まだ判定できていない」。
    pending:
      kumaActive.filter((m) => m.status === "pending").length +
      robotActive.filter((m) => m.status === 1).length,
  };
}

const ONE_PASSWORD_TYPE_LABEL = { token: "トークン1時間枠", account: "アカウント24時間枠" } as const;
const ONE_PASSWORD_ACTION_LABEL = { read: "読み取り", write: "書き込み", read_write: "読み書き" } as const;

/**
 * 残枠を集める。
 *
 * 未設定（`unconfigured`）は障害ではなく設定の状態なので、`unavailable` に理由付きで残しつつ
 * 「取得できなかった」とは区別する（`complete` には影響させない）。
 */
function summarizeQuotas(raw: OpsDashboardRaw): {
  quotas: OpsQuotaSummary[];
  notConfigured: OpsSourceFailure[];
} {
  const quotas: OpsQuotaSummary[] = [];
  const notConfigured: OpsSourceFailure[] = [];

  for (const provider of raw.aiUsage?.providers ?? []) {
    if (provider.status !== "ok") {
      notConfigured.push({
        source: `ai-usage:${provider.name}`,
        reason: provider.status === "unconfigured" ? "未設定" : "取得に失敗した",
      });
      continue;
    }
    for (const window of provider.windows) {
      quotas.push({
        name: `${provider.name} ${window.label}${window.note ? `（${window.note}）` : ""}`,
        remainingPercent: Math.max(0, Math.round(100 - window.usedPercent)),
        resetsAt: window.resetsAt,
      });
    }
  }

  const github = raw.githubUsage;
  if (github) {
    if (github.status !== "ok" || !github.actions) {
      notConfigured.push({
        source: "github-usage",
        reason: github.status === "unconfigured" ? "未設定" : "取得に失敗した",
      });
    } else if (github.actions.allowanceLimitMinutes > 0) {
      const used = (github.actions.allowanceMinutes / github.actions.allowanceLimitMinutes) * 100;
      quotas.push({
        name: "GitHub Actions 無料枠",
        remainingPercent: Math.max(0, Math.round(100 - used)),
        resetsAt: github.actions.resetsAt,
      });
    }
  }

  const onePassword = raw.onePasswordUsage;
  if (onePassword) {
    if (onePassword.status !== "ok") {
      notConfigured.push({
        source: "onepassword-usage",
        reason: onePassword.status === "unconfigured" ? "未設定" : "取得に失敗した",
      });
    } else {
      for (const limit of onePassword.limits) {
        if (limit.limit <= 0) continue;
        quotas.push({
          name: `1Password ${ONE_PASSWORD_TYPE_LABEL[limit.type]}（${ONE_PASSWORD_ACTION_LABEL[limit.action]}）`,
          remainingPercent: Math.max(0, Math.round((limit.remaining / limit.limit) * 100)),
          resetsAt: null,
        });
      }
    }
  }

  return { quotas, notConfigured };
}

/**
 * 取得結果を「いま異常があるか」の粒度へ畳む。**純粋関数。テストはここに集中する。**
 *
 * `now` を引数で受けるのは、放置セッションの判定に現在時刻が要るため。
 */
export function summarizeOps(raw: OpsDashboardRaw, now: Date): OpsStatus {
  const hosts = (raw.hostStats?.hosts ?? []).map((host) => summarizeHost(host, now));
  const monitors = summarizeMonitors(raw);
  const { quotas, notConfigured } = summarizeQuotas(raw);

  const problems: OpsProblem[] = hosts.flatMap(hostProblems);

  if (monitors) {
    if (monitors.down.length > 0) {
      problems.push({ severity: "danger", message: `外形監視が停止: ${monitors.down.join("・")}` });
    }
    if (monitors.pending > 0) {
      problems.push({ severity: "warn", message: `確認中の外形監視が ${monitors.pending}件` });
    }
  }

  for (const quota of quotas) {
    const severity = lowIsBad(quota.remainingPercent, THRESHOLDS.quotaRemainingPercent);
    if (severity !== "ok") {
      problems.push({ severity, message: `${quota.name} の残りが ${quota.remainingPercent}%` });
    }
  }

  const unavailable = [...raw.failures, ...notConfigured];
  // complete が見ているのは「取得に失敗したか」だけ。未設定は安定した既知の状態であり、
  // 取れなかったことにはしない。
  const complete = raw.failures.length === 0;

  const notes = [
    "ops-dashboard が集約している値をそのまま読んでいる。AIDE側では収集も保存もしていない。",
  ];
  if (!complete) {
    notes.push("一部のソースを取得できなかったため、異常なしと判定した範囲は限定的。");
  }
  if (hosts.length === 0) {
    notes.push("ホストの指標を1件も取得できていない。");
  }
  if (hosts.some((host) => !host.online)) {
    // 落ちる直前のCPU100%を「いまの値」として読ませないための断り書き。
    // problems 側では評価していないが、hosts には最後の値がそのまま残る。
    notes.push("online が false のホストの指標は最後に受信した時点の値で、現在の値ではない。");
  }

  // 何ひとつ取得できていないときに `ok: true` を返すと「異常なし」と読まれる。
  // 判定の材料が1つも無い状態は「異常が無い」ではないので、区別する。
  const judged = hosts.length > 0 || monitors !== null || quotas.length > 0;

  return {
    checkedAt: now.toISOString(),
    configured: true,
    ok: judged && problems.length === 0,
    severity: worst([...problems.map((p) => p.severity), complete ? "ok" : "warn"]),
    complete,
    problems,
    hosts,
    monitors,
    quotas,
    unavailable,
    note: notes.join(" "),
  };
}

/** ops-dashboard への接続が設定されていないときの答え。 */
function notConfiguredStatus(now: Date): OpsStatus {
  return {
    checkedAt: now.toISOString(),
    configured: false,
    ok: false,
    severity: "warn",
    complete: false,
    problems: [],
    hosts: [],
    monitors: null,
    quotas: [],
    unavailable: [{ source: "ops-dashboard", reason: "接続が設定されていない" }],
    note:
      "AIDE_OPS_DASHBOARD_TOKEN が設定されていないため、稼働状況を取得できない。" +
      "設定するまでこのツールは何も答えられない（異常が無いという意味ではない）。",
  };
}

/** MCPツールから呼ばれる入口。設定を読み、取得し、畳む。 */
export async function buildOpsStatus(): Promise<OpsStatus> {
  const now = new Date();
  const config = readOpsDashboardConfig();
  if (!config) return notConfiguredStatus(now);

  return summarizeOps(await fetchOpsDashboard(config), now);
}
