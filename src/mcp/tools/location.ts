import { locationStore, type LocationStore } from "../../core/location/store.ts";
import { FRESH_MS, RETENTION_MS } from "../../core/location/types.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 現在地の最終測位（#715）。契約・保存期間・停止手順は README「位置共有」。
 *
 * **「今いる場所」ではなく「最後に測定された位置」を返す。** 端末が送らない間は更新されないため、
 * 経過時間と状態（fresh / stale / unavailable）を必ず添える。未受信・停止・期限切れは座標を返さない。
 */

export const LOCATION_READ = ["location:read"] as const;

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const REASONS = {
  not_enabled: "位置共有がオフです（端末が共有を有効にしていません）",
  no_location: "位置共有はオンですが、まだ位置を受信していません",
  expired: `最後の位置が保存期間（${RETENTION_MS / 3_600_000}時間）を過ぎたため削除しました`,
} as const;

export function createCurrentLocationTool(store: () => LocationStore = locationStore, clock: () => Date = () => new Date()): Tool {
  return {
    name: "aide_current_location",
    description:
      "利用者のiPhone（AIDE iOS）が最後に共有した位置を読む読み取りツール。「現在地は？」と聞かれたときに呼ぶ。" +
      "返すのはリアルタイムの現在地ではなく**最後に測定された位置**で、端末が送らない間は更新されない。" +
      "status が fresh のときだけ「今いる場所」に近い値として扱い、stale は古い値なので必ず経過時間を添えて伝える。" +
      "unavailable（未共有・未受信・期限切れ）のときは座標が無いので、場所を推測せず理由をそのまま伝える。" +
      `fresh は測位から${FRESH_MS / 60_000}分以内。外部の地名変換は行わない。`,
    requiredScopes: LOCATION_READ,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      try {
        const current = await store().current(clock());
        if (current.status === "unavailable") {
          return result({ status: "unavailable", reason: current.reason, message: REASONS[current.reason] });
        }
        const { location, ageSeconds } = current;
        return result({
          status: current.status,
          latitude: location.latitude,
          longitude: location.longitude,
          horizontalAccuracyM: location.horizontalAccuracyM,
          measuredAt: location.measuredAt,
          receivedAt: location.receivedAt,
          ageSeconds,
          message:
            current.status === "fresh"
              ? "最後に測定された位置です（端末が送った時点の値で、リアルタイムではありません）"
              : "古い位置です。今いる場所ではない可能性があります。経過時間を添えて伝えてください",
        });
      } catch {
        // 取得失敗を「未共有」と取り違えないようエラーで返す。内容（座標）は含めない。
        return result({ ok: false, kind: "read_failed", reason: "保存済みの位置を読めませんでした（未共有ではなく取得失敗）" }, true);
      }
    },
  };
}

export const currentLocationTool = createCurrentLocationTool();
