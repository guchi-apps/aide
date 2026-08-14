import type { Tool, ToolDefinition } from "./types.ts";

/**
 * ツールの登録簿。
 * AIDEのMCP層に出すのは「横断ビュー」と「公式MCPが存在しないもの」に限る。
 * Notion/Gmail/Googleカレンダー等の単機能ツールは、Claudeアプリ側の公式MCPと
 * 重複してツール選択を曖昧にするため、ここには登録しない。
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
