import { readPackageVersion } from "./version.ts";

export interface ProcessInfo {
  /** MCP `initialize` の `serverInfo.version` と同じ値。 */
  readonly version: string;
  /** このサーバープロセスの起動時刻（UTCのISO 8601）。 */
  readonly startedAt: string;
}

let cached: ProcessInfo | null = null;

/**
 * 応答しているプロセス自身の版と起動時刻。**最初に読んだ値を固定する**ので、起動後に
 * package.json が差し替わっても `initialize` と `aide_ping` は食い違わない（#625）。
 * 起動時刻は呼び出し時刻ではなく、OSが数えるプロセスの経過時間から逆算する。
 * 版が読めなければ `readPackageVersion` が原因付きで例外にし、推測値は返さない。
 */
export function getProcessInfo(): ProcessInfo {
  cached ??= {
    version: readPackageVersion(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
  return cached;
}
