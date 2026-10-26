/**
 * 位置共有（#715）の定数と型。契約・保存期間・停止手順は README「位置共有」。
 *
 * 保存期間と鮮度の閾値は**実装時の仮の既定値**（利用者の確認前）。変えるのはここだけ。
 */

/** 保存した位置を持ち続ける期間。測位時刻から数え、超えたら削除して座標を返さない。 */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** MCPが「新しい」と呼ぶ上限。これを超えて保存期間内なら stale（最後に測れた場所として返す）。 */
export const FRESH_MS = 15 * 60 * 1000;
/** 端末の時計ずれとして許す、測位時刻の未来方向の幅。 */
export const FUTURE_SKEW_MS = 2 * 60 * 1000;

export const LIMITS = {
  /** 受信ボディの上限（バイト）。位置1件は数百バイトで足りる。 */
  bodyBytes: 2048,
  /** 水平精度（メートル）の上限。これより粗い値は位置として意味が無いので拒否する。 */
  accuracyMaxM: 100_000,
  /** 端末トークンごとの受信回数の上限（1分あたり）。 */
  perMinute: 30,
} as const;

export interface LocationInput {
  latitude: number;
  longitude: number;
  /** 水平精度（メートル）。 */
  horizontalAccuracyM: number;
  /** 端末で測位した時刻（ISO 8601 UTC）。 */
  measuredAt: string;
}

export interface StoredLocation extends LocationInput {
  /** サーバーが受け取った時刻（ISO 8601 UTC）。 */
  receivedAt: string;
}

export interface DeviceRecord {
  /** 端末識別子。有効化のたびに発行する乱数で、端末名などは持たない。 */
  deviceId: string;
  /** 端末トークンのSHA-256（hex）。平文は保存しない。 */
  tokenHash: string;
  enabledAt: string;
}

export interface LocationFile {
  device: DeviceRecord | null;
  location: StoredLocation | null;
}

export type SubmitOutcome =
  | { ok: true; applied: true }
  | { ok: true; applied: false; reason: "duplicate" | "older" };

export type CurrentLocation =
  | { status: "unavailable"; reason: "not_enabled" | "no_location" | "expired" }
  | { status: "fresh" | "stale"; location: StoredLocation; ageSeconds: number };
