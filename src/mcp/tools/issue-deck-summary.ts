import {
  fetchDevelopmentSummary,
  ITEMS_PATH,
  readDevelopmentSummaryConfig,
  SUMMARY_PATH,
} from "../../core/connectors/issue-deck/development-summary.ts";
import type { SummaryQuery } from "../../core/connectors/issue-deck/development-summary.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * IssueDeck の進捗・要対応・予約・PR・本番反映の読み取り（#569）。
 *
 * **集計はIssueDeck側の責務で、AIDEは中継するだけ**（再集計しない。件数の定義は画面と同じ）。
 * 読み取り専用で、ジョブ起動・予約変更・既読化・AI利用枠の消費は起こさない。
 *
 * 2本に分けている。サマリーに全本文・全コメントを載せて肥大化させないため、
 * 件数と上位だけの `aide_issue_deck_summary` と、一覧を取る `aide_issue_deck_items` を別にする。
 */

function json(payload: unknown): ToolResult {
  // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

const NOT_CONFIGURED = {
  status: "not_configured",
  reason: "IssueDeckの開発サマリーが未設定です（AIDE_ISSUE_DECK_URL と、issue-deck の共有トークン ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN が要ります）。件数は不明で、0件ではありません。",
};

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CATEGORY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;
const MAX_LIMIT = 100;

/** 引数の検査。通れば IssueDeck へ渡すクエリ、通らなければ利用者へ返せる理由。 */
export function buildQuery(args: Record<string, unknown>, withItems: boolean): SummaryQuery | string {
  const query: SummaryQuery = {};

  const repo = args["repo"];
  if (repo !== undefined) {
    if (typeof repo !== "string" || !REPO_PATTERN.test(repo.trim())) return "repo は owner/repo 形式で指定してください（例: guchi-apps/aide）";
    query["repositoryFullName"] = repo.trim();
  }

  for (const key of ["from", "to"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
      return `${key} はISO 8601の日時で指定してください（例: 2026-10-05T00:00:00+09:00）`;
    }
    query[key] = value;
  }
  if (typeof query["from"] === "string" && typeof query["to"] === "string" && Date.parse(query["from"]) >= Date.parse(query["to"])) {
    return "from は to より前にしてください（半開区間 [from, to)）";
  }

  const timezone = args["timezone"];
  if (timezone !== undefined) {
    if (typeof timezone !== "string" || !TIMEZONE_PATTERN.test(timezone)) return "timezone はIANA形式で指定してください（例: Asia/Tokyo）";
    query["timezone"] = timezone;
  }

  if (withItems) {
    const category = args["category"];
    if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) return "category は必須です（aide_issue_deck_summary が返したカテゴリのキーを指定）";
    query["category"] = category;

    const cursor = args["cursor"];
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !cursor || cursor.length > 512) return "cursor は前回の応答の nextCursor をそのまま指定してください";
      query["cursor"] = cursor;
    }
    const limit = args["limit"];
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit は1〜${MAX_LIMIT}の整数で指定してください`;
      query["limit"] = limit;
    }
  }
  return query;
}

async function relay(args: Record<string, unknown>, path: string, withItems: boolean): Promise<ToolResult> {
  const query = buildQuery(args, withItems);
  if (typeof query === "string") return json({ status: "invalid_arguments", reason: query });

  const config = await readDevelopmentSummaryConfig();
  if (!config) return json(NOT_CONFIGURED);

  const outcome = await fetchDevelopmentSummary(config, path, query);
  if (outcome.status !== "ok") {
    return json({
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      reason: outcome.reason,
      note: "取得できていないため件数は不明です（0件・問題なしではありません）。",
    });
  }
  // IssueDeckの応答は加工せず、そのまま `data` に入れる（schemaVersion・complete/stale/unavailable・対象期間を含む）。
  return json({ status: "ok", data: outcome.data });
}

const SCOPE_PROPERTIES = {
  repo: {
    type: "string",
    description: "リポジトリを1つに絞る（owner/repo。例: guchi-apps/aide）。省略すると全体とリポジトリ別内訳を返す。",
  },
  from: { type: "string", description: "完了の集計期間の開始（ISO 8601、含む）。省略時は直近7日。" },
  to: { type: "string", description: "完了の集計期間の終了（ISO 8601、含まない）。省略時は現在。" },
  timezone: { type: "string", description: "期間の解釈に使うタイムゾーン（IANA）。既定は Asia/Tokyo。" },
} as const;

export const issueDeckSummaryTool: Tool = {
  name: "aide_issue_deck_summary",
  description:
    "IssueDeck（Issue・PR・予約・本番反映の進捗管理）の**全体サマリーを1回で返す。読み取り専用**で、実行・予約・既読・AI利用枠には触れない。" +
    "「開発全体の状況は？」「未着手・実行中・予約待ちは何件？」「自分の対応が必要なものは？」「今週完了したものは？」に使う。" +
    "全体合計・リポジトリ別内訳・要対応の上位10件を返す（未着手／実行中と工程別／予約待ち／確認待ち／手作業・前提待ち／問題・停止／" +
    "PRのレビュー・修正・マージ待ち・CI失敗・コンフリクト／本番反映待ちとデプロイ状態／指定期間の完了）。" +
    "件数はIssue・PR・ジョブ・予約・デプロイの単位が別で、IssueDeckの集計をそのまま中継する（AIDEでは再集計しない）。" +
    "応答の schemaVersion・complete/stale/unavailable・解決済みの対象期間を必ず確かめ、取得できなかった項目を0件と読まないこと。" +
    "一覧の続きは aide_issue_deck_items で取る。" +
    "**GitHub由来のリリース・コミット・CI・ラベルは aide_dev_status / aide_repo_status の役割**で、このツールとは別（IssueDeckの進捗・予約・要対応はこちら）。",
  inputSchema: {
    type: "object",
    properties: SCOPE_PROPERTIES,
    additionalProperties: false,
  },
  handler: (args) => relay(args, SUMMARY_PATH, false),
};

export const issueDeckItemsTool: Tool = {
  name: "aide_issue_deck_items",
  description:
    "IssueDeckのカテゴリ別の**詳細一覧**を返す。読み取り専用。aide_issue_deck_summary が返したカテゴリを指定し、" +
    "タイトル・リンク・理由・次に必要な行動（実行はしない）をページ単位で取る。" +
    "総件数は返却件数と別に維持され、`nextCursor` を cursor に渡すと続きを欠落・重複なく取れる（truncated が true の間は続きがある）。" +
    "「予約待ちの詳細」「確認待ちの一覧」「今週完了したもの」などに使う。",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "取得するカテゴリのキー（aide_issue_deck_summary の応答に載っているもの。例: 予約待ち・確認待ち・完了）。",
      },
      ...SCOPE_PROPERTIES,
      cursor: { type: "string", description: "前回の応答の nextCursor。最初のページでは省略する。" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `1ページの件数（1〜${MAX_LIMIT}）。省略時はIssueDeckの既定。` },
    },
    required: ["category"],
    additionalProperties: false,
  },
  handler: (args) => relay(args, ITEMS_PATH, true),
};
