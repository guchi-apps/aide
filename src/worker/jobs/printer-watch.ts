import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeFailure, fetchPrinterState, readMyRoomConfig } from "../../core/connectors/myroom/index.ts";
import { summarizePrinter, type PrinterState, type PrinterStatus } from "../../core/views/printer.ts";
import { send, webhookUrl, workerStatePath } from "../notify.ts";
import {
  buildPrinterPayload,
  decidePrinterEvents,
  type PrinterWatchState,
} from "../printer-notify.ts";

/**
 * 3Dプリンターの状態遷移（完了・停止・エラー）を見張って Signaly へ通知する（#378）。
 *
 * myroom の内部API（`GET /api/internal/bambu/printer`）を2分ごとに読み、前回の記録と比べる。
 * **「いまの状態」を答えるツール（`aide_printer_status`）と同じ正規化・鮮度判定を通す**ので、
 * ツールが「現在の状態は分からない」と答える状況では、ここも遷移を作らない。
 *
 * 記録するのは前回の状態とエラーの署名だけ（`data/worker/printer-watch.json`）。
 * 取得した値そのものも、ジョブ名も残さない。
 *
 * **鮮度が切れている間は何もせず、記録も進めない。** 電源が入っていない間の「最後の値」から
 * 遷移を作らない。復帰後の最初の新鮮な値が、切れる前の記録と比べられる（切れている間に印刷が
 * 終わっていれば、復帰後に「完了」が1回届く。本文に最終更新時刻が入るので遅れは読み取れる）。
 */

const STATE_FILE = "printer-watch.json";

const STATES: readonly PrinterState[] = [
  "idle",
  "preparing",
  "printing",
  "paused",
  "finished",
  "failed",
  "unknown",
];

/** 壊れていても、基準を作り直すだけで害はない（通知が1回抜ける）。 */
export async function readWatchState(): Promise<PrinterWatchState | null> {
  try {
    const parsed = JSON.parse(await readFile(workerStatePath(STATE_FILE), "utf8")) as Partial<PrinterWatchState>;
    if (
      typeof parsed.state === "string" &&
      STATES.includes(parsed.state) &&
      typeof parsed.errorSignature === "string" &&
      typeof parsed.observedAt === "string"
    ) {
      return { state: parsed.state, errorSignature: parsed.errorSignature, observedAt: parsed.observedAt };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeWatchState(state: PrinterWatchState): Promise<void> {
  const path = workerStatePath(STATE_FILE);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

/**
 * 取得済みの状態を評価して、必要なら通知し、記録を進める。取得（HTTP）とは分けてあるのは、
 * 通知の要否・記録の進め方をテストで確かめられるようにするため。
 *
 * **通知を送れなかったときは記録を進めず、例外を投げる。** 進めると、その遷移は二度と
 * 通知されない。例外にすることで、失敗がジョブの失敗として記録・通知される。
 */
export async function evaluatePrinterStatus(status: PrinterStatus, now: Date): Promise<string> {
  if (!status.fresh || status.printer === null) {
    return `判定しない（鮮度: ${status.freshness}）。値が古い・取得できていない間は遷移を作らない`;
  }

  const url = webhookUrl();
  // 通知先が無い環境（開発機）では基準も動かさない。動かすと、本番へ移したときに最初の遷移が抜ける。
  if (!url) return "通知先（AIDE_SIGNALY_WEBHOOK_URL）が未設定のため、何もしない";

  const previous = await readWatchState();
  const { events, next } = decidePrinterEvents(previous, status.printer);

  for (const event of events) {
    if (!(await send(url, buildPrinterPayload(event, now)))) {
      throw new Error("3Dプリンターの状態遷移を Signaly へ送れなかった（次回の実行で送り直す）");
    }
  }

  const changed =
    next !== null &&
    (previous === null || previous.state !== next.state || previous.errorSignature !== next.errorSignature);
  if (next !== null && changed) await writeWatchState(next);

  const state = status.printer.state;
  if (previous === null) return `基準を記録した（状態: ${state}）`;
  if (events.length === 0) return `変化なし（状態: ${state}）`;
  return `${events.length}件を通知した（${events.map((event) => event.kind).join("・")}。状態: ${state}）`;
}

export async function runPrinterWatch(): Promise<string> {
  const config = readMyRoomConfig();
  // 通知の設定と違い、これは設定漏れそのもの。黙って成功させると、見張られていないことに気づけない。
  if (!config) throw new Error("AIDE_MYROOM_TOKEN が設定されていないため、プリンターの状態を取得できない");

  let snapshot;
  try {
    snapshot = await fetchPrinterState(config);
  } catch (cause) {
    // fetch は失敗時に Response をそのまま投げる。理由はHTTPステータスと例外の種別まで丸める
    // （例外の message にはURLが載り、通知・ジャーナルへ内部の構成が出るため）。
    throw new Error(`myroom からプリンターの状態を取得できなかった: ${describeFailure(cause)}`);
  }
  const now = new Date();
  return evaluatePrinterStatus(summarizePrinter(snapshot, now), now);
}
