import type { FeatureItem } from "./features.ts";

/**
 * アプリ連携の「機能を同期」（#355）。
 *
 * 図（`src/web/map.ts` の `CALLERS` / `GROUPS`）は手書きの宣言なので、機能を足す・消すたびに
 * 実態とずれる。ここは**今動いているAIDEの機能を集めて、宣言と突き合わせるだけ**の純粋関数で、
 * 宣言そのものは書き換えない（本番のサーバーはソースを書き換えられない）。差は画面に出し、
 * 直すのはコードの修正になるので、そのためのIssueの下書きまでをここで組み立てる。
 *
 * **集める範囲は MCPツールと `/api/` のエンドポイントだけ。** `/health`・OAuth・アイコンなどは
 * アプリとのつながりではなく、図に載せる対象ではない。workerジョブやコネクタは図と紐づける
 * 情報が宣言に無いため、対象に含めない。
 */

/** 図の宣言が挙げている機能。`owner` は載っている場所（アプリ名）。 */
export interface DeclaredUse {
  owner: string;
  uses: string[];
}

/** 図に載っていない機能（追加）。 */
export interface AddedFeature {
  name: string;
  kind: "MCPツール" | "HTTP API";
  /** HTTPメソッドなどの補足。 */
  meta?: string | undefined;
  description: string;
}

/** 図に残っているが実在しない機能（削除）。 */
export interface RemovedFeature {
  name: string;
  /** 図のどこに載っているか（アプリ名）。 */
  owners: string[];
}

export interface SyncResult {
  added: AddedFeature[];
  removed: RemovedFeature[];
  /** 図に載っていて実在する機能の数（追加でも削除でもないもの）。 */
  same: number;
}

export interface SyncInput {
  /** MCPの登録簿にあるツール。 */
  tools: FeatureItem[];
  /** 機能一覧の `ENDPOINTS`。 */
  endpoints: FeatureItem[];
  /** 図の宣言。 */
  declared: DeclaredUse[];
}

/**
 * アプリとのつながりとして図に載せる対象のHTTPエンドポイントか。
 * `:` を含むものは worker がAIDEへ送り込む受け口（`/api/cache/:key`）で、アプリが使う口ではない。
 */
export function isAppFacingApi(name: string): boolean {
  return name.startsWith("/api/") && !name.includes(":");
}

/** 宣言の使う機能は `/` で始まればHTTPエンドポイント、それ以外はMCPツール名（`map.ts` の `Caller.uses`）。 */
function isEndpointName(name: string): boolean {
  return name.startsWith("/");
}

export function collectSync(input: SyncInput): SyncResult {
  const toolNames = new Set(input.tools.map((tool) => tool.name));
  const endpointNames = new Set(input.endpoints.map((endpoint) => endpoint.name));

  const declaredBy = new Map<string, string[]>();
  for (const { owner, uses } of input.declared) {
    for (const name of uses) {
      const owners = declaredBy.get(name) ?? [];
      if (!owners.includes(owner)) owners.push(owner);
      declaredBy.set(name, owners);
    }
  }

  const inScope: AddedFeature[] = [
    ...input.tools.map((tool) => ({
      name: tool.name,
      kind: "MCPツール" as const,
      description: tool.description,
    })),
    ...input.endpoints
      .filter((endpoint) => isAppFacingApi(endpoint.name))
      .map((endpoint) => ({
        name: endpoint.name,
        kind: "HTTP API" as const,
        meta: endpoint.meta,
        description: endpoint.description,
      })),
  ];

  const added = inScope.filter((feature) => !declaredBy.has(feature.name));

  const removed: RemovedFeature[] = [];
  for (const [name, owners] of declaredBy) {
    const exists = isEndpointName(name) ? endpointNames.has(name) : toolNames.has(name);
    if (!exists) removed.push({ name, owners });
  }

  return { added, removed, same: inScope.length - added.length };
}

export function hasDifference(result: SyncResult): boolean {
  return result.added.length > 0 || result.removed.length > 0;
}

/** Issueを起票する先。図の宣言（`map.ts`）を持つこのリポジトリ。 */
export const ISSUE_REPO = "aide";

/** 起票の脚注。**Claudeアプリ経由の脚注（`FOOTNOTE`）のままだと、出所を取り違える。** */
export const MAP_SYNC_FOOTNOTE =
  "---\n\n" +
  "このIssueはAIDEのアプリ連携画面（「機能を同期」→「Issueを起案」）から起票されました。" +
  "差は起票した時点のコードから自動で集めたもので、着手する前に内容の確認が要ります。\n\n" +
  "<!-- aide:created-via-map-sync -->";

export interface IssueDraft {
  title: string;
  body: string;
}

/** 同期した日時（JST）を「2026-09-21 14:32」の形にする。 */
export function formatSyncedAt(date: Date): string {
  // sv-SE は「2026-09-21 14:32」の形で返す。
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/**
 * 差から、図を直すIssueの下書きを組み立てる。**画面からの入力は使わない。**
 * 名前と説明はコード側の宣言から来たもので、起票の内容を利用者が書き換える口は持たない。
 */
export function buildIssueDraft(result: SyncResult, syncedAt: string): IssueDraft {
  const lines: string[] = ["アプリ連携の図（`src/web/map.ts`）と、いまのAIDEの機能に差があります。"];

  if (result.added.length > 0) {
    lines.push("", "### 図に載っていない（追加）");
    for (const feature of result.added) {
      const label = feature.meta ? `${feature.kind}・${feature.meta}` : feature.kind;
      lines.push(`- \`${feature.name}\`（${label}）`);
    }
  }
  if (result.removed.length > 0) {
    lines.push("", "### 図に残っているが実在しない（削除）");
    for (const feature of result.removed) {
      lines.push(`- \`${feature.name}\`（${feature.owners.join("・")}）`);
    }
  }
  lines.push("", `同期した日時: ${syncedAt}`);

  return {
    title: `アプリ連携の図を機能の実態に合わせる（追加${result.added.length}・削除${result.removed.length}）`,
    body: lines.join("\n"),
  };
}
