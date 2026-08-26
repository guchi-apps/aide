import type { Tool, ToolDefinition } from "./types.ts";

/**
 * ツールの登録簿。
 *
 * AIDEのMCP層に出すのは「横断ビュー」と「**公開のリモートMCPサーバーが存在しないもの**」に限る。
 * Notionのように公開URLのあるものは、呼び出し側がそちらへ直接繋げるため登録しない
 * （同じ機能のツールが2セット並び、ツール選択が曖昧になりコンテキストも食う）。
 *
 * **判断の基準は「Claudeアプリにコネクタがあるか」ではない**（aide#173）。あれはAnthropic製品側の
 * 機能で、Messages APIを叩く自前のクライアント（`guchi-apps/aide-bot`）からは利用できない。
 * Googleカレンダーがこれにあたるため、予定は `aide_schedule` として出している。
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`ツール名が重複しています: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }
}
