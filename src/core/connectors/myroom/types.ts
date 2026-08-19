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

/** 屋外の観測値。myroom が Open-Meteo から取っているもの。 */
export interface MyRoomOutdoor {
  temperature?: number | null;
  humidity?: number | null;
  pressure?: number | null;
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

/** 取得できなかった理由。落ちたこと自体が状態なので、握りつぶさず返す。 */
export interface MyRoomFailure {
  source: string;
  /** 失敗の理由。**URL・ヘッダ・トークンは載せない**（HTTPステータスと例外名まで）。 */
  reason: string;
}
