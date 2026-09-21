import { describeFailure, fetchPrinterState, readMyRoomConfig } from "../connectors/myroom/index.ts";
import type { MyRoomFailure, MyRoomPrinter, MyRoomPrinterSnapshot } from "../connectors/myroom/types.ts";

/**
 * 3Dプリンター（Bambu Lab A1 mini）の状態のビュー（#378）。
 *
 * 収集はサブPCの常駐プロセスがローカルMQTTから行い、myroom が正規化して内部API
 * （`GET /api/internal/bambu/printer`。myroom#428）で返す。**AIDEは集め直さず、その値を「いまプリンターは
 * どうなっているか」に答えられる形へ畳む。**
 *
 * **鮮度を必ず返す。そして、鮮度が切れた値を現在の状態として返さない。** プリンターは電源を切れば
 * 黙って消える。myroom が最後に受け取った「印刷中 75%」をそのまま返すと、電源が切れた後も
 * 「まだ印刷中で、あと12分」と答え続けることになる。鮮度が `fresh` でないときは現在の値
 * （`printer`）を空にし、最後に確認できた値は `lastKnown` へ**時刻付きで分けて**返す。
 * myroom も同じ考えで、`online` でないときは `printer` を null にして最後の値を `lastKnown` へ
 * 分けて返す。**myroom の `lastKnown` を現在の値として読むことは、どの経路でもしない。**
 * 残り時間・終了予測・温度は時間が経てば意味を失うので、`lastKnown` にも入れない。
 *
 * **キャッシュを挟まず、呼ばれるたびに取得する。** 進捗も完了も鮮度そのものが価値で、
 * ジョブ間隔ぶん古くなると「終わったか」に答えられなくなる（README「どこまでを『重い取得』と
 * みなすか」の右側）。
 *
 * **接続情報（ホスト・シリアル番号・アクセスコード）は型に無く、正規化で列挙した項目だけを
 * 写す。** 相手が誤って余計な項目を返しても、応答・ログ・通知には出ない。
 */

export type PrinterState = "idle" | "preparing" | "printing" | "paused" | "finished" | "failed" | "unknown";

/**
 * 値がどこまで新しいか。**`fresh` 以外の値は現在の状態として扱わない。**
 *
 * - `fresh`: myroom が `online` と報告し、収集からの最終受信がしきい値以内
 * - `stale`: 収集からの受信が止まっている（`collector_stale`。サブPCの常駐が落ちている・ネットワーク断）
 * - `disconnected`: 収集は生きているがプリンターに繋がっていない（`printer_offline`。電源断など）
 * - `unknown`: 最終受信時刻や接続状態が読めず、新しいかを判断できない
 * - `never`: 収集が一度も届いていない（`no_data`。myroom 側の未設定・未起動）
 */
export type PrinterFreshness = "fresh" | "stale" | "disconnected" | "unknown" | "never";

/**
 * myroom が鮮度のしきい値を返さなかったときの既定。myroom の `BAMBU_STALE_SECONDS` の既定と同じ
 * （収集は変化が無くても60秒ごとに送ってくる）。
 */
export const DEFAULT_STALE_THRESHOLD_SECONDS = 180;

const NAME_MAX = 120;
const ERROR_SEVERITY_MAX = 20;
const ERROR_MESSAGE_MAX = 200;
const ERROR_CODE_MAX = 40;
const AMS_TEXT_MAX = 30;
const AMS_SLOTS_MAX = 8;
const ERRORS_MAX = 10;

export interface PrinterAmsSlot {
  slot: number | null;
  material: string | null;
  color: string | null;
  remainPercent: number | null;
}

export interface PrinterError {
  code: string | null;
  message: string | null;
}

/** 鮮度が `fresh` のときだけ返す、いまの状態。 */
export interface PrinterReading {
  /** プリンターから最後にメッセージを受けた時刻。値はこの時点のもの。 */
  updatedAt: string;
  state: PrinterState;
  jobName: string | null;
  progressPercent: number | null;
  layer: number | null;
  totalLayers: number | null;
  /** 印刷中・一時停止・準備中のときだけ入る。完了・待機では null。 */
  remainingMinutes: number | null;
  /** 終了予測時刻（ISO8601）。myroom が返さなければ最終更新＋残り時間から求める。 */
  estimatedEndAt: string | null;
  nozzleTemperature: number | null;
  nozzleTargetTemperature: number | null;
  bedTemperature: number | null;
  bedTargetTemperature: number | null;
  /** `silent` / `standard` / `sport` / `ludicrous`。 */
  speedMode: string | null;
  ams: PrinterAmsSlot[];
  errors: PrinterError[];
}

/**
 * 鮮度が切れたときに、参考として残す最後の値。**現在の値ではない。**
 * 残り時間・終了予測・温度は入れない（時間が経てば意味を失い、現在値と読み違えやすい）。
 */
export interface PrinterLastKnown {
  /** この時刻時点の値。 */
  asOf: string;
  state: PrinterState;
  jobName: string | null;
  progressPercent: number | null;
  layer: number | null;
  totalLayers: number | null;
  errors: PrinterError[];
}

export interface PrinterProblem {
  severity: "warn" | "danger";
  message: string;
}

export interface PrinterStatus {
  checkedAt: string;
  /** myroom への接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  /** 状態を取得できたか。false のときは、プリンターの状態が分からないという意味になる。 */
  complete: boolean;
  /** 新鮮で、かつ問題が無いか。**判定できていないときは false。** */
  ok: boolean;
  freshness: PrinterFreshness;
  /** `freshness === "fresh"`。**true のときだけ `printer` を現在の状態として読んでよい。** */
  fresh: boolean;
  /** 鮮度と、その値をどう読むべきかの1行。 */
  message: string;
  /** プリンターから最後にメッセージを受けた時刻（myroom の `lastMessageAt`）。 */
  measuredAt: string | null;
  /** 最終更新からの経過分数（AIDEが `measuredAt` から数えたもの）。 */
  ageMinutes: number | null;
  /** 収集が止まったとみなす秒数（myroom の `staleThresholdSeconds`）。 */
  staleThresholdSeconds: number;
  problems: PrinterProblem[];
  /** 現在の状態。`fresh` のときだけ。 */
  printer: PrinterReading | null;
  /** 最後に確認できた値。`fresh` でないときだけ。**現在の値ではない。** */
  lastKnown: PrinterLastKnown | null;
  unavailable: MyRoomFailure[];
  note: string;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * 印刷状態を読み替える。Bambu の `gcode_state`（`IDLE`・`PREPARE`・`RUNNING`・`PAUSE`・
 * `FINISH`・`FAILED`）、myroom が使う英語、日本語の表記のどれでも受ける。
 * **読めないものは `unknown`。** 推測で `idle` にすると、印刷中かもしれないものを待機と答える。
 */
export function normalizePrinterState(raw: unknown): PrinterState {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "idle":
    case "standby":
    case "待機":
    case "待機中":
      return "idle";
    case "prepare":
    case "preparing":
    case "slicing":
    case "準備":
    case "準備中":
      return "preparing";
    case "running":
    case "printing":
    case "印刷中":
      return "printing";
    case "pause":
    case "paused":
    case "一時停止":
      return "paused";
    case "finish":
    case "finished":
    case "complete":
    case "completed":
    case "done":
    case "完了":
      return "finished";
    case "failed":
    case "fail":
    case "failure":
    case "error":
    case "stopped":
    case "失敗":
    case "停止":
      return "failed";
    default:
      return "unknown";
  }
}

/** AMS Lite のスロットを1列に並べる。AMS Lite は1台なので、スロット番号だけで区別できる。 */
function summarizeAms(ams: MyRoomPrinter["ams"]): PrinterAmsSlot[] {
  const units = ams?.units;
  if (!Array.isArray(units)) return [];
  const slots: PrinterAmsSlot[] = [];
  for (const unit of units) {
    if (!Array.isArray(unit?.slots)) continue;
    for (const slot of unit.slots) {
      slots.push({
        slot: num(slot?.slot),
        material: text(slot?.material, AMS_TEXT_MAX),
        color: text(slot?.color, AMS_TEXT_MAX),
        remainPercent: num(slot?.remainPercent),
      });
    }
  }
  return slots.slice(0, AMS_SLOTS_MAX);
}

/**
 * HMS の重大度のうち、エラーとして扱うもの。myroom の通知（`bambu._error_codes`）と同じ線引きで、
 * `common`・`info` は数えない（情報レベルで「エラーが発生」と鳴らさない）。
 */
const HMS_ERROR_SEVERITIES: Record<string, string> = { fatal: "致命的", serious: "重大" };

function summarizeErrors(errors: MyRoomPrinter["errors"]): PrinterError[] {
  const summarized: PrinterError[] = [];
  const printErrorCode = text(errors?.printError?.code, ERROR_CODE_MAX);
  if (printErrorCode !== null) {
    summarized.push({ code: printErrorCode, message: "印刷エラー" });
  }
  const hms = Array.isArray(errors?.hms) ? errors.hms : [];
  for (const entry of hms) {
    const severity = text(entry?.severity, ERROR_SEVERITY_MAX);
    const label = severity === null ? undefined : HMS_ERROR_SEVERITIES[severity];
    const code = text(entry?.code, ERROR_CODE_MAX);
    if (label === undefined || code === null) continue;
    summarized.push({ code, message: `HMS（${label}）` });
  }
  return summarized.slice(0, ERRORS_MAX);
}

/** エラー集合の同一性を表す署名。通知が「同じエラーが続いている」ことを見分けるのに使う。 */
export function errorSignature(errors: readonly PrinterError[]): string {
  return errors
    .map((error) => error.code ?? error.message ?? "")
    .sort()
    .join(",");
}

const ONGOING_STATES: readonly PrinterState[] = ["printing", "paused", "preparing"];

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 60_000);
}

/**
 * myroom の `connection` を鮮度へ読み替える。
 *
 * **`online` と言われても、AIDEが `lastUpdateAt` から数え直した経過秒がしきい値を超えていれば
 * 切れているとみなす。** 片方だけを信じると、どちらかの時計・判定のずれがそのまま「古い値を
 * 現在値」にする。知らない `connection` は `unknown`（新しいと推測しない）。
 */
function judgeFreshness(snapshot: MyRoomPrinterSnapshot, thresholdSeconds: number, now: Date): PrinterFreshness {
  if (snapshot.configured === false || snapshot.connection === "no_data") return "never";
  if (snapshot.connection === "collector_stale" || snapshot.stale === true) return "stale";
  if (snapshot.connection === "printer_offline") return "disconnected";
  if (snapshot.connection !== "online" || snapshot.online !== true || !snapshot.printer) return "unknown";

  const lastUpdateAt = isoTime(snapshot.lastUpdateAt);
  if (lastUpdateAt === null) return "unknown";
  if (minutesBetween(new Date(lastUpdateAt), now) * 60 > thresholdSeconds) return "stale";
  return "fresh";
}

function ageText(ageMinutes: number | null): string {
  return ageMinutes === null ? "" : `（最終更新 ${ageMinutes}分前）`;
}

function freshnessMessage(freshness: PrinterFreshness, ageMinutes: number | null): string {
  switch (freshness) {
    case "fresh":
      return `プリンターの現在の状態${ageText(ageMinutes)}。`;
    case "stale":
      return (
        `プリンターの状態の収集が止まっている${ageText(ageMinutes)}。` +
        "サブPCの収集プロセスかネットワークが止まっている可能性がある。**現在の状態は分からない**" +
        "（lastKnown は最後に確認できた時点の値で、現在の値ではない）。"
      );
    case "disconnected":
      return (
        `プリンターに接続できていない${ageText(ageMinutes)}。` +
        "電源が切れている可能性がある。**現在の状態は分からない**（lastKnown は最後に確認できた時点の値で、現在の値ではない）。"
      );
    case "unknown":
      return "最終更新の時刻か接続状態が読めないため、値が新しいか判断できない。**現在の状態としては扱わない。**";
    case "never":
      return "プリンターの状態がまだ一度も届いていない（myroom 側で収集が動いていない）。現在の状態は分からない。";
  }
}

function readingOf(printer: MyRoomPrinter, updatedAt: string): PrinterReading {
  const state = normalizePrinterState(printer.state ?? printer.rawState);
  const ongoing = ONGOING_STATES.includes(state);
  const job = printer.job ?? {};
  const remainingMinutes = ongoing ? num(job.remainingMinutes) : null;

  let estimatedEndAt: string | null = null;
  if (ongoing) {
    estimatedEndAt = isoTime(job.estimatedFinishAt);
    if (estimatedEndAt === null && remainingMinutes !== null) {
      estimatedEndAt = new Date(new Date(updatedAt).getTime() + remainingMinutes * 60_000).toISOString();
    }
  }

  return {
    updatedAt,
    state,
    jobName: text(job.name, NAME_MAX),
    progressPercent: num(job.progressPercent),
    layer: num(job.layer),
    totalLayers: num(job.totalLayers),
    remainingMinutes,
    estimatedEndAt,
    nozzleTemperature: num(printer.nozzle?.temperature),
    nozzleTargetTemperature: num(printer.nozzle?.target),
    bedTemperature: num(printer.bed?.temperature),
    bedTargetTemperature: num(printer.bed?.target),
    speedMode: text(printer.speed?.mode, AMS_TEXT_MAX),
    ams: summarizeAms(printer.ams),
    errors: summarizeErrors(printer.errors),
  };
}

function describeError(error: PrinterError): string {
  return [error.code, error.message].filter((part) => part !== null).join(" ");
}

function readingProblems(reading: PrinterReading): PrinterProblem[] {
  const problems: PrinterProblem[] = [];
  if (reading.state === "failed") {
    problems.push({ severity: "danger", message: "印刷が失敗・停止している" });
  } else if (reading.state === "paused") {
    problems.push({ severity: "warn", message: "印刷が一時停止している" });
  }
  for (const error of reading.errors) {
    problems.push({ severity: "danger", message: `プリンターがエラーを報告している: ${describeError(error)}` });
  }
  return problems;
}

/**
 * 取得結果を「いまプリンターがどうなっているか」の粒度へ畳む。**純粋関数。テストはここに集中する。**
 */
export function summarizePrinter(snapshot: MyRoomPrinterSnapshot, now: Date): PrinterStatus {
  const threshold = num(snapshot.staleThresholdSeconds) ?? DEFAULT_STALE_THRESHOLD_SECONDS;
  const freshness = judgeFreshness(snapshot, threshold, now);
  if (freshness === "never") return blankStatus(now, threshold, "never", []);

  const fresh = freshness === "fresh";
  // 値の時刻はプリンターから最後に受けたメッセージの時刻。無ければ収集からの最終受信で代える
  // （収集はプリンターに繋がっている間しか値を更新しないので、それより新しくはならない）。
  const measuredAt = isoTime(snapshot.lastMessageAt) ?? isoTime(snapshot.lastUpdateAt);
  const ageMinutes = measuredAt === null ? null : Math.round(minutesBetween(new Date(measuredAt), now));

  // **現在値は myroom の `printer` からしか作らない。** 最後の値は `lastKnown` を優先し、AIDEの
  // 数え直しで切れた場合（myroom はまだ `online` と言っている）だけ `printer` を最後の値として使う。
  // 時刻が読めないものは値の出どころが分からないので、どちらにも渡さない。
  const source = fresh ? snapshot.printer : freshness === "unknown" ? null : (snapshot.lastKnown ?? snapshot.printer);
  const reading = source && measuredAt !== null ? readingOf(source, measuredAt) : null;

  const problems: PrinterProblem[] = [];
  if (!fresh) {
    problems.push({ severity: "warn", message: freshnessMessage(freshness, ageMinutes) });
  } else if (reading) {
    problems.push(...readingProblems(reading));
  }

  const notes = ["myroom が集めている値をそのまま読んでいる。AIDE側では収集も保存もしていない。"];
  if (!fresh) notes.push("鮮度が切れているため、現在の状態は返していない。");

  return {
    checkedAt: now.toISOString(),
    configured: true,
    complete: true,
    ok: fresh && problems.length === 0,
    freshness,
    fresh,
    message: freshnessMessage(freshness, ageMinutes),
    measuredAt,
    ageMinutes,
    staleThresholdSeconds: threshold,
    problems,
    printer: fresh ? reading : null,
    lastKnown:
      !fresh && reading
        ? {
            asOf: reading.updatedAt,
            state: reading.state,
            jobName: reading.jobName,
            progressPercent: reading.progressPercent,
            layer: reading.layer,
            totalLayers: reading.totalLayers,
            errors: reading.errors,
          }
        : null,
    unavailable: [],
    note: notes.join(" "),
  };
}

/** 判定の材料が無いときの共通の形。 */
function blankStatus(
  now: Date,
  threshold: number,
  freshness: PrinterFreshness,
  unavailable: MyRoomFailure[],
  overrides: { configured?: boolean; complete?: boolean; message?: string; note?: string } = {},
): PrinterStatus {
  const message = overrides.message ?? freshnessMessage(freshness, null);
  return {
    checkedAt: now.toISOString(),
    configured: overrides.configured ?? true,
    complete: overrides.complete ?? true,
    ok: false,
    freshness,
    fresh: false,
    message,
    measuredAt: null,
    ageMinutes: null,
    staleThresholdSeconds: threshold,
    problems: [{ severity: "warn", message }],
    printer: null,
    lastKnown: null,
    unavailable,
    note: overrides.note ?? "現在の状態は返していない（鮮度を判断できる値が無い）。",
  };
}

/** MCPツールから呼ばれる入口。設定を読み、取得し、畳む。 */
export async function buildPrinterStatus(): Promise<PrinterStatus> {
  const now = new Date();
  const config = readMyRoomConfig();
  if (!config) {
    return blankStatus(
      now,
      DEFAULT_STALE_THRESHOLD_SECONDS,
      "unknown",
      [{ source: "myroom", reason: "接続が設定されていない" }],
      {
        configured: false,
        complete: false,
        message: "myroom への接続が設定されていないため、プリンターの現在の状態は分からない。",
        note:
          "AIDE_MYROOM_TOKEN が設定されていないため、プリンターの状態を取得できない。" +
          "設定するまでこのツールは何も答えられない（問題が無いという意味ではない）。",
      },
    );
  }

  try {
    return summarizePrinter(await fetchPrinterState(config), now);
  } catch (cause) {
    // 取得できなかったこと自体が状態。例外にせず、理由を添えて返す。
    return blankStatus(
      now,
      DEFAULT_STALE_THRESHOLD_SECONDS,
      "unknown",
      [{ source: "myroom", reason: describeFailure(cause) }],
      {
        complete: false,
        message: "myroom から取得できなかったため、プリンターの現在の状態は分からない。",
        note: "myroom からプリンターの状態を取得できなかった。値が古いのではなく、いまの状態が分からない。",
      },
    );
  }
}
