import {
  normalizeUpdateEventInput,
  readDaySpanWriteConfig,
  updateDaySpanEvent,
} from "../../core/connectors/dayspan/write.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 既存の予定の変更（aide#493）。起点は guchi-apps/aide-bot#372。
 *
 * `aide_create_event`（aide#243）の続き。対象は `aide_schedule` が返した予定の `id` と
 * `calendarId` で必ず名指しさせる。**送った項目だけが変わる**（省略は「変えない」）。
 * 繰り返しの親（シリーズ全体）はDaySpan側が `409` で断る。日をまたぐ時刻予定は
 * `date` と `endDate` を指定して変更する。
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

export const updateEventTool: Tool = {
  name: "aide_update_event",
  description:
    "既存の予定を1件変更する（タイトル・日付・時刻・場所・仮/確定）。**書き込みを伴うツール。**" +
    "「予定を動かして」「時間を変更して」と明示的に頼まれたときだけ呼ぶ。" +
    "対象は **aide_schedule が返した予定の id と calendarId をそのまま** eventId・calendarId に渡して指す" +
    "（先に aide_schedule で予定を引くこと。IDを推測しない）。" +
    "**変更前に「どの予定を、どう変えるか」を復唱し、利用者に確認を取ってから呼ぶこと。**" +
    "送った項目だけが変わり、省いた項目は今のまま。startTime・endTime は両方指定する。" +
    "日をまたぐ時刻予定は date に開始日、endDate に終了日を指定する。" +
    "終日にするなら allDay: true（時刻とは同時に指定しない）、終日から時刻ありへ戻すなら startTime・endTime を指定する。" +
    "場所を消すなら location に空文字を渡す。" +
    "繰り返しの元の予定（シリーズ全体）は変更できない（1回分の id を指定する）。" +
    "予定を消すのは aide_delete_event。" +
    "**内容があやふやなときは dryRun: true で呼ぶ**と、変更せずに「何を送るか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "変更する予定の id（aide_schedule の events[].id）。" },
      calendarId: {
        type: "string",
        description: "その予定のあるカレンダーID（aide_schedule の events[].calendarId）。",
      },
      title: { type: "string", description: "新しいタイトル。変えないなら省く。" },
      date: { type: "string", description: "新しい日付（YYYY-MM-DD）。変えないなら省く。" },
      endDate: {
        type: "string",
        description: "時刻ありの予定の新しい終了日（YYYY-MM-DD）。日をまたぐときに date とセットで指定する。",
      },
      startTime: { type: "string", description: "新しい開始時刻（HH:MM）。endTime とセットで指定する。" },
      endTime: { type: "string", description: "新しい終了時刻（HH:MM）。同日のときは startTime より後にすること。" },
      allDay: {
        type: "boolean",
        description: "true で終日の予定へ変える（startTime・endTime と同時には指定しない）。",
      },
      location: { type: "string", description: "新しい場所。空文字で場所を消す。変えないなら省く。" },
      tentative: { type: "boolean", description: "true で仮の予定、false で確定した予定にする。" },
      dryRun: {
        type: "boolean",
        description:
          "**変更せずに、何を送るかだけを返す。** 入力の検査は本番と同じものを通す。" +
          "利用者に内容を確かめてもらってから、dryRun を外して呼び直す。",
      },
    },
    required: ["eventId", "calendarId"],
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

    const normalized = normalizeUpdateEventInput(args);
    if ("error" in normalized) return json({ ok: false, kind: "invalid", reason: normalized.error });

    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        wouldUpdate: normalized.input,
        note: "変更していません。この内容でよければ dryRun を外して呼び直してください。",
      });
    }

    const outcome = await updateDaySpanEvent(config, normalized.input);
    if (!outcome.ok) {
      return json({ ok: false, kind: outcome.kind, reason: outcome.reason });
    }
    return json({ ok: true, id: outcome.id, url: outcome.url });
  },
};
