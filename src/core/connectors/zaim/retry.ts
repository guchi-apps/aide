import { isZaimSessionExpired } from "./errors.ts";

/**
 * Zaimアクセスの再試行と自動再ログインの「判断」だけを持つ。
 *
 * Playwrightを起動する実行本体は `session.ts` / `scrape.ts` にあり、そちらはテストしづらい。
 * 判断は純粋関数としてここへ寄せ、テストはここに集中させる（`parse.ts` と同じ流儀）。
 *
 * ## なぜ再試行が要るか
 *
 * 認証Cookieは約2時間で失効し、アクセスのたびにその時点から延長される。つまり
 * **維持できるかどうかは「2時間以内に1回でも成功したか」だけで決まる**。
 * 以前は `zaim-keep-alive` が毎時1回きりでリトライも無く、瞬間的なネットワーク断で
 * 1回落ちただけでセッションを失っていた（#63。2026-08-16 15:00 UTC の
 * `net::ERR_ADDRESS_UNREACHABLE` の次の実行が `ZAIM_SESSION_EXPIRED` になった）。
 */

/** 1回の実行で試す最大回数（初回を含む）。 */
export const MAX_ATTEMPTS = 3;

/**
 * 再試行前に空ける時間。回数ぶん並べる（`MAX_ATTEMPTS - 1` 個）。
 *
 * ネットワーク断は数十秒で戻ることが多い。一方で長く粘るほど systemd のジョブが
 * 居座るため、合計40秒で切り上げる。次の実行（30分後）にも余裕があるため、
 * ここで粘りきる必要はない。
 */
const RETRY_DELAYS_MS = [10_000, 30_000] as const;

/**
 * この失敗をやり直す価値があるか。
 *
 * セッション失効だけは「やり直しても同じ結果になる失敗」にあたる。再試行では直らず、
 * 再ログインするか人が手動でログインし直すまで変わらないため、即座に諦める。
 * それ以外（ネットワーク断・タイムアウト・Chromiumの起動失敗など）は次で直りうる。
 */
export function isRetriableZaimFailure(message: string): boolean {
  return !isZaimSessionExpired(message);
}

/**
 * `attempt` 回目（1始まり）の実行が失敗したあと、次の実行まで空ける時間。
 * これ以上試さない場合は null を返す。
 */
export function retryDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[attempt - 1] ?? null;
}

/**
 * 自動再ログインに使う資格情報。
 *
 * **値をログ・通知・例外メッセージへ出さないこと。** 呼び出し側は「設定されているか」
 * だけを見て分岐し、値は子プロセスの環境変数として渡すに留める。
 */
export interface ZaimCredentials {
  email: string;
  password: string;
}

/**
 * 自動再ログインの資格情報を読む。両方揃っていなければ null（＝自動再ログインを行わない）。
 *
 * **未設定を既定の状態として扱う。** 開発機・CI・資格情報を置きたくない環境では
 * 従来どおり `ZAIM_SESSION_EXPIRED` で失敗させ、手動ログインへ倒す。
 * 片方だけ設定されている状態は設定漏れなので、中途半端に試さず未設定として扱う。
 */
export function readZaimCredentials(
  env: Record<string, string | undefined> = process.env,
): ZaimCredentials | null {
  const email = env["ZAIM_EMAIL"]?.trim();
  const password = env["ZAIM_PASSWORD"]?.trim();
  if (!email || !password) return null;
  return { email, password };
}
