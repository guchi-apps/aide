import { readGitHubWriteConfig } from "../../core/connectors/github/index.ts";
import { createIssue, DEFAULT_LABELS } from "../../core/connectors/github/write.ts";
import type { Tool } from "../types.ts";

/**
 * Issueの起票（aide#50）。AIDEが最初に持った書き込みツールで、GitHubへの書き込みはこれだけ。
 * 書き込みツールはほかにもあるので、「唯一」「N個目」といった数え方はここにも
 * LLMへ渡す description にも書かない（増えるたびに嘘になる）。3条件の判断は README
 * 「書き込みをどこまで持つか」の表にまとめてある。
 *
 * 外出先でClaudeアプリに思いついたことを話し、そのままIssueにしたい、という要望が起点
 * （guchi-apps/question#15）。Claude Code（端末・GitHub Actions）からは `gh issue create` で
 * 既にできるが、**Claudeアプリからの経路だけが塞がっていた**。issue-deckはMCPサーバーを
 * 持たず、`POST /api/issues` はCookie認証のため素で叩けない。
 *
 * README「Core と MCP層の境界」でいうと、ClaudeアプリにGitHubの公式コネクタが無いため
 * MCP層に出してよい対象にあたる（`aide_dev_status` と同じ理由）。
 *
 * **編集・close・コメントは持たない。** それらはissue-deckの画面とClaude Codeの仕事。
 *
 * **`dryRun` を持つ**（#373）。会話の流れで勝手に起票されるとIssueが量産されるため、
 * 起票前に「どのリポジトリへ何を出すか」だけを確かめられるようにしてある。
 */
export const createIssueTool: Tool = {
  name: "aide_create_issue",
  description:
    "guchi-apps のリポジトリに GitHub の Issue を新規作成する。**書き込みを伴うツール。**" +
    "「Issueにしておいて」「起票して」「あとで対応したいので残しておいて」と明示的に頼まれたときだけ呼ぶ。" +
    "会話の中で課題や改善案が出てきただけでは呼ばない（勝手に起票するとIssueが量産される）。" +
    "1回の呼び出しで作れるのは1件だけで、複数の話題があるなら1件ずつ、本当に必要なものに絞ること。" +
    `既定で ${DEFAULT_LABELS.join(" / ")} ラベルが付き、対象リポジトリに存在しないラベルは黙って落ちる。` +
    "作成したIssueのURLと番号を返す。既存Issueの編集・close・コメントはできない（issue-deckの画面で行う）。" +
    "**内容を利用者に確かめてもらいたいときは dryRun: true で呼ぶ**と、起票せずに" +
    "「何が起票されるか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "起票先のリポジトリ名（owner は含めない。例: aide, issue-deck, car-care）。" +
          "**必ず指定する。** どのアプリの話か会話から決まらない思いつき・要望・質問は question を指定すること。" +
          "リポジトリ名が分からない場合は aide_dev_status で一覧を確認するか、利用者に尋ねる。",
      },
      title: {
        type: "string",
        description: "Issueのタイトル。話の内容を1行に要約する。200文字まで。",
      },
      body: {
        type: "string",
        description:
          "Issueの本文（Markdown）。何をしたいのか・なぜそう思ったのか・分かっている前提を書く。" +
          "口述の内容を勝手に断定せず、聞き取れた範囲で書くこと。末尾にはAIDE経由で起票した旨が自動で付く。",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          `付けるラベル名。省略時は ${DEFAULT_LABELS.join(" / ")}。` +
          "対象リポジトリに実在するものだけが付く（存在しないラベルを勝手に作らないため）。" +
          "**どのラベルがあるか分からない場合は、先に aide_dev_status を repo 付きで呼び、" +
          "detail.labels の名前から選ぶこと。** 落ちたラベルがあったときは、" +
          "droppedLabels と実在するラベル名（availableLabels）を返す。",
      },
      dryRun: {
        type: "boolean",
        description:
          "**起票せずに、何が起票されるかだけを返す。** 利用者に内容を確かめてもらってから、" +
          "dryRun を外して呼び直す。**実在しないラベルが落ちるかどうかはここでは分からない**" +
          "（GitHubへ問い合わせないため）。ラベルの候補は aide_repo_labels で確かめる。",
      },
    },
    required: ["repo", "title"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const config = readGitHubWriteConfig();
    if (!config) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                reason: "未設定（AIDE_GITHUB_ISSUE_TOKEN が無いため、GitHubへは何も送っていません）",
              },
              null,
              2,
            ),
          },
        ],
        // 未設定は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
        isError: false,
      };
    }

    const repo = typeof args["repo"] === "string" ? args["repo"] : "";
    const title = typeof args["title"] === "string" ? args["title"] : "";
    const body = typeof args["body"] === "string" ? args["body"] : undefined;
    const labels = Array.isArray(args["labels"])
      ? args["labels"].filter((label): label is string => typeof label === "string")
      : undefined;

    if (args["dryRun"] === true) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                dryRun: true,
                wouldCreate: { repo, title, body: body ?? null, labels: labels ?? DEFAULT_LABELS },
                note:
                  "起票していません。この内容でよければ dryRun を外して呼び直してください。" +
                  "ラベルが対象リポジトリに実在するかは確かめていません。",
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }

    const outcome = await createIssue(config, { repo, title, body, labels });
    if (outcome.ok) {
      console.log(`[issue] 起票: ${outcome.repo}#${outcome.number}`);
    } else {
      console.warn(`[issue] 起票せず: ${outcome.reason}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
      // 作成できなかった理由は reason に入れて返す。isError にすると Claude が
      // 同じ内容で再試行し、暴発ガードにかかるだけの往復が増える。
      isError: false,
    };
  },
};
