/**
 * issue-deck の全体レビュー・修正API（`POST /api/review-agent/tools/<name>`。issue-deck#4588）への中継（#651）。
 *
 * 認証・認可・状態遷移・冪等性の検証はすべて issue-deck 側にある。AIDEは**引数をそのまま渡し、
 * 応答をそのまま返すだけ**で、独自の判断を足さない（食い違いを作らない）。
 *
 * **専用トークン（`ida_…`）は、既存の共有鍵（共有トークンAPI・アップロード用シークレット）とは別物。**
 * issue-deck の設定＞フリート運用で発行し、取得/更新/再開の範囲と許可repositoryがトークン側で絞られる。
 * 値はAIDEだけが持ち、MCPの入力・出力・ログへは出さない。
 */

export const REVIEW_AGENT_TOOLS = [
  "list_release_candidates",
  "get_release_candidate",
  "get_fix_status",
  "claim_fix",
  "release_fix",
  "pause_fix",
  "resume_fix",
  "report_fix_test",
  "report_fix_review",
] as const;

export type ReviewAgentToolName = (typeof REVIEW_AGENT_TOOLS)[number];

export interface ReviewAgentConfig {
  baseUrl: string;
  token: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** どちらかが無ければ null（＝送信しない）。戻り値はログ・応答へ出さない。 */
export function readReviewAgentConfig(env: NodeJS.ProcessEnv = process.env): ReviewAgentConfig | null {
  const baseUrl = (env["AIDE_ISSUE_DECK_URL"] ?? "").trim().replace(/\/+$/, "");
  const token = (env["AIDE_ISSUE_DECK_REVIEW_AGENT_TOKEN"] ?? "").trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export type ReviewAgentOutcome =
  | { ok: true; body: unknown }
  | { ok: false; httpStatus: number | null; body: unknown; reason: string };

/** 例外の message にはURLが載りうるので、外へ出してよい粒度に丸める。 */
export async function callReviewAgentTool(
  config: ReviewAgentConfig,
  name: ReviewAgentToolName,
  args: Record<string, unknown>,
): Promise<ReviewAgentOutcome> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/review-agent/tools/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const kind = cause instanceof Error ? cause.name : "Error";
    return { ok: false, httpStatus: null, body: null, reason: `issue-deckへ届きませんでした（${kind}）` };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // 拒否の応答（error・message・refetchRequired・details）は、呼び出し側が次の手を決める材料なのでそのまま返す。
    return { ok: false, httpStatus: response.status, body, reason: `issue-deckがHTTP ${response.status}を返しました` };
  }
  return { ok: true, body };
}
