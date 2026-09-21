import {
  errorSignature,
  type PrinterError,
  type PrinterReading,
  type PrinterState,
} from "../core/views/printer.ts";
import { COLOR_FAILURE, COLOR_RECOVERY, formatJst, type SignalyPayload } from "./notify.ts";

/**
 * 3Dプリンターの状態遷移を Signaly へ通知するための判定と文面（#378）。
 *
 * 通知するのは次の3つだけ。**進捗の実況や、印刷開始・一時停止のたびの通知はしない**
 * （毎回送ると本当に見たい完了・失敗が埋もれる。ジョブの通知と同じ考え方）。
 *
 * - `finished`: 印刷が完了した
 * - `failed`: 印刷が失敗・停止した（Bambu は利用者が中止したときも `FAILED` になる）
 * - `error`: プリンターが新しいエラーを報告した（一時停止を伴うことが多い）
 *
 * **鮮度が切れている値では判定しない。** 判定に渡すのは `fresh` のときの `PrinterReading` だけで、
 * 電源が切れていた間の「最後の値」から遷移を作らない（呼び出し側 `jobs/printer-watch.ts` の責務）。
 *
 * **通知本文に載せるのは、ジョブ名・進捗・エラーコードと本文・時刻だけ。** 接続情報は
 * `PrinterReading` に存在しないため、ここへ届く経路が無い。
 */

export type PrinterEventKind = "finished" | "failed" | "error";

export interface PrinterEvent {
  kind: PrinterEventKind;
  jobName: string | null;
  progressPercent: number | null;
  layer: number | null;
  totalLayers: number | null;
  errors: PrinterError[];
  /** このイベントの根拠にした値を、プリンターから最後に受信した時刻。 */
  updatedAt: string;
}

/** 前回の判定時点の記録。**基準とエラーの署名だけ**で、取得した値そのものは残さない。 */
export interface PrinterWatchState {
  state: PrinterState;
  /** 通知済みのエラー集合の署名（`errorSignature`）。エラーが無ければ空文字。 */
  errorSignature: string;
  observedAt: string;
}

/**
 * 前回の記録と今回の値から、通知すべきイベントと次に保存する記録を決める。**純粋関数。**
 *
 * - 前回の記録が無い（初回）: **通知せず基準だけ作る。** 昨日終わった印刷の「完了」を
 *   導入した瞬間に送らないため
 * - 状態が変わって `finished` / `failed` になったときに1回。状態が変わらない間は送らない
 * - それ以外で、**前回通知していない新しいエラーが現れた**ときに `error` を1回。
 *   同じエラーが続いている間は送らず、消えたら署名も空に戻すので、同じエラーがまた起きれば再び送る
 * - 状態が読めない（`unknown`）値は無視し、基準も進めない。読めない値から遷移を作ると、
 *   次に読めた値との差を「完了」と誤解しうる
 */
export function decidePrinterEvents(
  previous: PrinterWatchState | null,
  reading: PrinterReading,
): { events: PrinterEvent[]; next: PrinterWatchState | null } {
  if (reading.state === "unknown") return { events: [], next: previous };

  const signature = errorSignature(reading.errors);
  const next: PrinterWatchState = {
    state: reading.state,
    errorSignature: signature,
    observedAt: reading.updatedAt,
  };
  if (previous === null) return { events: [], next };

  const event = (kind: PrinterEventKind): PrinterEvent => ({
    kind,
    jobName: reading.jobName,
    progressPercent: reading.progressPercent,
    layer: reading.layer,
    totalLayers: reading.totalLayers,
    errors: reading.errors,
    updatedAt: reading.updatedAt,
  });

  const stateChanged = previous.state !== reading.state;
  if (stateChanged && reading.state === "finished") return { events: [event("finished")], next };
  if (stateChanged && reading.state === "failed") return { events: [event("failed")], next };
  if (signature !== "" && signature !== previous.errorSignature) return { events: [event("error")], next };
  return { events: [], next };
}

/** Signaly のフィールド値の上限（1024文字）に収める。 */
const FIELD_MAX = 900;

function clip(value: string): string {
  return value.length > FIELD_MAX ? `${value.slice(0, FIELD_MAX)}…` : value;
}

function progressText(event: PrinterEvent): string | null {
  const parts: string[] = [];
  if (event.progressPercent !== null) parts.push(`${Math.round(event.progressPercent)}%`);
  if (event.layer !== null && event.totalLayers !== null) parts.push(`${event.layer}/${event.totalLayers}層`);
  return parts.length > 0 ? parts.join(" / ") : null;
}

const EVENT_TEXT: Record<
  PrinterEventKind,
  { title: string; description: string; color: number }
> = {
  finished: {
    title: "✅ [AIDE] 3Dプリンター: 印刷が完了しました",
    description: "印刷が終わりました。造形物を取り出せます。",
    color: COLOR_RECOVERY,
  },
  failed: {
    title: "🛑 [AIDE] 3Dプリンター: 印刷が停止しました",
    description:
      "印刷が失敗、または中止されました。**途中で止まった造形物がベッドに残っている可能性があります。**",
    color: COLOR_FAILURE,
  },
  error: {
    title: "⚠️ [AIDE] 3Dプリンター: エラーが発生しました",
    description: "プリンターがエラーを報告しています。印刷が一時停止している場合は、対処するまで再開しません。",
    color: COLOR_FAILURE,
  },
};

/**
 * Signaly へ送る本文を作る。
 *
 * 遅れて検知したとき（電源が入っていなかった間に終わった印刷など）に「いま終わった」と読まれない
 * よう、**プリンターから最後に受信した時刻**と検知した時刻を並べて出す。
 */
export function buildPrinterPayload(event: PrinterEvent, detectedAt: Date): SignalyPayload {
  const text = EVENT_TEXT[event.kind];
  const fields: SignalyPayload["embeds"][0]["fields"] = [
    { name: "ジョブ", value: event.jobName ?? "（名前を取得できなかった）", inline: false },
  ];

  const progress = progressText(event);
  if (progress !== null) fields.push({ name: "進捗", value: progress, inline: true });

  fields.push({ name: "プリンターの最終更新", value: formatJst(new Date(event.updatedAt)), inline: true });
  fields.push({ name: "検知時刻", value: formatJst(detectedAt), inline: true });

  if (event.errors.length > 0) {
    fields.push({
      name: "エラー",
      value: clip(
        event.errors
          .map((error) => [error.code, error.message].filter((part) => part !== null).join(" "))
          .join("\n"),
      ),
      inline: false,
    });
  }

  return { embeds: [{ title: text.title, description: text.description, color: text.color, fields }] };
}
