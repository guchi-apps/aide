import {
  createDaySpanEvent,
  normalizeCreateEventInput,
  readDaySpanWriteConfig,
} from "../../core/connectors/dayspan/write.ts";
import { createEventIdempotency, readEventIdempotencyKey } from "../../core/connectors/dayspan/event-idempotency.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 予定の新規作成（aide#243）。
 *
 * 起点は guchi-apps/aide-bot#184——秘書（aide-bot）から声で予定を登録できるようにしたい、
 * という要望。予定の読み取りは `aide_schedule`（aide#173）で既に届いているが、登録の道具が
 * 無かった。README「書き込みをどこまで持つか」の3条件は
 * `src/core/connectors/dayspan/write.ts` を参照。
 *
 * **このツールは作成だけ。** 変更・削除は `aide_update_event` / `aide_delete_event`（aide#493）が
 * 別に持つ（読み取り・書き込みを分けるのと同じ理由で、操作ごとに道具を分けている）。
 *
 * **`dryRun` を持つ**（#373）。登録前に「何が入るか」だけを
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
    "**書き込みを伴うツール。**" +
    "「予定を入れて」「カレンダーに登録して」と明示的に頼まれたときだけ呼ぶ。" +
    "会話に予定の話が出ただけでは呼ばない。" +
    "**登録前にタイトル・日時を復唱し、利用者に確認を取ってから呼ぶこと**" +
    "（間違えたときの修正は aide_update_event・aide_delete_event になり、手数が増えるため）。" +
    "**登録先も内容から選ぶ。** 仕事・遊びなど予定の性質が分かるときは、先に aide_schedule で既存予定を確認し、" +
    "events の calendarName と calendarId から対応するカレンダーを選んで calendarId を明示して渡すこと。" +
    "候補が返らない、または内容から選べないときは calendarId を省き、DaySpan側の既定の保存先を使うこと。" +
    "startTime・endTime は両方指定するか両方省略する（省略すると終日の予定になる）。" +
    "日をまたぐ時刻予定は date に開始日、endDate に終了日を指定して1件で作る（2件に分けない）。" +
    "作成できたら予定の url を返すので、「入れました」の案内に使うこと。" +
    "**idempotencyKey は任意だが、タイムアウトや結果不明で呼び直す可能性があるなら必ず付ける。**" +
    "1回の登録につき1つ決め、再送では**同じ値・同じ内容**で呼ぶと、予定を重複して作らず最初の結果を返す" +
    "（内容を変えるなら新しいキー。同じキーで内容が違うと idempotency_conflict）。" +
    "**タイムアウト・通信断で結果不明（outcomeUnknown: true）になったときは、予定が作られている可能性がある。**" +
    "同じキーで再送しても作成は再実行せず、同じ結果不明を返すだけ。先に aide_schedule で予定が作られたか確認し、" +
    "無いと分かったときだけ**新しいキー**で作り直すこと（確認せずに作り直すと重複する）。" +
    "**日時があやふやなまま登録したくないときは dryRun: true で呼ぶ**と、" +
    "登録せずに「何が入るか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "予定のタイトル。" },
      date: { type: "string", description: "予定の日付（YYYY-MM-DD）。" },
      endDate: {
        type: "string",
        description:
          "終了日（YYYY-MM-DD）。日をまたぐ時刻予定（宿泊・夜行移動など）で date の翌日以降を指定する。" +
          "省略すると date と同じ日に終わる。終日の予定では使えない。",
      },
      startTime: {
        type: "string",
        description: "開始時刻（HH:MM）。endTime とセットで指定する。両方省略すると終日の予定になる。",
      },
      endTime: {
        type: "string",
        description: "終了時刻（HH:MM）。同日のときは startTime より後にすること（endDate が後の日なら不問）。",
      },
      location: { type: "string", description: "場所。分からなければ省く。" },
      calendarId: {
        type: "string",
        description:
          "登録先のカレンダーID。内容に合う既存カレンダーを選べるときは、aide_schedule の events[].calendarId を渡す。" +
          "候補が無い・分類が曖昧なときは省き、DaySpan側の既定の保存先へ登録する。",
      },
      idempotencyKey: {
        type: "string",
        description:
          "登録要求を識別するキー（印字可能ASCIIの8〜191文字）。再送でも同じ値を使うと、同じ内容の予定を重複して作らない。" +
          "省略すると重複防止は働かない。",
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
    const config = await readDaySpanWriteConfig();
    if (!config) {
      return json({
        ok: false,
        reason: "未設定（AIDE_DAYSPAN_WRITE_TOKEN が無いため、DaySpanへは何も送っていません）",
      });
    }

    const keyResult = readEventIdempotencyKey(args["idempotencyKey"]);
    if ("error" in keyResult) return json({ ok: false, kind: "invalid", reason: keyResult.error });

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

    let outcome;
    let replayed = false;
    if (keyResult.key) {
      const guarded = await createEventIdempotency.run(keyResult.key, JSON.stringify(normalized.input), () =>
        createDaySpanEvent(config, normalized.input),
      );
      if ("conflict" in guarded) {
        return json({
          ok: false,
          kind: "idempotency_conflict",
          reason: "同じ idempotencyKey で内容が違います。内容を変えるなら新しい idempotencyKey を使う。",
        });
      }
      outcome = guarded.outcome;
      replayed = guarded.replay;
    } else {
      outcome = await createDaySpanEvent(config, normalized.input);
    }
    if (!outcome.ok) {
      if (outcome.outcomeUnknown) {
        return json({
          ok: false,
          kind: outcome.kind,
          outcomeUnknown: true,
          reason: outcome.reason,
          note:
            "予定が作られたか分かりません（DaySpan側で作成済みの可能性があります）。" +
            "aide_schedule で該当の予定があるか確認してください。" +
            (keyResult.key
              ? "同じ idempotencyKey での再送は作成をやり直しません。予定が無いと確認できたときだけ、新しい idempotencyKey で作り直してください。"
              : "確認せずに作り直すと重複します。"),
          ...(replayed ? { replayed: true } : {}),
        });
      }
      return json({ ok: false, kind: outcome.kind, reason: outcome.reason });
    }

    return json({
      ok: true,
      id: outcome.id,
      url: outcome.url,
      ...(replayed ? { replayed: true, note: "同じ idempotencyKey の登録済みの結果を返しました（重複して作っていません）。" } : {}),
    });
  },
};
