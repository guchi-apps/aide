import { FUTURE_SKEW_MS, LIMITS, RETENTION_MS, type LocationInput } from "./types.ts";

const ALLOWED = new Set(["latitude", "longitude", "horizontalAccuracyM", "measuredAt"]);
/** タイムゾーン付きのISO 8601だけを受ける（`Date.parse`は無印を端末ローカルとして解釈するため）。 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export type ParseResult = { ok: true; input: LocationInput } | { ok: false; reason: string };

/** 値そのものを理由に含めない（ログ・応答へ座標を出さない）。 */
export function parseLocation(raw: unknown, now: Date): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "本文はJSONオブジェクトで送ってください" };
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return { ok: false, reason: `未対応の項目があります: ${key.slice(0, 40)}` };
  }
  const { latitude, longitude, horizontalAccuracyM, measuredAt } = body;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, reason: "latitude は -90〜90 の数値で指定してください" };
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, reason: "longitude は -180〜180 の数値で指定してください" };
  }
  if (
    typeof horizontalAccuracyM !== "number" ||
    !Number.isFinite(horizontalAccuracyM) ||
    horizontalAccuracyM < 0 ||
    horizontalAccuracyM > LIMITS.accuracyMaxM
  ) {
    return { ok: false, reason: `horizontalAccuracyM は 0〜${LIMITS.accuracyMaxM} の数値（メートル）で指定してください` };
  }
  if (typeof measuredAt !== "string" || !ISO_WITH_ZONE.test(measuredAt) || Number.isNaN(Date.parse(measuredAt))) {
    return { ok: false, reason: "measuredAt はタイムゾーン付きのISO 8601で指定してください" };
  }
  const at = Date.parse(measuredAt);
  if (at > now.getTime() + FUTURE_SKEW_MS) return { ok: false, reason: "measuredAt が未来です" };
  if (at < now.getTime() - RETENTION_MS) return { ok: false, reason: "measuredAt が古すぎます" };
  return { ok: true, input: { latitude, longitude, horizontalAccuracyM, measuredAt: new Date(at).toISOString() } };
}
