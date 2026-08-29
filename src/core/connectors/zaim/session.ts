import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZAIM_AUTO_RELOGIN_FAILED } from "./errors.ts";
import { isRetriableZaimFailure, readZaimCredentials, retryDelayMs } from "./retry.ts";

const execFileAsync = promisify(execFile);

const KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** 自動再ログインは画面遷移を伴うため、セッション延長より長めに取る。 */
const AUTO_LOGIN_TIMEOUT_MS = 180_000;

/** `scripts/` 配下のPlaywrightスクリプトのパス。呼び出し元のcwdに依存させない。 */
export function zaimScriptPath(name: string): string {
  return fileURLToPath(new URL(`./scripts/${name}`, import.meta.url));
}

const KEEP_ALIVE_SCRIPT = zaimScriptPath("keep-alive.mjs");
const AUTO_LOGIN_SCRIPT = zaimScriptPath("auto-login.mjs");

/** 子プロセスの起動オプションのうち、呼び出し側が決めるもの。 */
export interface ZaimScriptOptions {
  timeout: number;
  maxBuffer?: number;
}

/**
 * テストから差し替えるための継ぎ目。既定は本物の `execFile` と `setTimeout`。
 * Playwrightを起動する経路をテストで踏まないようにするためだけに存在する。
 */
export interface ZaimScriptDeps {
  exec(script: string, options: ZaimScriptOptions): Promise<{ stdout: string }>;
  sleep(ms: number): Promise<void>;
}

const defaultDeps: ZaimScriptDeps = {
  async exec(script, options) {
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: process.env,
      timeout: options.timeout,
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
    return { stdout };
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 自動再ログインも失敗したことを、元の失効エラーへ書き足す。
 *
 * **元のメッセージは丸ごと残す。** `ZAIM_SESSION_EXPIRED` のマーカーを落とすと通知側が
 * 失効として分類しなくなり、失敗理由の1行目も失われる。マーカーは行を分けて足すため、
 * 通知に載る理由（`summarizeFailure`）の見た目は変わらない。
 */
function withAutoReloginFailed(cause: unknown): Error {
  return new Error(`${messageOf(cause)}\n${ZAIM_AUTO_RELOGIN_FAILED}`, { cause });
}

/**
 * Zaimのスクリプトを子プロセスで実行する。失敗の種類ごとに回復を試みる。
 *
 * 1. **一時的な失敗**（ネットワーク断・タイムアウト等）は間を空けて再試行する。
 *    Cookieは2時間で失効し、アクセスのたびに延長される。つまり維持できるかは
 *    「2時間以内に1回でも成功したか」だけで決まるため、その場で粘る価値が大きい。
 * 2. **セッション失効**は再試行では直らない。資格情報（`ZAIM_EMAIL`/`ZAIM_PASSWORD`）が
 *    設定されていれば**1度だけ**自動再ログインを挟み、成功したら元の処理をやり直す。
 * 3. 資格情報が無い／自動再ログインも失敗した場合は、**元の失効エラーを投げる**。
 *    `ZAIM_SESSION_EXPIRED` のマーカーを保つことで、通知側（`src/worker/notify.ts`）が
 *    セッション失効として扱える。**自動再ログインを試したうえで直らなかった場合だけ**
 *    `ZAIM_AUTO_RELOGIN_FAILED` を足し、通知が「手動ログインが要る」と書き分けられるようにする
 *    （#191。資格情報が無いだけの環境と、自動でも直らない状態は別物）。
 *
 * 資格情報の値はここでは読まない（設定の有無だけを見る）。実際の値は子プロセスへ
 * 環境変数として渡り、ログにも例外にも出ない。
 */
export async function runZaimScript(
  script: string,
  options: ZaimScriptOptions,
  deps: ZaimScriptDeps = defaultDeps,
): Promise<string> {
  let reloginAttempted = false;
  let transientFailures = 0;

  for (;;) {
    try {
      const { stdout } = await deps.exec(script, options);
      return stdout;
    } catch (cause) {
      const message = messageOf(cause);

      if (!isRetriableZaimFailure(message)) {
        // セッション失効。再試行しても同じ結果になるので、再ログインだけを試す。
        // 再ログイン後にまた失効した場合は自動では直らないため、マーカーを付けて投げる。
        if (reloginAttempted) throw withAutoReloginFailed(cause);
        reloginAttempted = true;

        // 資格情報が無い環境では自動再ログインを試していない。マーカーを付けずに投げ、
        // 通知側が「自動では直らない」と誤って書かないようにする。
        if (!readZaimCredentials()) throw cause;

        try {
          await deps.exec(AUTO_LOGIN_SCRIPT, { timeout: AUTO_LOGIN_TIMEOUT_MS });
        } catch (loginCause) {
          // 自動再ログインの失敗理由はログに残すが、投げるのは元の失効エラー（にマーカーを
          // 足したもの）。丸ごと差し替えると通知が「セッション失効」として分類されなくなる。
          console.error(`[zaim] 自動再ログインに失敗しました: ${messageOf(loginCause)}`);
          throw withAutoReloginFailed(cause);
        }

        console.log("[zaim] セッションが失効していたため自動で再ログインしました");
        continue;
      }

      transientFailures += 1;
      const delay = retryDelayMs(transientFailures);
      if (delay === null) throw cause;

      console.warn(
        `[zaim] ${transientFailures}回目の失敗。${delay / 1000}秒後に再試行します: ${message.split("\n")[0]}`,
      );
      await deps.sleep(delay);
    }
  }
}

/**
 * Zaimのログインセッションを延長する。
 *
 * 認証Cookieは約2時間で失効するが、アクセスのたびにその時点から延長される。
 * 巡回を行わない時間帯もこれを回しておけば、手動ログインなしで維持できる。
 * 残高画面を1ページ開くだけなので、巡回に比べて軽い。
 */
export async function keepZaimSessionAlive(deps?: ZaimScriptDeps): Promise<void> {
  await runZaimScript(KEEP_ALIVE_SCRIPT, { timeout: KEEP_ALIVE_TIMEOUT_MS }, deps);
}
