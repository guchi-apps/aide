import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRoomStatus } from "../core/views/room.ts";
import type { RoomSensorSummary, RoomStatus } from "../core/views/room.ts";
import { currentSession, type LoginOptions } from "../web/login.ts";

/**
 * iOSウィジェット向けの室温API（#455。起点 guchi-apps/aide-ios#3）。
 *
 * 室温は MCP ツール `aide_room_sensors` でしか取れなかったため、画面と同じセッション
 * （`aide_status` Cookie）で読める読み取り専用の口を足した。**共有シークレットではなく
 * `currentSession()` を通す**のは、呼び出し元がログイン済みのアプリ内WebViewだから。
 *
 * 応答形は aide-ios が暫定の前提に実装している。変えるときは aide-ios#3 へ連絡する。
 */

export interface RoomSummaryDeps {
  buildRoomStatus?: typeof buildRoomStatus;
  currentSession?: typeof currentSession;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify(payload));
}

/**
 * 1台分を選ぶ。**受信が止まっておらず室温が取れているセンサーのうち、先頭の1台。**
 * 該当が無いときは null（呼び出し側が503にする）。止まったセンサーの最後の値を
 * 「いまの室温」としてウィジェットに出さないため、stale は選ばない。
 */
export function pickSensor(sensors: RoomSensorSummary[]): RoomSensorSummary | null {
  return sensors.find((sensor) => !sensor.stale && sensor.temperature !== null) ?? null;
}

/** 値が取れないときでも返す最終測定時刻。センサーのうち最も新しいもの。 */
function latestMeasuredAt(status: RoomStatus): string | null {
  const times = status.sensors
    .map((sensor) => sensor.measuredAt)
    .filter((value): value is string => value !== null)
    .sort();
  return times.at(-1) ?? null;
}

/** `GET /api/room/summary` */
export async function handleRoomSummary(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: RoomSummaryDeps = {},
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  // 画面ではないのでリダイレクトしない。
  const session = await (deps.currentSession ?? currentSession)(req, options);
  if (!session) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const status = await (deps.buildRoomStatus ?? buildRoomStatus)();
  const sensor = pickSensor(status.sensors);
  if (!sensor) {
    json(res, 503, {
      error: "室温を取得できません",
      measuredAt: latestMeasuredAt(status) ?? status.measuredAt,
    });
    return;
  }

  json(res, 200, {
    name: sensor.name,
    temperature: sensor.temperature,
    humidity: sensor.humidity,
    outdoorDeltaCelsius: sensor.outdoorDeltaCelsius,
    measuredAt: sensor.measuredAt,
  });
}
