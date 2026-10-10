import { workReportStore, type WorkReportStore } from "../../core/work-reports/store.ts";
import { LIMITS, STALE_AFTER_MS, WORK_STATUSES } from "../../core/work-reports/types.ts";
import { parseWorkReport } from "../../core/work-reports/validate.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * dotの作業報告（#609）。契約・順序規則・保存方針は `docs/work-reports.md`。
 *
 * **読み取りと書き込みは別ツール・別scope**（クライアント側で読み取りを「常に許可」にしても
 * 書き込みまで素通しにならない）。所有者・報告元は引数で受け取らず、認可済みトークンから決める。
 */

export const WORK_REPORTS_READ = ["work-reports:read"] as const;
export const WORK_REPORTS_WRITE = ["work-reports:write"] as const;

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function createReportWorkTool(store: () => WorkReportStore = workReportStore, clock: () => Date = () => new Date()): Tool {
  return {
    name: "aide_report_work",
    description:
      "dotが利用者向けの作業の節目（開始・実行中・待機・完了・失敗・取消）をAIDEへ報告する書き込みツール。" +
      "利用者が見て意味のある節目だけを、明示的に報告するときに呼ぶ（全活動の自動報告・会話やメールの原文・認証情報は送らない）。" +
      "同じ作業には毎回同じ workId を使い、報告ごとに新しい eventId と、1ずつ増やす version を付ける。" +
      "応答に saved:true が無ければ保存されていないので、応答が失われたときは同じ eventId・同じ内容で再送してよい（二重登録されない）。" +
      "同じ eventId で内容を変えると競合になる。完了・失敗・取消の後は同じ workId に報告できない。" +
      "所有者・報告元は引数に指定せず、認可済みの接続から決まる。",
    requiredScopes: WORK_REPORTS_WRITE,
    inputSchema: {
      type: "object",
      properties: {
        workId: { type: "string", description: `作業を表す安定したID（英数字と . _ : -、${LIMITS.idLength}文字以内）` },
        eventId: { type: "string", description: "この報告1回ごとに新しく付けるID。再送のときだけ同じ値を使う" },
        version: { type: "integer", minimum: 1, description: "作業ごとの更新版。報告のたびに1以上で増やす" },
        status: { type: "string", enum: [...WORK_STATUSES], description: "started=開始 / running=実行中 / waiting=待機 / completed=完了 / failed=失敗 / cancelled=取消" },
        occurredAt: { type: "string", description: "発生時刻（タイムゾーン付きISO 8601）" },
        title: { type: "string", description: `作業名（${LIMITS.title}文字以内の1行）。最初の報告は必須、以降は省略すると前の値を保つ` },
        progress: { type: "string", description: `短い進捗（${LIMITS.progress}文字以内の1行）。省略すると空になる` },
        waitReason: { type: "string", description: `待機理由（waiting のときだけ。${LIMITS.waitReason}文字以内）` },
        resultSummary: { type: "string", description: `結果の要約（完了・失敗・取消のときだけ。${LIMITS.resultSummary}文字以内）` },
        links: {
          type: "array",
          maxItems: LIMITS.links,
          items: { type: "string" },
          description: `関連リンク（${LIMITS.links}件まで。https のURLのみ・クエリや認証情報を含まないもの）`,
        },
      },
      required: ["workId", "eventId", "version", "status", "occurredAt"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const parsed = parseWorkReport(args, clock());
      if (!parsed.ok) return result({ ok: false, kind: "invalid", reason: parsed.reason }, true);
      const reporter = ctx.clientId;
      if (!reporter) return result({ ok: false, kind: "unauthorized", reason: "報告元を認可済みの接続から特定できません" }, true);
      try {
        const outcome = await store().submit(parsed.input, reporter);
        // 競合・遷移エラーは再送では直らないのでエラーとして返す。stale は適用されていないが失敗ではない。
        return result(outcome, !outcome.ok);
      } catch {
        // 内容（報告の本文）をエラーに含めない。保存に失敗したので saved:false 相当で再送を促す。
        return result({ ok: false, kind: "storage_error", saved: false, reason: "保存に失敗しました。同じ eventId・同じ内容で再送してください" }, true);
      }
    },
  };
}

export function createWorkReportsTool(store: () => WorkReportStore = workReportStore): Tool {
  return {
    name: "aide_work_reports",
    description:
      "AIDEに保存済みのdotの作業報告を読み戻す読み取りツール。作業ID・適用版・状態・結果・鮮度を返す。" +
      "reportState が none なら報告が1件も無い。freshness が stale の作業は更新が途絶えているだけで、完了・失敗ではない。" +
      `workId を指定するとその作業だけを返す。limit の上限は${LIMITS.listMax}件（既定${LIMITS.listDefault}件）。` +
      `更新が${STALE_AFTER_MS / 60_000}分無い進行中の作業を stale とする。`,
    requiredScopes: WORK_REPORTS_READ,
    inputSchema: {
      type: "object",
      properties: {
        workId: { type: "string", description: "特定の作業だけを読むときに指定" },
        limit: { type: "integer", minimum: 1, maximum: LIMITS.listMax, description: `返す件数。既定${LIMITS.listDefault}、上限${LIMITS.listMax}` },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const workId = args["workId"];
      const limit = args["limit"];
      if (workId !== undefined && (typeof workId !== "string" || !workId || workId.length > LIMITS.idLength)) {
        return result({ ok: false, kind: "invalid", reason: "workId が不正です" }, true);
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax)) {
        return result({ ok: false, kind: "invalid", reason: `limit は1以上${LIMITS.listMax}以下の整数で指定してください` }, true);
      }
      try {
        return result(await store().list({ ...(limit !== undefined ? { limit } : {}), ...(workId !== undefined ? { workId } : {}) }));
      } catch {
        // 取得失敗。「空の一覧」と取り違えないよう、必ずエラーで返す。
        return result({ ok: false, kind: "read_failed", reason: "保存済みの作業報告を読めませんでした（空ではなく取得失敗）" }, true);
      }
    },
  };
}

export const reportWorkTool = createReportWorkTool();
export const workReportsTool = createWorkReportsTool();
