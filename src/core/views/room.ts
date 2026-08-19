import { describeFailure, fetchRoomState, readMyRoomConfig } from "../connectors/myroom/index.ts";
import type { MyRoomAircon, MyRoomFailure, MyRoomSensor, MyRoomSnapshot } from "../connectors/myroom/types.ts";

/**
 * 部屋の状態の横断ビュー。
 *
 * センサーごとの最新値・鮮度、エアコンの運転状態、屋外との対比を1回の答えに畳む。
 * 情報源は myroom 1つだが、**向こうが別々に持っている値を「いま部屋はどうなっているか」に
 * 畳む**という点で横断ビューにあたる（ops と同じ立て付け）。
 *
 * 返すのは「いまの部屋の状態」に答えられる粒度まで。履歴・日別統計・記録の一覧は**返さない**。
 * 生の時系列をそのまま渡すと、Claudeのコンテキストを食うだけで答えは良くならない。
 *
 * **キャッシュを挟まず、呼ばれるたびに取得する。** 鮮度そのものが価値であるデータなので、
 * ジョブ間隔ぶん古くなると「いま暑いか」に答えられなくなる（README「どこまでを『重い取得』と
 * みなすか」の右側）。
 */

/** 逼迫の度合い。ops ビューと同じ考え方。 */
export type RoomSeverity = "ok" | "warn" | "danger";

/**
 * しきい値。**ここだけを見れば判定基準が分かる**ようにまとめている。
 *
 * 温度・湿度は上下どちらへ外れても困るため、`low`（下振れが悪い）と `high`（上振れが悪い）を
 * 分けて持つ。CO2の 1000ppm は建築物衛生法の管理基準、1500ppm はその1.5倍を目安に置いた。
 */
const THRESHOLDS = {
  temperatureCelsius: { low: { warn: 18, danger: 12 }, high: { warn: 28, danger: 31 } },
  humidityPercent: { low: { warn: 30, danger: 20 }, high: { warn: 70, danger: 80 } },
  co2Ppm: { warn: 1000, danger: 1500 },
} as const;

export interface RoomProblem {
  severity: Exclude<RoomSeverity, "ok">;
  message: string;
}

export interface RoomSensorSummary {
  deviceId: number;
  name: string;
  /** 最終測定時刻。1件も記録が無ければ null。 */
  measuredAt: string | null;
  ageMinutes: number | null;
  /** 鮮度切れか。判定は myroom 側（しきい値は `staleThresholdMinutes`）。 */
  stale: boolean;
  temperature: number | null;
  humidity: number | null;
  /** hPa。 */
  pressure: number | null;
  co2: number | null;
  illuminance: number | null;
  /** 室内 − 屋外の気温差。どちらか欠ければ null。 */
  outdoorDeltaCelsius: number | null;
}

export interface RoomOutdoorSummary {
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  /** 観測時刻。室温の測定時刻とは一致しない（予報値の丸めが効くため）。 */
  observedAt: string | null;
}

export interface RoomAirconSummary {
  acId: number;
  name: string;
  measuredAt: string | null;
  ageMinutes: number | null;
  /** `on` / `off` など、機器が返した文字列そのまま。 */
  power: string | null;
  mode: string | null;
  targetTemperature: number | null;
  roomTemperature: number | null;
  humidity: number | null;
  fanSpeed: string | null;
  /** 機器がネットワーク上に見えているか。判定できなければ null。 */
  online: boolean | null;
}

export interface RoomStatus {
  checkedAt: string;
  /** myroom への接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  /** 判定できた範囲で問題が無いか。**材料を1つも取得できなかった場合も false。** */
  ok: boolean;
  severity: RoomSeverity;
  /** 状態を取得できたか。false なら `ok` は判定できていないという意味になる。 */
  complete: boolean;
  problems: RoomProblem[];
  /** myroom が状態を組み立てた時刻。取得できなければ null。 */
  measuredAt: string | null;
  /** 鮮度切れとみなす分数（myroom 側の設定値）。 */
  staleThresholdMinutes: number | null;
  sensors: RoomSensorSummary[];
  outdoor: RoomOutdoorSummary | null;
  aircons: RoomAirconSummary[];
  /** 取得できなかった／設定されていないソース。 */
  unavailable: MyRoomFailure[];
  note: string;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 数値でないものは null にする。相手のフィールドが消えても落ちないように通す。 */
function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 上振れが悪い指標（CO2）の判定。 */
function highIsBad(value: number, limits: { warn: number; danger: number }): RoomSeverity {
  if (value >= limits.danger) return "danger";
  if (value >= limits.warn) return "warn";
  return "ok";
}

/** 上下どちらへ外れても悪い指標（温度・湿度）の判定。 */
function outOfRange(
  value: number,
  limits: { low: { warn: number; danger: number }; high: { warn: number; danger: number } },
): RoomSeverity {
  if (value <= limits.low.danger || value >= limits.high.danger) return "danger";
  if (value <= limits.low.warn || value >= limits.high.warn) return "warn";
  return "ok";
}

function worst(severities: RoomSeverity[]): RoomSeverity {
  if (severities.includes("danger")) return "danger";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

function summarizeSensor(sensor: MyRoomSensor, outdoorTemperature: number | null): RoomSensorSummary {
  const temperature = num(sensor.temperature);
  const ageMinutes = num(sensor.ageMinutes);

  return {
    deviceId: sensor.deviceId,
    name: text(sensor.name) ?? `センサー${sensor.deviceId}`,
    measuredAt: text(sensor.measuredAt),
    ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes),
    stale: sensor.stale === true,
    temperature,
    humidity: num(sensor.humidity),
    pressure: num(sensor.pressure),
    co2: num(sensor.co2),
    illuminance: num(sensor.illuminance),
    // 受信が止まっているセンサーでは気温差を出さない。
    // 「いま屋外より2℃高い」と読まれるが、比べているのは数日前の室温になる。
    outdoorDeltaCelsius:
      temperature === null || outdoorTemperature === null || sensor.stale === true
        ? null
        : round1(temperature - outdoorTemperature),
  };
}

function summarizeAircon(aircon: MyRoomAircon): RoomAirconSummary {
  const ageMinutes = num(aircon.ageMinutes);

  return {
    acId: aircon.acId,
    name: text(aircon.name) ?? `エアコン${aircon.acId}`,
    measuredAt: text(aircon.measuredAt),
    ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes),
    power: text(aircon.power),
    mode: text(aircon.mode),
    targetTemperature: num(aircon.targetTemperature),
    roomTemperature: num(aircon.roomTemperature),
    humidity: num(aircon.humidity),
    fanSpeed: text(aircon.fanSpeed),
    online: typeof aircon.online === "boolean" ? aircon.online : null,
  };
}

/**
 * センサー1台ぶんの気になる点を洗い出す。
 *
 * **鮮度切れのセンサーでは値を評価しない。** 最後に受け取った値をそのまま判定すると、
 * 数日前に止まったセンサーの27℃を「いまの室温」として報告してしまう
 * （ops ビューがオフラインのホストを評価しないのと同じ理由）。
 */
function sensorProblems(sensor: RoomSensorSummary): RoomProblem[] {
  if (sensor.measuredAt === null) {
    return [{ severity: "warn", message: `${sensor.name} の記録がまだ1件も無い` }];
  }
  if (sensor.stale) {
    const age = sensor.ageMinutes === null ? "" : `（最終測定 ${sensor.ageMinutes}分前）`;
    return [{ severity: "warn", message: `${sensor.name} からの受信が止まっている${age}` }];
  }

  const problems: RoomProblem[] = [];
  const add = (severity: RoomSeverity, message: string): void => {
    if (severity !== "ok") problems.push({ severity, message });
  };

  if (sensor.temperature !== null) {
    add(
      outOfRange(sensor.temperature, THRESHOLDS.temperatureCelsius),
      `${sensor.name} の室温が ${sensor.temperature}℃`,
    );
  }
  if (sensor.humidity !== null) {
    add(
      outOfRange(sensor.humidity, THRESHOLDS.humidityPercent),
      `${sensor.name} の湿度が ${sensor.humidity}%`,
    );
  }
  if (sensor.co2 !== null) {
    add(highIsBad(sensor.co2, THRESHOLDS.co2Ppm), `${sensor.name} のCO2が ${sensor.co2}ppm`);
  }

  return problems;
}

/**
 * 取得結果を「いま部屋がどうなっているか」の粒度へ畳む。**純粋関数。テストはここに集中する。**
 */
export function summarizeRoom(snapshot: MyRoomSnapshot, now: Date): RoomStatus {
  const outdoorRaw = snapshot.outdoor ?? null;
  const outdoor: RoomOutdoorSummary | null = outdoorRaw
    ? {
        temperature: num(outdoorRaw.temperature),
        humidity: num(outdoorRaw.humidity),
        pressure: num(outdoorRaw.pressure),
        observedAt: text(outdoorRaw.observedAt),
      }
    : null;

  const sensors = (snapshot.sensors ?? []).map((sensor) =>
    summarizeSensor(sensor, outdoor?.temperature ?? null),
  );
  const aircons = (snapshot.aircons ?? []).map(summarizeAircon);

  const problems: RoomProblem[] = sensors.flatMap(sensorProblems);
  for (const aircon of aircons) {
    if (aircon.online === false) {
      problems.push({ severity: "warn", message: `${aircon.name} がオフライン` });
    }
  }

  const notes = [
    "myroom が集めている値をそのまま読んでいる。AIDE側では収集も保存もしていない。",
  ];
  if (sensors.length === 0) {
    notes.push("センサーの値を1件も取得できていない。");
  }
  if (sensors.some((sensor) => sensor.stale)) {
    // 止まったセンサーの最後の値を「いまの室温」と読ませないための断り書き。
    // problems 側では評価していないが、sensors には最後の値がそのまま残る。
    notes.push("stale が true のセンサーの値は最後に受信した時点のもので、現在の値ではない。");
  }

  // 何ひとつ取得できていないときに `ok: true` を返すと「問題なし」と読まれる。
  // 判定の材料が1つも無い状態は「問題が無い」ではないので、区別する。
  const judged = sensors.length > 0 || aircons.length > 0;

  return {
    checkedAt: now.toISOString(),
    configured: true,
    ok: judged && problems.length === 0,
    severity: worst(problems.map((problem) => problem.severity)),
    complete: true,
    problems,
    measuredAt: text(snapshot.fetchedAt),
    staleThresholdMinutes: num(snapshot.staleThresholdMinutes),
    sensors,
    outdoor,
    aircons,
    unavailable: [],
    note: notes.join(" "),
  };
}

/** 判定の材料が無いときの共通の形。 */
function blankStatus(now: Date, reason: string, note: string): RoomStatus {
  return {
    checkedAt: now.toISOString(),
    configured: reason !== "接続が設定されていない",
    ok: false,
    severity: "warn",
    complete: false,
    problems: [],
    measuredAt: null,
    staleThresholdMinutes: null,
    sensors: [],
    outdoor: null,
    aircons: [],
    unavailable: [{ source: "myroom", reason }],
    note,
  };
}

/** MCPツールから呼ばれる入口。設定を読み、取得し、畳む。 */
export async function buildRoomStatus(): Promise<RoomStatus> {
  const now = new Date();
  const config = readMyRoomConfig();
  if (!config) {
    return blankStatus(
      now,
      "接続が設定されていない",
      "AIDE_MYROOM_TOKEN が設定されていないため、部屋の状態を取得できない。" +
        "設定するまでこのツールは何も答えられない（問題が無いという意味ではない）。",
    );
  }

  try {
    return summarizeRoom(await fetchRoomState(config), now);
  } catch (cause) {
    // 取得できなかったこと自体が状態。例外にせず、理由を添えて返す。
    return blankStatus(
      now,
      describeFailure(cause),
      "myroom から部屋の状態を取得できなかった。値が古いのではなく、いまの状態が分からない。",
    );
  }
}
