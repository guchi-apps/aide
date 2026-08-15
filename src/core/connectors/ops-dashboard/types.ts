/**
 * ops-dashboard のレスポンスのうち、AIDEが実際に使うフィールドだけを再宣言したもの。
 *
 * 別リポジトリなので型をimportできない、というだけの理由ではない。**使う範囲を明示的に
 * 絞ること自体が目的**で、向こうが画面都合でフィールドを足しても、ここに書いていない限り
 * AIDEは影響を受けない。逆に、ここに書いたフィールドが消えたら型ではなく実行時に
 * `undefined` として現れるため、扱いは常に「無いかもしれない」前提で書く。
 *
 * 正本は ops-dashboard の `src/types/host-stats.ts` ほか。
 */

/** 使用量（メモリ・Swap・ディスク共通） */
export interface OpsUsage {
  usedBytes: number;
  totalBytes: number;
  usedPercent: number;
}

export interface OpsDisk extends OpsUsage {
  path: string;
}

export interface OpsService {
  name: string;
  /** systemctl is-active の出力（active / inactive / failed など） */
  state: string;
  active: boolean;
}

export interface OpsMaintenance {
  rebootRequired: boolean;
  updatesAvailable?: number;
  securityUpdatesAvailable?: number;
}

export interface OpsTmuxSession {
  name: string;
  attached: boolean;
  /** シェル以外のコマンドが動いているか。送らない世代のエージェントでは undefined */
  busy?: boolean;
  /** セッション内で最後に活動があった時刻（ISO8601） */
  lastActivityAt?: string;
}

/** 1ホスト分の最新スナップショット。ops-dashboard の HostStatsSnapshot の部分集合。 */
export interface OpsHostSnapshot {
  hostname: string;
  os?: string;
  cpuPercent: number;
  memory: OpsUsage;
  swap?: OpsUsage;
  disks: OpsDisk[];
  loadAverage: [number, number, number];
  uptimeSeconds: number;
  temperatureCelsius?: number;
  maintenance?: OpsMaintenance;
  tmuxSessions?: OpsTmuxSession[];
  /** 上限で切られる前の総数。送らない世代のエージェントでは undefined */
  tmuxSessionTotal?: number;
  services: OpsService[];
}

/** 1ホスト分の表示データ。`history` は意図して受け取らない（24時間分あり重い）。 */
export interface OpsHostView {
  id: string;
  label: string;
  latest: OpsHostSnapshot;
  /** 最終受信からの経過秒数 */
  ageSeconds: number;
  online: boolean;
}

/** GET /api/host-stats */
export interface OpsHostStatsView {
  hosts: OpsHostView[];
  offlineAfterSeconds: number;
}

/** GET /api/uptime-kuma の monitors */
export interface OpsKumaMonitor {
  name: string;
  status: "up" | "down" | "pending" | "maintenance";
}

/**
 * GET /api/monitors の monitors（UptimeRobot）。
 * `status` は 0:停止中 / 1:未チェック / 2:稼働 / 8:応答なし / 9:停止。
 */
export interface OpsRobotMonitor {
  friendly_name: string;
  status: number;
}

/** GET /api/ai-usage */
export interface OpsAiUsage {
  providers: {
    name: string;
    status: "ok" | "unconfigured" | "error";
    message?: string;
    windows: { label: string; usedPercent: number; resetsAt: string | null; note?: string }[];
  }[];
}

/** GET /api/github-usage */
export interface OpsGitHubUsage {
  status: "ok" | "unconfigured" | "error";
  message?: string;
  actions: {
    allowanceMinutes: number;
    allowanceLimitMinutes: number;
    resetsAt: string;
  } | null;
}

/** GET /api/onepassword-usage */
export interface OpsOnePasswordUsage {
  status: "ok" | "unconfigured" | "error";
  message?: string;
  limits: {
    type: "token" | "account";
    action: "read" | "write" | "read_write";
    limit: number;
    used: number;
    remaining: number;
  }[];
}

/** 取得できなかったソース。落ちたこと自体が運用情報なので、握りつぶさず返す。 */
export interface OpsSourceFailure {
  source: string;
  /** 失敗の理由。**URL・ヘッダ・トークンは載せない**（HTTPステータスと例外名まで） */
  reason: string;
}

/**
 * ops-dashboard から取れたものを、整形せずそのまま束ねたもの。
 * 取れなかったソースは null になり、理由が `failures` に入る。
 */
export interface OpsDashboardRaw {
  hostStats: OpsHostStatsView | null;
  kumaMonitors: OpsKumaMonitor[] | null;
  robotMonitors: OpsRobotMonitor[] | null;
  aiUsage: OpsAiUsage | null;
  githubUsage: OpsGitHubUsage | null;
  onePasswordUsage: OpsOnePasswordUsage | null;
  failures: OpsSourceFailure[];
}
