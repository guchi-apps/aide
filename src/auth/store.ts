import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../core/paths.ts";
import type { AccessToken, AuthCode, AuthState, OAuthClient } from "./types.ts";

/**
 * OAuthの状態（登録クライアント・認可コード・トークン）の保存。
 *
 * プロセス内メモリに置くと再起動のたびに再認証が必要になる。利用者が1人でも、
 * デプロイのたびにClaudeアプリで認証をやり直すのは現実的でない。
 *
 * 中身は実質的な認証情報なので、ファイルは 600 で作る。
 */

const STORE_PATH = join(DATA_DIR, "auth", "oauth-state.json");
const EMPTY: AuthState = { clients: [], codes: [], tokens: [] };

let cached: AuthState | null = null;

async function load(): Promise<AuthState> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(STORE_PATH, "utf8")) as AuthState;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    cached = structuredClone(EMPTY);
  }
  return cached;
}

async function save(state: AuthState): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, STORE_PATH);
  cached = state;
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

export async function addClient(client: OAuthClient): Promise<void> {
  const state = await load();
  await save(prune({ ...state, clients: [...state.clients, client] }));
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  return (await load()).clients.find((c) => c.clientId === clientId) ?? null;
}

export async function addCode(code: AuthCode): Promise<void> {
  const state = await load();
  await save(prune({ ...state, codes: [...state.codes, code] }));
}

/**
 * 認可コードを取り出して即座に削除する。
 * コードの再利用はトークン横取りの典型手口なので、必ずワンタイムにする。
 */
export async function consumeCode(code: string): Promise<AuthCode | null> {
  const state = await load();
  const found = state.codes.find((c) => c.code === code) ?? null;
  await save(prune({ ...state, codes: state.codes.filter((c) => c.code !== code) }));
  return found && found.expiresAt > Date.now() ? found : null;
}

export async function addToken(token: AccessToken): Promise<void> {
  const state = await load();
  await save(prune({ ...state, tokens: [...state.tokens, token] }));
}

export async function findToken(token: string): Promise<AccessToken | null> {
  const found = (await load()).tokens.find((t) => t.token === token) ?? null;
  return found && found.expiresAt > Date.now() ? found : null;
}

export async function consumeRefreshToken(refreshToken: string): Promise<AccessToken | null> {
  const state = await load();
  const found = state.tokens.find((t) => t.refreshToken === refreshToken) ?? null;
  if (!found) return null;
  // 使ったリフレッシュトークンは無効化し、新しい組を発行させる（ローテーション）。
  await save(prune({ ...state, tokens: state.tokens.filter((t) => t !== found) }));
  return found;
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
}
