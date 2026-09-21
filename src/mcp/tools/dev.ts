import { buildDevStatus } from "../../core/views/dev.ts";
import type { DevStatus } from "../../core/views/dev.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 開発状況の読み取り（#373）。
 *
 * ClaudeアプリにはGitHubのコネクタが無い（接続済みは Notion・Gmail・Googleカレンダー・
 * Googleドライブ・AIDE）。GitHubは README「Core と MCP層の境界」でいう**公式MCPが無いもの**に
 * あたり、かつ複数リポジトリの状態を1つの答えに畳むため、横断ビューとしても成立する。
 *
 * **3本に分けている。** 以前は `aide_dev_status` 1本で、引数 `repo` の有無で「全体の俯瞰」と
 * 「1リポジトリの詳細」を切り替えていた。同じツールが答えの形ごと変わるため、
 * 起票に使うラベルの候補が欲しいだけのときにもコミット・Issue・Pull Request の一覧まで返り、
 * `aide_create_issue` の前段が重かった。
 *
 * **取得元（`buildDevStatus()`）は共通。** `aide_repo_status` と `aide_repo_labels` は
 * 同じ1リポジトリぶんの取得を共有し、返す区画だけが違う。
 */

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
    isError: false,
  };
}

function readRepo(args: Record<string, unknown>): string {
  return typeof args["repo"] === "string" ? args["repo"].trim() : "";
}

/** 1リポジトリぶんを引く。見つからなければ理由を返す。 */
async function loadRepo(
  repo: string,
): Promise<{ ok: true; status: DevStatus; entry: NonNullable<DevStatus["repos"][number]> } | { ok: false; payload: unknown }> {
  if (!repo) {
    return { ok: false, payload: { ok: false, reason: "repo が必要です（owner は含めないリポジトリ名）" } };
  }

  const status = await buildDevStatus(repo);
  const entry = status.repos[0];
  if (!entry) {
    return {
      ok: false,
      payload: {
        ok: false,
        reason: `リポジトリ ${repo} の情報を取得できませんでした`,
        scope: status.scope,
        unavailable: status.unavailable,
        // 取得できなかったのか、そんなリポジトリが無いのかを取り違えさせない。
        hint: "名前が正しいかを aide_dev_status の repos で確かめてください。",
      },
    };
  }
  return { ok: true, status, entry };
}

export const devStatusTool: Tool = {
  name: "aide_dev_status",
  description:
    "guchi-apps の各リポジトリの開発状況を**俯瞰で**返す。リポジトリごとに最新リリースのバージョン、" +
    "main へ未反映のコミット数（未リリースの変更）、open な Issue / Pull Request の件数、" +
    "確認待ち（00.check-user）の件数、デフォルトブランチの直近コミット、CIの成否を含む。" +
    "「いまどのアプリを開発しているか」「未リリースの変更はあるか」「確認待ちは残っているか」" +
    "「CIは通っているか」を尋ねられたときに呼ぶ。" +
    "attention に注意すべきことが1行ずつ入るので、まずそこを見ること。" +
    "ok が true なら判定できた範囲で注意点なし。complete が false のときは取得できなかったものがあり、" +
    "判定範囲が限定的であることを意味する。" +
    "**1リポジトリの Issue・Pull Request・コミットの一覧までは返さない**（それは aide_repo_status）。" +
    "**起票に使えるラベルの候補も返さない**（それは aide_repo_labels）。" +
    "**ソースコードやREADMEの本文は返さない。** 実装の中身を知りたい場合はリポジトリを直接読むこと。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => json(await buildDevStatus()),
};

export const repoStatusTool: Tool = {
  name: "aide_repo_status",
  description:
    "リポジトリ1件の開発状況を詳しく返す。俯瞰と同じ項目（最新リリース・未リリースの変更・" +
    "Issue / Pull Request の件数・CIの成否）に加えて、直近コミットの一覧、" +
    "確認待ち（00.check-user）の Issue、open な Pull Request（draft かどうかを含む）を返す。" +
    "「◯◯はどこまで進んでいるか」「◯◯で確認待ちのIssueは何か」" +
    "「◯◯のPull Requestは何が開いているか」のように、リポジトリが1つに決まっているときに呼ぶ。" +
    "**どのリポジトリの話か決まっていないときは aide_dev_status で俯瞰を見ること。**" +
    "**起票に使えるラベルの候補は返さない**（それは aide_repo_labels）。" +
    "**ソースコードやREADMEの本文は返さない。**",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "リポジトリ名（owner は含めない。例: aide, issue-deck, dayspan）。",
      },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const loaded = await loadRepo(readRepo(args));
    if (!loaded.ok) return json(loaded.payload);

    const { status, entry } = loaded;
    // ラベルは aide_repo_labels の担当なので、ここでは落とす。
    const { labels: _labels, ...detail } = entry.detail ?? { recentCommits: [], checkUserIssues: [], openPullRequests: [], labels: [] };
    return json({
      ok: true,
      checkedAt: status.checkedAt,
      configured: status.configured,
      org: status.org,
      complete: status.complete,
      attention: status.attention,
      repo: { ...entry, detail },
      unavailable: status.unavailable,
      note: status.note,
    });
  },
};

export const repoLabelsTool: Tool = {
  name: "aide_repo_labels",
  description:
    "リポジトリ1件に定義されているラベルの一覧（名前・色・説明）を返す。読み取り専用。" +
    "**aide_create_issue でどのラベルを付けるか決めるときは、先にこれを呼んで候補を確かめること**" +
    "（実在しないラベル名は起票時に黙って落ちる）。" +
    "「◯◯にはどんなラベルがあるか」を尋ねられたときにも呼ぶ。" +
    "開発状況・Issue・Pull Request・コミットは返さない（俯瞰は aide_dev_status、" +
    "1リポジトリの詳細は aide_repo_status）。",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "リポジトリ名（owner は含めない。例: aide, issue-deck, dayspan）。",
      },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const loaded = await loadRepo(readRepo(args));
    if (!loaded.ok) return json(loaded.payload);

    const { status, entry } = loaded;
    return json({
      ok: true,
      checkedAt: status.checkedAt,
      repo: entry.name,
      labels: entry.detail?.labels ?? [],
      unavailable: status.unavailable,
    });
  },
};
