/**
 * dotの作業報告（#609）の契約。
 *
 * 全活動の自動収集ではなく、dotが**明示的に報告した利用者向けの節目**だけを扱う。
 * 契約の全体像・順序規則・保持期間は `docs/work-reports.md`。
 */

/** 開始 / 実行中 / 待機 / 完了 / 失敗 / 取消。 */
export const WORK_STATUSES = ["started", "running", "waiting", "completed", "failed", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** これ以降は状態を変えられない。 */
export const TERMINAL_STATUSES: readonly WorkStatus[] = ["completed", "failed", "cancelled"];

export function isTerminal(status: WorkStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 文字数と件数の上限。ツールの説明・文書と同じ値を使う。 */
export const LIMITS = {
  idLength: 100,
  title: 80,
  progress: 200,
  waitReason: 200,
  resultSummary: 400,
  links: 5,
  linkLength: 300,
  /** 保持する作業の数。超えたら更新が古いものから捨てる。 */
  maxWorks: 200,
  /** 作業ごとに保持するイベントID（重複・競合の判定用）の数。 */
  maxEventsPerWork: 50,
  /** 最終更新からこの日数を過ぎた作業は捨てる。 */
  retentionDays: 90,
  /** 一覧の既定件数と上限。 */
  listDefault: 20,
  listMax: 50,
  /** 版の上限。桁あふれ・悪意ある巨大値を弾く。 */
  maxVersion: 1_000_000,
} as const;

/** 更新が無いまま経過したら「更新途絶」として知らせる時間。完了・失敗とは推定しない。 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** dotが送る1回の報告（検証済み）。 */
export interface WorkReportInput {
  workId: string;
  eventId: string;
  version: number;
  status: WorkStatus;
  /** 発生時刻（ISO 8601・UTCへ正規化済み）。 */
  occurredAt: string;
  title?: string;
  progress?: string;
  waitReason?: string;
  resultSummary?: string;
  links: string[];
}

export interface WorkEventRecord {
  eventId: string;
  version: number;
  /** 内容の指紋。同じeventIdの再送が同じ内容かを見分ける。内容そのものは持たない。 */
  fingerprint: string;
  receivedAt: string;
}

/** 保存する作業1件。最新の適用済み状態を持つ。 */
export interface WorkRecord {
  workId: string;
  /** 所有者。単一利用者前提でサーバーが固定値を入れる（自己申告は受け取らない）。 */
  owner: "owner";
  /** 報告元。認可済みトークンのOAuthクライアントIDから決める。 */
  reporter: string;
  version: number;
  status: WorkStatus;
  title: string;
  progress: string | null;
  waitReason: string | null;
  resultSummary: string | null;
  links: string[];
  occurredAt: string;
  /** 最後に適用した報告をサーバーが受け取った時刻。鮮度の判定に使う。 */
  receivedAt: string;
  createdAt: string;
  lastEventId: string;
  events: WorkEventRecord[];
}

export type FileShape = { works: WorkRecord[] };

/** 書込みの結果。`saved` が true のときだけ、永続化まで終わっている。 */
export type SubmitOutcome =
  | { ok: true; result: "applied" | "duplicate"; saved: true; work: PublicWork }
  | { ok: true; result: "stale"; saved: false; work: PublicWork; reason: string }
  | { ok: false; kind: "conflict" | "invalid_transition"; reason: string; work: PublicWork | null };

export type Freshness = "fresh" | "stale" | "final";

/** 読み取りに出す作業。内部の指紋・イベント台帳は出さない。 */
export interface PublicWork {
  workId: string;
  version: number;
  status: WorkStatus;
  title: string;
  progress: string | null;
  waitReason: string | null;
  resultSummary: string | null;
  links: string[];
  occurredAt: string;
  receivedAt: string;
  reporter: string;
  /** fresh=更新が続いている / stale=更新途絶（完了・失敗ではない） / final=終端状態。 */
  freshness: Freshness;
}

export interface WorkListing {
  ok: true;
  /** none=1件も報告が無い / reported=報告がある。取得失敗はこの形ではなくエラーで返す。 */
  reportState: "none" | "reported";
  works: PublicWork[];
  /** 条件に合う作業の総数（limitで切る前）。 */
  total: number;
  limit: number;
  staleCount: number;
  staleAfterMinutes: number;
  retention: { days: number; maxWorks: number };
  checkedAt: string;
}
