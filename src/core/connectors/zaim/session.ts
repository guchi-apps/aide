import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZAIM_AUTO_RELOGIN_FAILED } from "./errors.ts";
import { isRetriableZaimFailure, readZaimCredentials, retryDelayMs } from "./retry.ts";

const execFileAsync = promisify(execFile);

const KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** 自動再ログインは画面遷移を伴うため、セッション延長より長めに取る。 */
const AUTO_LOGIN_TIMEOUT_MS = 180_000;

/**
 * `totalTimeout` の残りがこれを下回ったら、やり直さずに諦める。
 *
 * Chromiumの起動とページ読み込みだけで30秒近くかかるため、残りが数秒しかない状態で
 * やり直しても必ずタイムアウトで落ち、**元の失敗（セッション失効）が最後の例外に
 * 上書きされて通知の分類が壊れる**。逆に2分あれば、一括更新なら「データを更新する」を
 * 押すところまでは届く（押下さえ済めば65分後の巡回は新しい残高を読める）。
 */
const MIN_ATTEMPT_TIMEOUT_MS = 120_000;

/** `scripts/` 配下のPlaywrightスクリプトのパス。呼び出し元のcwdに依存させない。 */
export function zaimScriptPath(name: string): string {
  return fileURLToPath(new URL(`./scripts/${name}`, import.meta.url));
}

const KEEP_ALIVE_SCRIPT = zaimScriptPath("keep-alive.mjs");
const AUTO_LOGIN_SCRIPT = zaimScriptPath("auto-login.mjs");

/** 子プロセスの起動オプションのうち、呼び出し側が決めるもの。 */
export interface ZaimScriptOptions {
  /** 1回の実行の上限。 */
  timeout: number;
  maxBuffer?: number;
  /**
   * 子プロセスへ足す環境変数。`process.env` に**上書きで**重ねる。
   *
   * 登録の内容（金額・店名）はここで渡す。コマンドライン引数にすると `ps` に出るため。
   * 自動再ログインの子プロセスには渡さない（そちらは資格情報だけで足りる）。
   */
  env?: Record<string, string>;
  /**
   * 一時的な失敗（ネットワーク断・タイムアウト等）をやり直すか。既定は true。
   *
   * **書き込みでは false にする。** 巡回・セッション延長は何度実行しても結果が変わらないが、
   * 登録は変わる。送信の直後に打ち切られた場合、やり直すと同じ明細が2件できる——しかも
   * この経路は削除を持たないので、消すのは人の手作業になる。やり直さずに失敗させれば、
   * 呼び出し元の記録が「結果が確定していない」まま残り、次の再送を止められる。
   *
   * **セッション失効時の自動再ログインは false でも行う。** 失効はページを開いた時点で
   * 分かる（`session-check.mjs`）ため、送信より前で必ず起きる。
   */
  retryTransient?: boolean;
  /**
   * 再試行・自動再ログインを含めた**呼び出し全体**の上限。省略すると上限を設けない。
   *
   * 1回が数十秒で終わる処理（セッション延長・巡回）では、やり直しても次の定期実行に
   * 食い込まないため要らない。一方 **一括更新は1回で最大45分待つ**ので、上限が無いと
   * やり直した回が systemd の `TimeoutStartSec` に掛かって途中で殺される。
   * ここを渡すと、残り時間に収まらないやり直しを行わず、元の失敗をそのまま投げる。
   */
  totalTimeout?: number;
}

/**
 * テストから差し替えるための継ぎ目。既定は本物の `execFile`・`setTimeout`・`Date.now`。
 * Playwrightを起動する経路と、実時間の経過をテストで踏まないようにするためだけに存在する。
 */
export interface ZaimScriptDeps {
  exec(script: string, options: ZaimScriptOptions): Promise<{ stdout: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDeps: ZaimScriptDeps = {
  async exec(script, options) {
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      timeout: options.timeout,
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
    return { stdout };
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
  now() {
    return Date.now();
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
 * 4. `options.totalTimeout` を渡した場合、やり直しは**その残り時間に収まるときだけ**行う。
 *    収まらなければ、やり直さずに元の失敗を投げる（`MIN_ATTEMPT_TIMEOUT_MS` を参照）。
 *
 * 資格情報の値はここでは読まない（設定の有無だけを見る）。実際の値は子プロセスへ
 * 環境変数として渡り、ログにも例外にも出ない。
 */
export async function runZaimScript(
  script: string,
  options: ZaimScriptOptions,
  deps: ZaimScriptDeps = defaultDeps,
): Promise<string> {
  const startedAt = deps.now();
  let attemptTimeout = options.timeout;
  let reloginAttempted = false;
  let transientFailures = 0;

  /** 次の実行に割ける時間。全体の上限を使い切っていたら null（＝やり直さない）。 */
  function nextTimeout(): number | null {
    if (options.totalTimeout === undefined) return options.timeout;
    const remaining = options.totalTimeout - (deps.now() - startedAt);
    if (remaining < MIN_ATTEMPT_TIMEOUT_MS) return null;
    return Math.min(options.timeout, remaining);
  }

  for (;;) {
    try {
      const { stdout } = await deps.exec(script, { ...options, timeout: attemptTimeout });
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

        // 再ログイン自体は成功しているので、この実行でやり直せなくても次の定期実行は通る。
        const timeout = nextTimeout();
        if (timeout === null) {
          console.warn("[zaim] 残り時間が足りないため、再ログイン後のやり直しは行いません");
          throw cause;
        }
        attemptTimeout = timeout;
        continue;
      }

      // 書き込みは1回きり。やり直すと同じ明細が2件できうる（`retryTransient` を参照）。
      if (options.retryTransient === false) throw cause;

      transientFailures += 1;
      const delay = retryDelayMs(transientFailures);
      if (delay === null) throw cause;

      console.warn(
        `[zaim] ${transientFailures}回目の失敗。${delay / 1000}秒後に再試行します: ${message.split("\n")[0]}`,
      );
      await deps.sleep(delay);

      // 待っている間にも全体の上限は減る。待ち終えてから残りを見る。
      const timeout = nextTimeout();
      if (timeout === null) throw cause;
      attemptTimeout = timeout;
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
