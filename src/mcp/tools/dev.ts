import { buildDevStatus } from "../../core/views/dev.ts";
import type { Tool } from "../types.ts";

/**
 * 開発状況の横断ビュー。
 *
 * ClaudeアプリにはGitHubのコネクタが無い（接続済みは Notion・Gmail・Googleカレンダー・
 * Googleドライブ・AIDE）。GitHubは README「Core と MCP層の境界」でいう**公式MCPが無いもの**に
 * あたり、かつ複数リポジトリの状態を1つの答えに畳むため、横断ビューとしても成立する。
 *
 * **1本に収めている。** 「全体の俯瞰」と「1リポジトリの詳細」を別ツールに割ると、
 * ツール選択が曖昧になる（README「MCP層は狭く」）。引数 `repo` の有無で深さを切り替える。
 */
export const devStatusTool: Tool = {
  name: "aide_dev_status",
  description:
    "guchi-apps の各リポジトリの開発状況を返す。" +
    "最新リリースのバージョン、main へ未反映のコミット数（未リリースの変更）、" +
    "open な Issue / Pull Request の件数、確認待ち（00.check-user）の件数、" +
    "デフォルトブランチの直近コミット、CIの成否を含む。" +
    "「いまどのアプリを開発しているか」「◯◯はどこまで進んでいるか」「未リリースの変更はあるか」" +
    "「確認待ちは残っているか」「CIは通っているか」を尋ねられたときに呼ぶ。" +
    "repo を省くと対象リポジトリ全体の俯瞰を返す。特定のリポジトリについて" +
    "Issue・Pull Request・コミットの一覧まで見たいときだけ repo にリポジトリ名を指定する。" +
    "attention に注意すべきことが1行ずつ入るので、まずそこを見ること。" +
    "ok が true なら判定できた範囲で注意点なし。complete が false のときは取得できなかったものがあり、" +
    "判定範囲が限定的であることを意味する。" +
    "**ソースコードやREADMEの本文は返さない。** 実装の中身を知りたい場合はリポジトリを直接読むこと。",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "リポジトリ名（owner は含めない。例: aide, issue-deck, dayspan）。" +
          "指定するとそのリポジトリだけを、Issue・Pull Request・直近コミットの一覧まで含めて返す。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const repo = typeof args["repo"] === "string" && args["repo"].trim() !== "" ? args["repo"].trim() : undefined;
    const status = await buildDevStatus(repo);
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
