import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "../core/paths.ts";
import type { AccessToken, AuthCode, AuthState, OAuthClient } from "./types.ts";

/**
 * OAuthの状態（登録クライアント・認可コード・トークン）の保存。
 *
 * プロセス内メモリに置くと再起動のたびに再認証が必要になる。利用者が1人でも、
 * デプロイのたびにClaudeアプリで認証をやり直すのは現実的でない。
 *
 * 中身は実質的な認証情報なので、ファイルは 600 で作る。
 *
 * **書き込みは `mutate()` で直列化している。** 状態の更新は「読む→変えて→保存する」で、保存の中に
 * `await`（mkdir・writeFile・chmod・rename）が挟まる。`Anthropic/Toolbox` と `Anthropic/ClaudeAI` は
 * 同時に繋いでくるため、トークン発行とリフレッシュが重なると、後から保存した側が先の追加を
 * 上書きして消してしまう（`core/record-file.ts` と同じ問題）。
 */

/** テストが本番の状態を汚さないよう差し替えられるようにしている（`AIDE_MCP_ACCESS_LOG_PATH` と同じ考え方）。 */
const STORE_PATH = process.env["AIDE_AUTH_STATE_PATH"]
  ? resolve(process.env["AIDE_AUTH_STATE_PATH"])
  : join(DATA_DIR, "auth", "oauth-state.json");
const EMPTY: AuthState = { clients: [], codes: [], tokens: [] };

let cached: AuthState | null = null;
/** 読み込み中の Promise。読み取りが重なっても、ファイルを読むのは1回にする。 */
let loading: Promise<AuthState> | null = null;
/** 書き込みを1本に並べるキュー。失敗しても後続を止めない。 */
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<AuthState> {
  if (cached) return Promise.resolve(cached);
  // 読み取りどうしが重なったとき、後から終わった読み込みが `cached` を古い内容で上書きしないよう共有する。
  loading ??= (async () => {
    try {
      const state = await readState();
      // 読み込み中に保存が済んでいたら、そちらが新しい。
      cached ??= state;
      return cached;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function readState(): Promise<AuthState> {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8")) as AuthState;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return structuredClone(EMPTY);
  }
}

async function save(state: AuthState): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  // 一時ファイル名は呼び出しごとに変える。固定だと、万一重なったときに互いの一時ファイルを持ち去り合う。
  const tmp = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, STORE_PATH);
  } catch (cause) {
    // 書きかけの認証情報を残さない。
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
  // 保存に成功してから差し替える。失敗したときは、ディスクと同じ直前の状態のまま残る。
  cached = state;
}

/**
 * 状態を読み、渡した関数で次の状態を決めて保存する。**呼び出しは直列化される。**
 * `next` が null のときは何も変わっていないので保存しない。
 */
function mutate<R>(task: (state: AuthState) => { next: AuthState | null; result: R }): Promise<R> {
  const run = async () => {
    const { next, result } = task(await load());
    if (next) await save(prune(next));
    return result;
  };
  const done = queue.then(run, run);
  queue = done.catch(() => undefined);
  return done;
}

/** 期限切れの認可コード・トークンを落とす。保存のたびに呼ぶ。 */
function prune(state: AuthState): AuthState {
  const now = Date.now();
  return {
    clients: state.clients,
    codes: state.codes.filter((c) => c.expiresAt > now),
    tokens: state.tokens.filter((t) => t.expiresAt > now),
  };
}

export function addClient(client: OAuthClient): Promise<void> {
  return mutate((state) => ({ next: { ...state, clients: [...state.clients, client] }, result: undefined }));
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  return (await load()).clients.find((c) => c.clientId === clientId) ?? null;
}

export function addCode(code: AuthCode): Promise<void> {
  return mutate((state) => ({ next: { ...state, codes: [...state.codes, code] }, result: undefined }));
}

/**
 * 認可コードを取り出して即座に削除する。
 * コードの再利用はトークン横取りの典型手口なので、必ずワンタイムにする。
 */
export function consumeCode(code: string): Promise<AuthCode | null> {
  return mutate((state) => {
    const found = state.codes.find((c) => c.code === code) ?? null;
    return {
      next: { ...state, codes: state.codes.filter((c) => c.code !== code) },
      result: found && found.expiresAt > Date.now() ? found : null,
    };
  });
}

export function addToken(token: AccessToken): Promise<void> {
  return mutate((state) => ({ next: { ...state, tokens: [...state.tokens, token] }, result: undefined }));
}

export async function findToken(token: string): Promise<AccessToken | null> {
  const found = (await load()).tokens.find((t) => t.token === token) ?? null;
  return found && found.expiresAt > Date.now() ? found : null;
}

export function consumeRefreshToken(refreshToken: string): Promise<AccessToken | null> {
  return mutate((state) => {
    const found = state.tokens.find((t) => t.refreshToken === refreshToken) ?? null;
    if (!found) return { next: null, result: null };
    // 使ったリフレッシュトークンは無効化し、新しい組を発行させる（ローテーション）。
    return { next: { ...state, tokens: state.tokens.filter((t) => t !== found) }, result: found };
  });
}

/** 動作状況ページ（`/status`）へ出す集計。**トークンの値そのものは返さない。** */
export interface AuthSummary {
  /** 動的登録されたクライアントの数。 */
  clients: number;
  /** 期限内のアクセストークンの数。 */
  tokens: number;
  /** そのうち最も早い失効時刻（ISO8601）。1件も無ければ null。 */
  nearestExpiryAt: string | null;
}

export async function readAuthSummary(): Promise<AuthSummary> {
  const state = prune(await load());
  const nearest = state.tokens.reduce<number | null>(
    (earliest, token) => (earliest === null || token.expiresAt < earliest ? token.expiresAt : earliest),
    null,
  );
  return {
    clients: state.clients.length,
    tokens: state.tokens.length,
    nearestExpiryAt: nearest === null ? null : new Date(nearest).toISOString(),
  };
}

/** テスト用。プロセス内キャッシュを捨てる。 */
export function resetCache(): void {
  cached = null;
  loading = null;
}
