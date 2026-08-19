import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "../core/paths.ts";

/**
 * MCPへのアクセスの記録。
 *
 * Claudeアプリからの呼び出しは、これまでどこにも残らなかった。ジョブの失敗は Signaly へ飛び
 * （`worker/notify.ts`）、実行の記録はキャッシュに残る（`worker/record.ts`）のに、**MCPだけは
 * 「いつ・どのツールが呼ばれたか」を後から確かめる手段が無かった**（#116）。
 *
 * 残すのは**呼ばれた事実だけ**にする。ツールの引数と応答の中身は記録しない。残高・部屋の状態・
 * 起票した本文がそのまま `data/` に平文で溜まることになり、MCPが返すデータの置き場を1つ増やす
 * のと変わらなくなる。アクセス元IP・アクセストークン・セッションIDも同じ理由で残さない。
 *
 * 置き場はファイル（`data/mcp-access.json`）。**キャッシュ（`core/cache/store.ts`）には
 * 載せない。** あちらは worker がHTTPで送ってくる取得結果の置き場で、受け口（`POST /api/cache/:key`）
 * から上書きできる。アクセスの記録を書くのはサーバー自身なので、経路を共有する理由が無い。
 *
 * メモリ上だけに持つ案は採らなかった。デプロイのたびにサーバーが再起動し、そのたびに
 * 「最後にClaudeが繋いだのはいつか」に答えられなくなる。
 */

/** 保持する件数。超えた分は古いものから落とす。 */
export const MAX_ENTRIES = 200;

/** 書き込みをまとめる間隔。1件ごとに書くとツール呼び出しのたびにディスクを触ることになる。 */
const FLUSH_DELAY_MS = 2_000;

/** 失敗理由の上限。表の1行に収まる範囲に切る。 */
const MAX_DETAIL_LENGTH = 200;

/** テストが本番の記録を汚さないよう差し替えられるようにしている（`AIDE_CACHE_DIR` と同じ考え方）。 */
export const ACCESS_LOG_PATH = process.env["AIDE_MCP_ACCESS_LOG_PATH"]
  ? resolve(process.env["AIDE_MCP_ACCESS_LOG_PATH"])
  : resolve(DATA_DIR, "mcp-access.json");

export interface McpAccessEntry {
  /** 応答を返した時刻（ISO8601）。 */
  at: string;
  /** JSON-RPCのメソッド名（`tools/call` / `initialize` など）。 */
  method: string;
  /** `tools/call` のときのツール名。それ以外は null。 */
  tool: string | null;
  /** 接続時に名乗ったクライアント名。名乗らない相手はUser-Agentから拾い、それも無ければ null。 */
  client: string | null;
  /** クライアントのバージョン。名乗らなければ null。 */
  clientVersion: string | null;
  ok: boolean;
  /** 応答を返すまでのミリ秒。 */
  ms: number;
  /** 失敗の理由（1行）。成功時は空文字。 */
  detail: string;
}

/**
 * 数が多く、他の行を押し流すメソッド。
 *
 * 接続確認（`ping`）と一覧の取得はClaudeが定期的に投げてくる。見たいのは
 * 「どのツールがいつ呼ばれたか」なので、既定では畳んで表示する（`src/web/status.ts`）。
 */
const QUIET_METHODS = new Set([
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
]);

export function isQuietMethod(method: string): boolean {
  return QUIET_METHODS.has(method) || method.startsWith("notifications/");
}

// ---- 保存 ----

let loaded: Promise<McpAccessEntry[]> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
/** 書き込みを直列化する。同時に走ると同じ一時ファイルを奪い合う。 */
let writing: Promise<void> = Promise.resolve();

function load(): Promise<McpAccessEntry[]> {
  loaded ??= (async () => {
    try {
      const parsed = JSON.parse(await readFile(ACCESS_LOG_PATH, "utf8")) as {
        entries?: McpAccessEntry[];
      };
      return Array.isArray(parsed.entries) ? parsed.entries.slice(-MAX_ENTRIES) : [];
    } catch (cause) {
      // まだ1件も記録していない場合と、壊れたファイルを掴んだ場合。
      // どちらも空から始め直す。記録のために起動を失敗させる価値は無い。
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[mcp] アクセスの記録を読めませんでした: ${cause instanceof Error ? cause.message : cause}`,
        );
      }
      return [];
    }
  })();
  return loaded;
}

/**
 * 上限を超えた分を落とす。**接続確認・一覧の取得から先に捨てる。**
 *
 * 単純に古い順で捨てると、Claudeが定期的に投げてくる `ping` が並んだだけで
 * ツールの呼び出しが押し出され、いちばん見たいものが残らない。
 */
function trim(entries: McpAccessEntry[]): void {
  while (entries.length > MAX_ENTRIES) {
    const quiet = entries.findIndex((entry) => isQuietMethod(entry.method));
    entries.splice(quiet === -1 ? 0 : quiet, 1);
  }
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…`
    : collapsed;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushMcpAccessLog();
  }, FLUSH_DELAY_MS);
  // 記録の書き込みのためにプロセスを起こし続けない。
  flushTimer.unref();
}

/** いま持っている記録をファイルへ書く。テストと、待たずに確かめたいときの入口。 */
export function flushMcpAccessLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const snapshot = loaded;
  if (!snapshot) return writing;

  writing = writing.then(async () => {
    try {
      const entries = await snapshot;
      await mkdir(dirname(ACCESS_LOG_PATH), { recursive: true });
      // 一時ファイルへ書いてから rename する（キャッシュと同じ理由）。
      const tmp = `${ACCESS_LOG_PATH}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ entries }, null, 2), "utf8");
      await rename(tmp, ACCESS_LOG_PATH);
    } catch (cause) {
      console.error(
        `[mcp] アクセスの記録を残せませんでした: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  });
  return writing;
}

/**
 * 1件記録する。**呼び出し側を失敗させない。**
 *
 * 記録できなくてもMCPの応答は変わらないため、例外はログ1行に落とす。
 * ここで投げると、成功したツール呼び出しが記録の失敗だけで失敗扱いになる
 * （`worker/record.ts` と同じ方針）。
 */
export async function recordMcpAccess(entry: McpAccessEntry): Promise<void> {
  try {
    const entries = await load();
    entries.push({ ...entry, detail: oneLine(entry.detail), ms: Math.max(0, Math.round(entry.ms)) });
    trim(entries);
    scheduleFlush();
  } catch (cause) {
    console.error(
      `[mcp] アクセスを記録できませんでした: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

/** 記録の全件。古い順。 */
export async function readMcpAccessLog(): Promise<McpAccessEntry[]> {
  return [...(await load())];
}

/** テスト用。プロセス内の状態を捨てる。 */
export function resetMcpAccessLog(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  loaded = null;
}

// ---- 集計 ----

export interface McpAccessToolCount {
  tool: string;
  count: number;
}

export interface McpAccessSummary {
  /** 記録に残っている件数。 */
  total: number;
  /** そのうちツールの呼び出し。 */
  toolCalls: number;
  /** 失敗した呼び出し。 */
  failures: number;
  /** 直近24時間の失敗。カードの状態はこれで決める。 */
  recentFailures: number;
  lastAt: string | null;
  lastAgeMinutes: number | null;
  /** 接続してきたクライアント（新しい順・重複なし）。 */
  clients: string[];
  /** ツールごとの呼び出し回数（多い順）。 */
  toolCounts: McpAccessToolCount[];
  /** 画面に出す行（新しい順）。 */
  entries: McpAccessEntry[];
  /** 畳んでいない行（ツールの呼び出しと接続開始）の数。 */
  visible: number;
  severity: "ok" | "warn" | "unknown";
}

/** 表に出す件数。全件出すと1画面に収まらず、古い記録ほど読まれない。 */
export const DISPLAY_LIMIT = 30;

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 集計。**純粋関数。テストはここに当てる。** */
export function summarizeMcpAccess(
  entries: McpAccessEntry[],
  now: Date,
  limit: number = DISPLAY_LIMIT,
): McpAccessSummary {
  const newestFirst = [...entries].reverse();
  const calls = entries.filter((entry) => entry.method === "tools/call");

  const counts = new Map<string, number>();
  for (const call of calls) {
    if (!call.tool) continue;
    counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  }

  const clients: string[] = [];
  for (const entry of newestFirst) {
    if (!entry.client) continue;
    const label = entry.clientVersion ? `${entry.client} ${entry.clientVersion}` : entry.client;
    if (!clients.includes(label)) clients.push(label);
  }

  const last = newestFirst[0] ?? null;
  const lastAgeMinutes = last
    ? Math.max(0, Math.round((now.getTime() - new Date(last.at).getTime()) / 60_000))
    : null;

  const recentFailures = entries.filter(
    (entry) => !entry.ok && now.getTime() - new Date(entry.at).getTime() < RECENT_WINDOW_MS,
  ).length;

  return {
    total: entries.length,
    toolCalls: calls.length,
    failures: entries.filter((entry) => !entry.ok).length,
    recentFailures,
    lastAt: last?.at ?? null,
    lastAgeMinutes,
    clients,
    toolCounts: [...counts.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    entries: newestFirst.slice(0, limit),
    visible: newestFirst.slice(0, limit).filter((entry) => !isQuietMethod(entry.method)).length,
    // 記録が無いのは異常ではない（起動直後・まだ誰も繋いでいない）。
    // 失敗も、古いものまで警告し続けると本物の異常が埋もれるため24時間だけ見る。
    severity: entries.length === 0 ? "unknown" : recentFailures > 0 ? "warn" : "ok",
  };
}

/** 動作状況ページ（`/status`）へ出す集計。 */
export async function readMcpAccessSummary(now: Date = new Date()): Promise<McpAccessSummary> {
  return summarizeMcpAccess(await readMcpAccessLog(), now);
}
