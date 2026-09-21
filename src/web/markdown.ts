import { escapeHtml } from "./layout.ts";

/**
 * 説明文のインラインMarkdownをHTMLへ変換する。
 *
 * MCPツールの説明文はLLM向けに `**強調**` と `` `コード` `` で書かれている（#364）。機能一覧や
 * アプリ連携のポップアップは説明文をそのまま人に見せるため、記号がむき出しにならないよう、
 * この2つだけを `<strong>` と `<code>` にする。実行時依存を増やさない方針（README）から
 * Markdownライブラリは使わず、説明文に実在する記法に限っている。斜体・リンク・見出し・リストは
 * 説明文に現れないので扱わない。必要になったらここへ足す。
 *
 * **先に `escapeHtml` を通してから置き換える。** 入力に混じった `<script>` などは
 * 常にエスケープされたまま残り、ここで生成するタグだけがHTMLとして出る。閉じていない
 * `**` や `` ` `` は対応が取れないので置換されず、記号のまま表示される。
 */
export function renderInlineMarkdown(text: string): string {
  return (
    escapeHtml(text)
      // コードを先に取り出す。`**` を含むコードの中身を太字にしないため。
      .split(/(`[^`]+`)/)
      // 捕獲グループ付きの split は、コード部分が奇数番目に入る。
      .map((part, i) =>
        i % 2 === 1
          ? `<code>${part.slice(1, -1)}</code>`
          : part.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
      )
      .join("")
  );
}
