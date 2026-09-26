import {
  MAX_IMAGE_BYTES,
  readIssueDeckUploadConfig,
  uploadImage,
  validateImage,
} from "../../core/connectors/issue-deck/upload.ts";
import type { Tool, ToolResult } from "../types.ts";

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/**
 * IssueDeck への画像アップロード（#449）。ChatGPT・Claude が作った画像を、IssueDeck の
 * 画像置き場へ保存し、Issue本文へ貼れるURLを返す。
 *
 * **作成のみ。** 削除・上書き・一覧は持たない（保存のたびに新しいUUIDのファイルが増える）。
 * 3条件の判断は README「書き込みをどこまで持つか」の表にある。
 *
 * **`dryRun` を持つ**（#373）。検査は本番と同じものを通し、IssueDeck へ送る直前で止める。
 */
export const issueDeckUploadImageTool: Tool = {
  name: "issue_deck_upload_image",
  description:
    "画像を1枚 IssueDeck の画像置き場へアップロードし、Issue本文に貼れる画像URLを返す。**書き込みを伴うツール。**" +
    "「この画像をIssueDeckに添付して」「生成した画像をIssueに使いたい」と明示的に頼まれたときだけ呼ぶ。" +
    `png / jpeg / gif / webp / svg で ${MAX_IMAGE_BYTES / 1024 / 1024}MB まで。` +
    "返ったURLを aide_create_issue の body へ `![説明](URL)` として書けば、Issueに画像が載る。" +
    "アップロードのたびに新しいファイルが増え、この経路から削除・上書きはできない。" +
    "**送る前に利用者へ確かめたいときは dryRun: true で呼ぶ**（検査だけ行い、アップロードしない）。",
  inputSchema: {
    type: "object",
    properties: {
      dataBase64: {
        type: "string",
        description: "画像ファイルの中身をbase64にした文字列（`data:` 接頭辞は付けても付けなくてもよい）。",
      },
      mimeType: {
        type: "string",
        enum: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"],
        description: "画像のMIMEタイプ。中身の先頭バイトと一致しないものは断る。",
      },
      dryRun: {
        type: "boolean",
        description: "**アップロードせずに、検査の結果だけを返す。** 問題なければ dryRun を外して呼び直す。",
      },
    },
    required: ["dataBase64", "mimeType"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const config = readIssueDeckUploadConfig();
    if (!config) {
      return result({
        status: "not_configured",
        reason: "IssueDeckへのアップロードが未設定です（AIDE_ISSUE_DECK_URL と AIDE_ISSUE_DECK_UPLOAD_TOKEN が要ります）。",
      });
    }

    const image = validateImage(args["dataBase64"], args["mimeType"]);
    if (typeof image === "string") return result({ status: "error", reason: image });

    if (args["dryRun"] === true) {
      return result({
        status: "dry_run",
        message: "検査に通りました。アップロードはしていません。",
        mimeType: image.mimeType,
        sizeBytes: image.bytes.length,
      });
    }

    const outcome = await uploadImage(config, image);
    if (!outcome.ok) {
      // 連携そのものの失敗は isError にし、MCPアクセスの記録から気づけるようにする（#308）。
      return result({ status: "error", reason: outcome.reason, httpStatus: outcome.httpStatus }, true);
    }
    return result({
      status: "uploaded",
      url: outcome.url,
      filename: outcome.filename,
      markdown: `![画像](${outcome.url})`,
    });
  },
};
