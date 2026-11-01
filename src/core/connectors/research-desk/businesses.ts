/**
 * Research Desk へ登録できる事業（テーマ）の登録簿。
 *
 * 週報の `business` の検証・事業ごとの件数上限・MCPツールの enum と説明文は、すべてここから
 * 作る（#314）。**事業を足すときに直すのはこの登録簿だけ**にするための置き場で、
 * `index.ts` や `mcp/tools/research-desk.ts` に事業のIDを直書きしない。
 *
 * **登録簿へ足す前に、Research Desk 側が同じIDを受けられる状態で `main` に出ていること。**
 * あちらは事業を Prisma enum（`IndustryBusiness`）と `/api/internal/weekly-report` の検証で
 * 持っており、知らないIDは400で弾く。AIDEだけ先に本番へ出すと、本番でだけ失敗する。
 */

export interface ResearchDeskBusinessDefinition {
  /** Research Desk の `IndustryBusiness` と同じ識別子。 */
  readonly id: string;
  /** ChatGPT へ見せる表示名。 */
  readonly label: string;
}

export const RESEARCH_DESK_BUSINESSES = [
  { id: "EXTERIOR", label: "エクステリア事業（宅配・ポスト）" },
  { id: "LOCKER", label: "ロッカー事業" },
  { id: "AI", label: "AI関連（Gemini・Copilot）" },
] as const satisfies readonly ResearchDeskBusinessDefinition[];

/** 登録簿に載っている事業のID。 */
export type ResearchDeskBusiness = (typeof RESEARCH_DESK_BUSINESSES)[number]["id"];

export function businessIds(businesses: readonly ResearchDeskBusinessDefinition[] = RESEARCH_DESK_BUSINESSES): string[] {
  return businesses.map((business) => business.id);
}

/** 「エクステリア事業（宅配・ポスト）（EXTERIOR）・ロッカー事業（LOCKER）」のような、説明文へ埋め込む列挙。 */
export function describeBusinesses(businesses: readonly ResearchDeskBusinessDefinition[] = RESEARCH_DESK_BUSINESSES): string {
  return businesses.map((business) => `${business.label}（${business.id}）`).join("・");
}

/** 「EXTERIOR=エクステリア事業（宅配・ポスト）、LOCKER=ロッカー事業」のような、`business` 項目の説明。 */
export function describeBusinessIds(businesses: readonly ResearchDeskBusinessDefinition[] = RESEARCH_DESK_BUSINESSES): string {
  return businesses.map((business) => `${business.id}=${business.label}`).join("、");
}
