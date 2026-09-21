/**
 * myroom の `GET /api/internal/room-state` のレスポンスのうち、
 * **AIDEが実際に使うフィールドだけ**を再宣言したもの。
 *
 * 別リポジトリなので型をimportできない、というだけの理由ではない。**使う範囲を明示的に
 * 絞ること自体が目的**で、向こうが画面都合でフィールドを足しても、ここに書いていない限り
 * AIDEは影響を受けない。逆に、ここに書いたフィールドが消えたら型ではなく実行時に
 * `undefined` として現れるため、扱いは常に「無いかもしれない」前提で書く。
 *
 * 正本は myroom 側の内部API（guchi-apps/myroom）。
 */

/** センサー1台ぶんの最新値。値はどれも欠けうる（機種によって持つ項目が違う）。 */
export interface MyRoomSensor {
  deviceId: number;
  /** 表示名。myroom の `data/devices.json` で付けたもの。 */
  name?: string;
  /** 最終測定時刻（ISO8601）。1件も記録が無ければ null。 */
  measuredAt?: string | null;
  /** 測定からの経過分数。myroom 側の計算をそのまま受け取る。 */
  ageMinutes?: number | null;
  /** 鮮度切れか。しきい値は myroom の `SENSOR_STALE_MINUTES`。 */
  stale?: boolean;
  temperature?: number | null;
  humidity?: number | null;
  /** hPa に正規化済み（気圧オフセット適用後）。 */
  pressure?: number | null;
  co2?: number | null;
  illuminance?: number | null;
}

/**
 * 屋外の観測値。myroom が Open-Meteo から取っている**現在値**。
 *
 * **AIDE の weather コネクタでは代替できない。** あちらが持っているのは日別予報の
 * 最高／最低気温だけで、いまの外気温はどこにも無い（`src/core/connectors/weather/types.ts`）。
 */
export interface MyRoomOutdoor {
  temperature?: number | null;
  humidity?: number | null;
  pressure?: number | null;
  /** 観測時刻（ISO8601）。予報値の丸めが効くため、室温の測定時刻とは一致しない。 */
  observedAt?: string | null;
}

/** エアコン1台ぶんの最新の状態。 */
export interface MyRoomAircon {
  acId: number;
  name?: string;
  measuredAt?: string | null;
  ageMinutes?: number | null;
  /** `on` / `off` など。機種の文字列をそのまま受け取る。 */
  power?: string | null;
  /** 冷房・暖房・送風など。 */
  mode?: string | null;
  targetTemperature?: number | null;
  roomTemperature?: number | null;
  humidity?: number | null;
  fanSpeed?: string | null;
  /** 機器がネットワーク上に見えているか。判定できなければ undefined。 */
  online?: boolean | null;
}

/** `GET /api/internal/room-state` のレスポンス。 */
export interface MyRoomSnapshot {
  /** myroom が応答を組み立てた時刻（ISO8601）。 */
  fetchedAt?: string;
  /** 鮮度切れとみなす分数。myroom 側の設定値。 */
  staleThresholdMinutes?: number;
  sensors?: MyRoomSensor[];
  outdoor?: MyRoomOutdoor | null;
  aircons?: MyRoomAircon[];
}

/** AMS Lite のスロット1つぶん。 */
export interface MyRoomPrinterAmsSlot {
  slot?: number | null;
  /** 材料の種類（PLA・PETG など）。 */
  material?: string | null;
  /** 色。myroom が返した文字列（`#RRGGBB` など）をそのまま受け取る。 */
  color?: string | null;
  /** 残量（%）。 */
  remainPercent?: number | null;
}

/** プリンターが報告している印刷エラー・HMS の1件。 */
export interface MyRoomPrinterError {
  code?: string | number | null;
  message?: string | null;
}

/**
 * 3Dプリンター（Bambu Lab A1 mini）1台の正規化済みの状態。
 *
 * **AIDEが期待する形で、myroom#428 が返す形として先に決めたもの**（guchi-apps/aide#378）。
 * myroom 側が別の形で実装した場合は、直すのは `src/core/views/printer.ts` の正規化だけにする。
 * 値はどれも欠けうる（機種・ファームウェア・印刷の段階で持つ項目が違う）。
 *
 * **接続情報（ホスト・シリアル番号・アクセスコード）はここに宣言しない。** 宣言していない項目は
 * 正規化の段階で捨てるため、myroom が誤って返しても AIDE の応答・ログ・通知には出ない。
 */
export interface MyRoomPrinter {
  name?: string | null;
  /** 収集プロセスがプリンターと接続できているか。 */
  online?: boolean | null;
  /** プリンターから最後に受信した時刻（ISO8601）。 */
  updatedAt?: string | null;
  /** 最終更新からの経過分数。myroom 側の計算。AIDEは `updatedAt` から数え直して突き合わせる。 */
  ageMinutes?: number | null;
  /** 鮮度切れか。しきい値は `staleThresholdMinutes`。 */
  stale?: boolean | null;
  /**
   * 印刷状態。`idle`（待機）・`preparing`（準備）・`printing`（印刷中）・`paused`（一時停止）・
   * `finished`（完了）・`failed`（失敗）。Bambu の `gcode_state`（`RUNNING` など）や日本語の
   * 表記もAIDE側で読み替える。
   */
  state?: string | null;
  jobName?: string | null;
  progressPercent?: number | null;
  layer?: number | null;
  totalLayers?: number | null;
  /** 終了までの残り分数。 */
  remainingMinutes?: number | null;
  /** 終了予測時刻（ISO8601）。 */
  estimatedEndAt?: string | null;
  nozzleTemperature?: number | null;
  nozzleTargetTemperature?: number | null;
  bedTemperature?: number | null;
  bedTargetTemperature?: number | null;
  /** 印刷速度モード（静音・標準・スポーツ・ルドロス など）。 */
  speedMode?: string | null;
  ams?: MyRoomPrinterAmsSlot[] | null;
  errors?: MyRoomPrinterError[] | null;
}

/**
 * `GET /api/internal/printer-state` のレスポンス。`room-state` と同じ流儀
 * （camelCase・`fetchedAt`・`staleThresholdMinutes`）に揃えている。
 */
export interface MyRoomPrinterSnapshot {
  /** myroom が応答を組み立てた時刻（ISO8601）。 */
  fetchedAt?: string;
  /** 鮮度切れとみなす分数。myroom 側の設定値。 */
  staleThresholdMinutes?: number;
  /** 収集が一度も届いていなければ null。 */
  printer?: MyRoomPrinter | null;
}

/** 取得できなかった理由。落ちたこと自体が状態なので、握りつぶさず返す。 */
export interface MyRoomFailure {
  source: string;
  /** 失敗の理由。**URL・ヘッダ・トークンは載せない**（HTTPステータスと例外名まで）。 */
  reason: string;
}
