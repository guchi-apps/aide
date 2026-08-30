import {
  createAideBotNotice,
  normalizeNoticeInput,
  type AideBotNoticeKind,
} from "../../core/connectors/aide-bot/index.ts";
import type { Tool, ToolResult } from "../types.ts";

const noticeProperties = {
  title: { type: "string", description: "情報の短いタイトル" },
  summary: { type: "string", description: "利用者へ知らせる要約" },
  source: { type: "string", description: "情報源（例: gmail, calendar）" },
  dedupeKey: { type: "string", description: "同じ情報を重複登録しないための安定したキー" },
  priority: { type: "string", enum: ["LOW", "NORMAL", "URGENT"], description: "重要度。省略時は NORMAL" },
  url: { type: ["string", "null"], description: "元データへのリンク" },
  recommendedAction: { type: "string", description: "推奨アクション。無ければ空文字" },
  showAt: { type: ["string", "null"], description: "表示開始時刻（ISO 8601）" },
  expiresAt: { type: ["string", "null"], description: "表示期限（ISO 8601）" },
};

function definition(name: string, description: string): Tool {
  const kind = name === "aide_create_notification" ? "schedule" : name === "aide_create_task_candidate" ? "task" : "daily-brief";
  return {
    name,
    description: `${description} 明示的に登録を依頼されたときだけ呼ぶ書き込みツール。` +
      "登録先の利用者はAIDEの接続設定から決まり、引数にメールアドレスを指定しない。" +
      "同じ用件には毎回同じ dedupeKey を使うこと。",
    inputSchema: {
      type: "object",
      properties: noticeProperties,
      required: ["title", "summary", "source", "dedupeKey"],
      additionalProperties: false,
    },
    handler: (args) => handleNotice(args, kind),
  };
}

async function handleNotice(args: Record<string, unknown>, kind: AideBotNoticeKind): Promise<ToolResult> {
  const normalized = normalizeNoticeInput(args, kind);
  if (!normalized.ok) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, reason: normalized.reason }, null, 2) }] };
  }
  const outcome = await createAideBotNotice(normalized.input);
  return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }] };
}

export const createNotificationTool = definition(
  "aide_create_notification",
  "AIDE Botへ、利用者に知らせる情報を登録します。",
);

export const createTaskCandidateTool = definition(
  "aide_create_task_candidate",
  "AIDE Botへ、対応が必要なタスク候補を登録します。",
);

export const saveDailyBriefTool = definition(
  "aide_save_daily_brief",
  "AIDE Botへ、その日のブリーフを登録します。",
);
