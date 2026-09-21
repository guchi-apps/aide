import {
  createDaySpanEvent,
  normalizeCreateEventInput,
  readDaySpanWriteConfig,
} from "../../core/connectors/dayspan/write.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 予定の新規作成（aide#243）。
 *
 * 起点は guchi-apps/aide-bot#184——秘書（aide-bot）から声で予定を登録できるようにしたい、
 * という要望。予定の読み取りは `aide_schedule`（aide#173）で既に届いているが、登録の道具が
 * 無かった。README「書き込みをどこまで持つか」の3条件は
 * `src/core/connectors/dayspan/write.ts` を参照。
 *
 * **作成だけ。編集・削除は持たない。** 一度登録した予定を動かす・消すにはDaySpanの画面から
 * 行う必要がある（`aide_zaim_payment` と同じ理由——取り消せない操作をサーバー間経路へ出さない）。
 *
 * **`dryRun` を持つ**（#373）。この経路から取り消せないので、登録前に「何が入るか」だけを
 * 確かめられるようにしてある。検査は本番と同じものを通し、DaySpanへは送らない。
 */
function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・入力不正・DaySpan側のエラーは「エラー」ではなく状態。isError にすると
    // Claudeが同じ内容で再試行し、往復が増えるだけになる（他の書き込みツールと同じ考え方）。
    isError: false,
  };
}

export const createEventTool: Tool = {
  name: "aide_create_event",
  description:
    "予定を1件、Googleカレンダー（DaySpan経由）へ新規作成する。" +
    "**書き込みを伴うツール。この経路から取り消し・修正はできない。**" +
    "「予定を入れて」「カレンダーに登録して」と明示的に頼まれたときだけ呼ぶ。" +
    "会話に予定の話が出ただけでは呼ばない。" +
    "**登録前にタイトル・日時を復唱し、利用者に確認を取ってから呼ぶこと**" +
    "（間違えてもこの経路からは取り消せないため）。" +
    "startTime・endTime は両方指定するか両方省略する（省略すると終日の予定になる）。" +
    "作成できたら予定の url を返すので、「入れました」の案内に使うこと。" +
    "**日時があやふやなまま登録したくないときは dryRun: true で呼ぶ**と、" +
    "登録せずに「何が入るか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "予定のタイトル。" },
      date: { type: "string", description: "予定の日付（YYYY-MM-DD）。" },
      startTime: {
        type: "string",
        description: "開始時刻（HH:MM）。endTime とセットで指定する。両方省略すると終日の予定になる。",
      },
      endTime: {
        type: "string",
        description: "終了時刻（HH:MM）。startTime より後にすること。",
      },
      location: { type: "string", description: "場所。分からなければ省く。" },
      calendarId: {
        type: "string",
        description: "登録先のカレンダーID。省略するとDaySpan側の既定の保存先へ登録する。",
      },
      dryRun: {
        type: "boolean",
        description:
          "**登録せずに、何が登録されるかだけを返す。** 入力の検査は本番と同じものを通すため、" +
          "日付・時刻の形が誤っていればここで分かる。" +
          "利用者に内容を確かめてもらってから、dryRun を外して呼び直す。",
      },
    },
    required: ["title", "date"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const config = readDaySpanWriteConfig();
    if (!config) {
      return json({
        ok: false,
        reason: "未設定（AIDE_DAYSPAN_WRITE_TOKEN が無いため、DaySpanへは何も送っていません）",
      });
    }

    const normalized = normalizeCreateEventInput(args);
    if ("error" in normalized) return json({ ok: false, kind: "invalid", reason: normalized.error });

    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        // 正規化後の値を返す。呼び出し側の綴りではなく、実際に送られる内容を見せる。
        wouldCreate: normalized.input,
        note: "登録していません。この内容でよければ dryRun を外して呼び直してください。",
      });
    }

    const outcome = await createDaySpanEvent(config, normalized.input);
    if (!outcome.ok) return json({ ok: false, kind: outcome.kind, reason: outcome.reason });

    return json({ ok: true, id: outcome.id, url: outcome.url });
  },
};
