import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

/**
 * 実行中の配布物の package.json の version を返す。
 *
 * MCP の `serverInfo.version` に使う。固定値や推測値へフォールバックすると、本番が
 * 名乗る版と実物がずれても気づけないため、読めなければ原因付きで例外にする（#621）。
 * 場所は `REPO_ROOT`（このファイル基準）なので、カレントディレクトリに依存しない。
 */
export function readPackageVersion(root: string = REPO_ROOT): string {
  const path = join(root, "package.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`AIDEのバージョンを取得できません: ${path} を読めません (${errorMessage(cause)})`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`AIDEのバージョンを取得できません: ${path} がJSONとして不正です (${errorMessage(cause)})`, {
      cause,
    });
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`AIDEのバージョンを取得できません: ${path} に version がありません`);
  }
  return version.trim();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
