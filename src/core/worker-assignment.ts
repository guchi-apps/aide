import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * worker ジョブの担当ホストの割り振り（#891）。
 *
 * **どのホストで worker ジョブを動かすかの正を、各ホストの `.env` ではなくAIDEのサーバー（VPS）に置く。**
 * 各ホストの worker はジョブを始める前に `POST /api/worker/claim` で「自分が動かしてよいか」を問い合わせ、
 * サーバーはその問い合わせを**ハートビートとして記録したうえで**担当を決めて返す。2分ごとのジョブ
 * （`claude-sessions-sync`・`printer-watch`）が両ホストで走るため、ハートビート専用のタイマーは持たない。
 *
 * ## 担当の決め方
 *
 * 担当は**全ジョブで共通の1台**にする。主はサブPC（`subpc`）、予備は Mac mini（`macmini`）。
 * Zaim系をホストごとに分けると、Web版の受け口（`zaim-web`）の振り分けと噛み合わなくなるため分けない。
 *
 * - 自動（既定）: 担当ホストの問い合わせが `FAILOVER_AFTER_MS` 途切れ、もう一方が生きていれば移す。
 *   主へは、主の問い合わせが `FAILBACK_AFTER_MS` 続いてから戻す（行ったり来たりさせない）
 * - 固定（`subpc` / `macmini`）: 解除するまでそのホスト。止まっていても移さない（メンテナンス用）
 *
 * **二重実行は「生きているホストからは担当を奪わない」ことで防ぐ。** 担当が移るのは、担当ホストが
 * `FAILOVER_AFTER_MS` のあいだ一度も問い合わせてこなかったときだけ。問い合わせがVPSへ届かない
 * ホストは自分で動かさない側に倒れる（`src/worker/assignment.ts`）ので、VPSから見えないまま
 * 動き続けることもない。
 *
 * 記録するのはホスト名・時刻・モード・切り替えの理由だけで、シークレットや取得したデータは書かない。
 */

export const PRIMARY_HOST = "subpc";
export const BACKUP_HOST = "macmini";
export const WORKER_HOSTS = [PRIMARY_HOST, BACKUP_HOST] as const;
export type WorkerHost = (typeof WORKER_HOSTS)[number];

/** 担当ホストの問い合わせがこれだけ途切れたら、もう一方へ移す。一時的な瞬断で切り替えないため長めに取る。 */
export const FAILOVER_AFTER_MS = 15 * 60_000;
/** 主の問い合わせがこれだけ続いたら主へ戻す。 */
export const FAILBACK_AFTER_MS = 30 * 60_000;
/**
 * 問い合わせの間隔がこれを超えたら「続いている」を数え直す。
 *
 * 2分ごとのジョブがあるので、通常は2分おきに届く。1回の送信失敗（4分空く）で数え直さない程度に取る。
 */
export const CONTINUITY_GAP_MS = 10 * 60_000;

export type AssignmentMode = "auto" | WorkerHost;

export type SwitchReason = "failover" | "failback" | "manual";

export interface AssignmentSwitch {
  at: string;
  from: WorkerHost;
  to: WorkerHost;
  reason: SwitchReason;
}

export interface HostHeartbeat {
  /** 最後に問い合わせてきた時刻。 */
  lastSeenAt: string;
  /** 問い合わせが途切れずに続いている起点。間隔が `CONTINUITY_GAP_MS` を超えたら数え直す。 */
  aliveSince: string;
}

export interface AssignmentState {
  mode: AssignmentMode;
  owner: WorkerHost;
  hosts: Partial<Record<WorkerHost, HostHeartbeat>>;
  lastSwitch: AssignmentSwitch | null;
  /** `lastSwitch` を新しい担当ホストへ通知用に渡し終えたか。渡したら二度と渡さない。 */
  switchNoticeDelivered: boolean;
  /** モードを最後に変えた時刻。 */
  modeChangedAt: string | null;
}

export function initialState(): AssignmentState {
  return {
    mode: "auto",
    owner: PRIMARY_HOST,
    hosts: {},
    lastSwitch: null,
    switchNoticeDelivered: true,
    modeChangedAt: null,
  };
}

export function isWorkerHost(value: unknown): value is WorkerHost {
  return typeof value === "string" && (WORKER_HOSTS as readonly string[]).includes(value);
}

export function isAssignmentMode(value: unknown): value is AssignmentMode {
  return value === "auto" || isWorkerHost(value);
}

function otherHost(host: WorkerHost): WorkerHost {
  return host === PRIMARY_HOST ? BACKUP_HOST : PRIMARY_HOST;
}

function msSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now.getTime() - at;
}

/** 問い合わせが `FAILOVER_AFTER_MS` 以内に届いているか。 */
export function isAlive(state: AssignmentState, host: WorkerHost, now: Date): boolean {
  return msSince(state.hosts[host]?.lastSeenAt, now) < FAILOVER_AFTER_MS;
}

/** ハートビートを記録した新しい状態を返す（元の状態は変えない）。 */
export function recordHeartbeat(state: AssignmentState, host: WorkerHost, now: Date): AssignmentState {
  const previous = state.hosts[host];
  const at = now.toISOString();
  const continuing = previous !== undefined && msSince(previous.lastSeenAt, now) <= CONTINUITY_GAP_MS;
  return {
    ...state,
    hosts: {
      ...state.hosts,
      [host]: { lastSeenAt: at, aliveSince: continuing ? previous.aliveSince : at },
    },
  };
}

function switchTo(state: AssignmentState, to: WorkerHost, reason: SwitchReason, now: Date): AssignmentState {
  if (state.owner === to) return state;
  return {
    ...state,
    owner: to,
    lastSwitch: { at: now.toISOString(), from: state.owner, to, reason },
    switchNoticeDelivered: false,
  };
}

/**
 * いまの担当を判定し直した状態を返す。**純粋関数**で、時刻は引数で受け取る。
 *
 * 判定は問い合わせ・状態の読み取りのたびに呼ぶ。誰も問い合わせてこない間は担当も動かないが、
 * そのときは動かすホストがそもそも無い。
 */
export function evaluate(state: AssignmentState, now: Date): AssignmentState {
  if (state.mode !== "auto") return switchTo(state, state.mode, "manual", now);

  const owner = state.owner;
  if (owner !== PRIMARY_HOST) {
    const primary = state.hosts[PRIMARY_HOST];
    if (primary && isAlive(state, PRIMARY_HOST, now) && msSince(primary.aliveSince, now) >= FAILBACK_AFTER_MS) {
      return switchTo(state, PRIMARY_HOST, "failback", now);
    }
  }
  const other = otherHost(owner);
  if (!isAlive(state, owner, now) && isAlive(state, other, now)) {
    return switchTo(state, other, "failover", now);
  }
  return state;
}

/** モードを変えた状態を返す。固定ならその場で担当を移す。自動へ戻すときは担当をいったん据え置いて判定に任せる。 */
export function changeMode(state: AssignmentState, mode: AssignmentMode, now: Date): AssignmentState {
  const changed: AssignmentState = { ...state, mode, modeChangedAt: now.toISOString() };
  return evaluate(changed, now);
}

export interface ClaimDecision {
  run: boolean;
  owner: WorkerHost;
  mode: AssignmentMode;
  /** この問い合わせで新しい担当ホストへ渡す切り替えの知らせ。渡すのは1回だけ。 */
  notice: AssignmentSwitch | null;
}

/** 問い合わせ1回ぶんの処理（ハートビート→判定→応答）。 */
export function claim(
  state: AssignmentState,
  host: WorkerHost,
  now: Date,
): { state: AssignmentState; decision: ClaimDecision } {
  let next = evaluate(recordHeartbeat(state, host, now), now);
  let notice: AssignmentSwitch | null = null;
  if (next.lastSwitch && !next.switchNoticeDelivered && next.lastSwitch.to === host) {
    notice = next.lastSwitch;
    next = { ...next, switchNoticeDelivered: true };
  }
  return { state: next, decision: { run: next.owner === host, owner: next.owner, mode: next.mode, notice } };
}

// ---- 保存 ----

export function assignmentStatePath(): string {
  return process.env["AIDE_WORKER_ASSIGNMENT_PATH"] || resolve(DATA_DIR, "worker-assignment.json");
}

/** 読み込んだ値を検査して取り込む。壊れていたら初期状態にする（主＝サブPCの自動）。 */
export function parseState(raw: unknown): AssignmentState {
  const base = initialState();
  if (typeof raw !== "object" || raw === null) return base;
  const value = raw as Record<string, unknown>;
  const hosts: AssignmentState["hosts"] = {};
  const rawHosts = (value["hosts"] ?? {}) as Record<string, unknown>;
  for (const host of WORKER_HOSTS) {
    const beat = rawHosts[host] as Partial<HostHeartbeat> | undefined;
    if (beat && typeof beat.lastSeenAt === "string" && typeof beat.aliveSince === "string") {
      hosts[host] = { lastSeenAt: beat.lastSeenAt, aliveSince: beat.aliveSince };
    }
  }
  const sw = value["lastSwitch"] as Partial<AssignmentSwitch> | null | undefined;
  const lastSwitch =
    sw && typeof sw.at === "string" && isWorkerHost(sw.from) && isWorkerHost(sw.to) &&
    (sw.reason === "failover" || sw.reason === "failback" || sw.reason === "manual")
      ? { at: sw.at, from: sw.from, to: sw.to, reason: sw.reason }
      : null;
  return {
    mode: isAssignmentMode(value["mode"]) ? value["mode"] : base.mode,
    owner: isWorkerHost(value["owner"]) ? value["owner"] : base.owner,
    hosts,
    lastSwitch,
    switchNoticeDelivered: lastSwitch ? value["switchNoticeDelivered"] !== false : true,
    modeChangedAt: typeof value["modeChangedAt"] === "string" ? value["modeChangedAt"] : null,
  };
}

/**
 * サーバープロセス内の現在値。
 *
 * Zaim Web版の中継先（`web-payment-forward.ts`）は同期で担当ホストを知る必要があるため、
 * ファイルを毎回読まずにここへ持つ。書き込みはこのプロセスだけが行う。
 */
let current: AssignmentState | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<AssignmentState> {
  if (current) return current;
  try {
    current = parseState(JSON.parse(await readFile(assignmentStatePath(), "utf8")));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.warn(`[worker-assignment] 状態を読めないため初期状態で始めます: ${String(cause)}`);
    current = initialState();
  }
  return current;
}

async function save(state: AssignmentState): Promise<void> {
  const path = assignmentStatePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * 状態を読み、渡した関数で変え、変わっていれば保存する。呼び出しは直列化する
 * （同時に2つの問い合わせが来ても、片方のハートビートが消えないように）。
 */
export function updateAssignment<R>(
  task: (state: AssignmentState) => { state: AssignmentState; result: R },
): Promise<R> {
  const run = queue.then(async () => {
    const before = await load();
    const { state, result } = task(before);
    if (state !== before) {
      await save(state);
      current = state;
      if (state.owner !== before.owner && state.lastSwitch) {
        const sw = state.lastSwitch;
        console.log(`[worker-assignment] 担当を ${sw.from} から ${sw.to} へ移しました（${sw.reason}）`);
      }
    }
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** 起動時に読み込んでおく。読み込むまでの同期参照（`currentOwner()`）は主を返す。 */
export async function loadAssignment(): Promise<void> {
  await load();
}

/** 同期で読める担当ホスト。読み込み前・未使用なら主。 */
export function currentOwner(): WorkerHost {
  return current?.owner ?? PRIMARY_HOST;
}

/** テスト用: プロセス内の現在値を捨てる。 */
export function resetAssignmentForTest(): void {
  current = null;
  queue = Promise.resolve();
}
