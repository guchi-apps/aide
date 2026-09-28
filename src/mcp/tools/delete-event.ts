import {
  deleteDaySpanEvent,
  normalizeDeleteEventInput,
  readDaySpanWriteConfig,
} from "../../core/connectors/dayspan/write.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 既存の予定の取り消し（aide#493）。起点は guchi-apps/aide-bot#372。
 *
 * **この経路から元に戻せない。** 誤操作の影響を抑えるため、対象は `id`・`calendarId` に加えて
 * **予定の現在のタイトル**で名指しさせる。DaySpan側がタイトルの一致を確かめ、違えば `409` で
 * 何も消さない（IDの取り違え・復唱と違う予定への操作を止める）。消せるのは1回分だけ。
 *
 * **`dryRun` を持つ。** 検査は本番と同じものを通し、DaySpanへは送らない。
 */
function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 状態として返す（isError にするとClaudeが同じ内容で再試行し、往復が増えるだけになる）。
    isError: false,
  };
}

export const deleteEventTool: Tool = {
  name: "aide_delete_event",
  description:
    "既存の予定を1件削除する（Googleカレンダー・DaySpan経由）。**書き込みを伴うツール。この経路から元に戻せない。**" +
    "「予定を消して」「キャンセルして」と明示的に頼まれたときだけ呼ぶ。" +
    "対象は **aide_schedule が返した予定の id・calendarId・title をそのまま** 渡して指す" +
    "（先に aide_schedule で予定を引くこと。IDを推測しない）。" +
    "**削除前に「どの予定（日時・タイトル）を消すか」を復唱し、利用者に確認を取ってから呼ぶこと。**" +
    "title には予定の**現在のタイトル**を渡す。DaySpan側が一致を確かめ、違えば何も消さずに" +
    "kind: conflict と currentTitle を返す（その場合は利用者へ伝えて確かめ直す）。" +
    "消せるのは1回分だけで、繰り返しの元の予定（シリーズ全体）は消せない。" +
    "「中止になった」だけの記録なら削除ではなく、DaySpanの画面で中止にする。" +
    "**迷うときは dryRun: true で呼ぶ**と、削除せずに「何を消すか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "削除する予定の id（aide_schedule の events[].id）。" },
      calendarId: {
        type: "string",
        description: "その予定のあるカレンダーID（aide_schedule の events[].calendarId）。",
      },
      title: {
        type: "string",
        description: "削除する予定の現在のタイトル（aide_schedule の events[].title）。一致しなければ消えない。",
      },
      dryRun: {
        type: "boolean",
        description:
          "**削除せずに、何を消すかだけを返す。** 入力の検査は本番と同じものを通す。" +
          "利用者に内容を確かめてもらってから、dryRun を外して呼び直す。",
      },
    },
    required: ["eventId", "calendarId", "title"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const config = await readDaySpanWriteConfig();
    if (!config) {
      return json({
        ok: false,
        reason: "未設定（AIDE_DAYSPAN_WRITE_TOKEN が無いため、DaySpanへは何も送っていません）",
      });
    }

    const normalized = normalizeDeleteEventInput(args);
    if ("error" in normalized) return json({ ok: false, kind: "invalid", reason: normalized.error });

    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        wouldDelete: normalized.input,
        note: "削除していません。この内容でよければ dryRun を外して呼び直してください。",
      });
    }

    const outcome = await deleteDaySpanEvent(config, normalized.input);
    if (!outcome.ok) {
      return json({
        ok: false,
        kind: outcome.kind,
        reason: outcome.reason,
        ...(outcome.currentTitle === undefined ? {} : { currentTitle: outcome.currentTitle }),
      });
    }
    return json({ ok: true, deleted: { id: normalized.input.eventId, title: normalized.input.title } });
  },
};
