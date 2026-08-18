/**
 * `session-check.mjs` の型。
 *
 * ログイン判定は失敗の切り分け（再試行するか、手動ログインへ回すか）を決める要なので、
 * Zaimへ実アクセスせずにテストできるようテストから呼べるようにしている。
 */

/** `url()` と `locator().count()` だけを使う。Playwright の Page もこれを満たす。 */
export interface ZaimSessionCheckPage {
  url(): string;
  locator(selector: string): { count(): Promise<number> };
}

/** ログイン画面へ飛ばされていたら `ZAIM_SESSION_EXPIRED:` を含む例外を投げる。 */
export declare function assertLoggedIn(page: ZaimSessionCheckPage): Promise<void>;
