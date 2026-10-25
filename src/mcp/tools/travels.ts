import {
  createTravel,
  getTravel,
  normalizeCreateTravelInput,
  TRAVEL_MODES,
  type TravelApiResult,
  type TravelFailureKind,
} from "../../core/connectors/dayspan/travels.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * YoteiFlowの「移動」（TravelPlan）の作成と読戻し（aide#707）。
 *
 * **通常のGoogleカレンダー予定は作らない。** 予定は `aide_create_event` の役割で、ここは移動専用。
 * 既存の予定・推定移動は変更も削除もしない（作成専用。更新・削除の口を持たない）。
 * 読み取り（`travel:read`）と書き込み（`travel:write`）はOAuth scopeも別。
 * 契約の正本は dayspan の docs/internal-api.md。
 */
const TRAVEL_READ = ["travel:read"] as const;
const TRAVEL_WRITE = ["travel:write"] as const;

function json(payload: unknown): ToolResult {
  // 状態は isError にしない（Claudeが同じ内容で作り直す再試行を避ける。他の書込ツールと同じ）。
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

const NOT_CONFIGURED = {
  ok: false,
  reason: "未設定（YoteiFlowの鍵または AIDE_DAYSPAN_TARGET_EMAIL が無いため、何も送っていません）",
};

const NEXT: Record<TravelFailureKind, string> = {
  unauthorized: "認証が拒否されました。何も登録されていません。鍵の設定を確認してください（再送しても同じです）。",
  invalid: "入力が拒否されました（未登録）。内容を直して、同じ idempotencyKey のまま呼び直せます。",
  not_found: "該当の移動がありません。",
  duplicate:
    "同じ内容の移動が既にあります（未登録）。existingTravelId を aide_get_travel で確認し、同じ移動なら何もしない。" +
    "別の移動として作る場合だけ、利用者の確認後に confirmDuplicate: true を付けて呼び直す。",
  idempotency_conflict: "同じ idempotencyKey で内容が違います。内容を変えるなら新しい idempotencyKey を使う。",
  in_progress: "同じ idempotencyKey の処理が実行中です。retryAfterSeconds 後に**同じ idempotencyKey・同じ内容**で再送する。",
  unavailable: "YoteiFlow側が移動APIを受け付けていません（未登録）。時間を置いて再試行する。",
  result_unknown:
    "**登録されたか不明です。** 新しい idempotencyKey で作り直さず、**同じ idempotencyKey・同じ内容**で再送する" +
    "（保存済みなら二重には作られない）。再送後は aide_get_travel か aide_schedule の対象日で確認する。",
};

function failure(result: Extract<TravelApiResult, { ok: false }>): ToolResult {
  const body = result.body ?? {};
  const pick = ["error", "message", "executed", "existingTravelId", "retryAfterSeconds"];
  const detail = Object.fromEntries(pick.filter((k) => k in body).map((k) => [k, body[k]]));
  return json({
    ok: false,
    kind: result.kind,
    reason: result.reason,
    ...detail,
    // 結果不明は「未登録」と言い切らない。
    ...(result.kind === "result_unknown" ? { executed: "unknown" } : {}),
    next: NEXT[result.kind],
  });
}

export const createTravelTool: Tool = {
  name: "aide_create_travel",
  requiredScopes: TRAVEL_WRITE,
  description:
    "航空便などの移動を、YoteiFlowの「移動」（TravelPlan）として1件登録する。**書き込みを伴うツール。**" +
    "通常のGoogleカレンダー予定は作らない（予定は aide_create_event）。既存の予定・推定移動は変更・削除しない。" +
    "「移動として登録して」と明示的に頼まれたときだけ呼ぶ。会話に移動の話が出ただけでは呼ばない。" +
    "**呼ぶ前に、先に aide_schedule で同日の既存の移動・予定との重複を確認し、" +
    "出発地・目的地・交通手段・出発/到着日時（タイムゾーン）を復唱して利用者の確認を取ること。**" +
    "航空便の便名・座席・予約番号は note に入れてよい（応答や会話の要約に再掲しない）。" +
    "交通手段は mode（" + TRAVEL_MODES.join("/") + "）。航空便は鉄道・公共交通の推定移動と取り違えないよう、" +
    "該当する値が無いときは OTHER にして note に便名を書く。" +
    "**idempotencyKey は必須。** 1回の登録につき1つ決め、タイムアウト・結果不明・処理中のときは " +
    "**同じ値・同じ内容**で再送する（作り直さない）。内容が変わるときだけ新しい値にする。" +
    "応答は saved（保存成否）と googleExport（Google書き出しの成否）が別。書き出しが failed でも移動は保存済みで、" +
    "同じ idempotencyKey で再送すると書き出しだけやり直す。" +
    "**ツール応答だけで成功と断定せず**、travelId を aide_get_travel で読み戻すか、aide_schedule の対象日で確認すること。" +
    "確認なしで登録したくないときは dryRun: true（送らずに正規化後の内容だけ返す）。",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "string", description: "出発地（例: 伊丹空港）。" },
      destination: { type: "string", description: "目的地（例: 羽田空港）。" },
      via: { type: "array", items: { type: "string" }, description: "経由地（10件まで）。省略可。" },
      mode: { type: "string", enum: [...TRAVEL_MODES], description: "交通手段。航空便など該当が無いものは OTHER。" },
      departAt: { type: "string", description: "出発日時（ISO 8601、タイムゾーン必須。例: 2026-11-01T09:30:00+09:00）。" },
      arriveAt: { type: "string", description: "到着日時（同形式。出発より後）。" },
      note: { type: "string", description: "任意メモ。便名・座席・予約番号など。" },
      idempotencyKey: {
        type: "string",
        description: "再送しても二重登録されないためのキー（8〜191文字の印字可能ASCII）。再送時は同じ値を使う。",
      },
      confirmDuplicate: {
        type: "boolean",
        description: "同一内容の移動が既にあっても別の移動として作る。aide が duplicate を返し、利用者が別の移動だと確認したときだけ true。",
      },
      dryRun: { type: "boolean", description: "**登録せず**、検査して送る内容だけ返す。内容確認後に dryRun を外して呼び直す。" },
    },
    required: ["origin", "destination", "mode", "departAt", "arriveAt", "idempotencyKey"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const normalized = normalizeCreateTravelInput(args);
    if ("error" in normalized) return json({ ok: false, kind: "invalid", reason: normalized.error });

    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        wouldCreate: normalized.input,
        note: "登録していません。同日の既存の移動・予定を aide_schedule で確認し、利用者がよければ dryRun を外して呼び直してください。",
      });
    }

    const outcome = await createTravel(normalized.input, normalized.idempotencyKey);
    if (outcome === "unconfigured") return json(NOT_CONFIGURED);
    if (!outcome.ok) return failure(outcome);

    const exportStatus = (outcome.body["googleExport"] as { status?: unknown } | undefined)?.status;
    return json({
      ok: true,
      ...outcome.body,
      next:
        (exportStatus === "failed"
          ? "移動は保存済みですが、Googleカレンダーへの書き出しに失敗しています。同じ idempotencyKey・同じ内容で再送すると書き出しだけやり直します。"
          : "") +
        "成功を断定せず、travelId を aide_get_travel で読み戻すか aide_schedule の対象日で確認してください。",
    });
  },
};

export const getTravelTool: Tool = {
  name: "aide_get_travel",
  requiredScopes: TRAVEL_READ,
  description:
    "YoteiFlowの移動（TravelPlan）を travelId で1件読み戻す読み取りツール。" +
    "aide_create_travel の登録結果の確認に使う。出発地・目的地・交通手段・日時・メモとGoogle書き出し状態（googleExport）を返す。" +
    "aide_schedule の travels と同じ正本。変更はしない。",
  inputSchema: {
    type: "object",
    properties: { travelId: { type: "string", description: "aide_create_travel が返した travelId。" } },
    required: ["travelId"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = typeof args["travelId"] === "string" ? args["travelId"].trim() : "";
    if (!id || id.length > 200) return json({ ok: false, kind: "invalid", reason: "travelId を指定してください" });
    const outcome = await getTravel(id);
    if (outcome === "unconfigured") return json(NOT_CONFIGURED);
    if (!outcome.ok) return failure(outcome);
    return json({ ok: true, ...outcome.body });
  },
};
