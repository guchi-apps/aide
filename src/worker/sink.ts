import { setTimeout as sleep } from "node:timers/promises";
import { writeCache } from "../core/cache/store.ts";

/**
 * 1回の送信で待つ上限。VPSが応答しないまま止まっているときに、ジョブを居座らせない。
 */
const SEND_TIMEOUT_MS = 30_000;

/**
 * 既定で試す回数（初回を含む）。
 *
 * **サブPC→VPSの送信は一時的に繋がらないことがある**（#295）。2026-09-12〜18 のジャーナルでは
 * zaim-sync・claude-sessions-sync・weather-sync・実行記録がいずれも `fetch failed`
 * （接続タイムアウト）で落ちており、直後の別の送信は通っていた。送信は同じキーへの上書きで
 * 何度送っても結果が変わらないため、やり直してよい。
 *
 * とくに zaim-sync は1日2回しか走らず、送信で落ちると巡回できていたのに残高が12時間古い
 * まま残る。巡回からやり直すとZaimへ余計にアクセスするので、送信だけをやり直す。
 */
export const DEFAULT_PUBLISH_ATTEMPTS = 3;

/**
 * 再試行前に空ける時間。`attempt` 回目（1始まり）の失敗のあとに `[attempt - 1]` を使う。
 *
 * 最悪の所要は (30秒 × 3) + 20秒 = 110秒。短い間隔で回すジョブ（`TimeoutStartSec` が短い）
 * は呼び出し側で `attempts` を減らす。
 */
const RETRY_DELAYS_MS = [5_000, 15_000] as const;

export interface PublishOptions {
  /** 試す回数（初回を含む）。1なら再試行しない。 */
  attempts?: number;
}

/** テストで差し替えるための依存。 */
export interface PublishDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * 取得結果の書き出し先。
 *
 * worker と MCPサーバーが同じマシンにいるとは限らない。
 * 本番では worker はサブPC、サーバーはVPSで動くため、ファイル共有ができない。
 *
 * `AIDE_INGEST_URL` が設定されていればHTTPで送り、無ければローカルのキャッシュへ書く。
 * これにより開発機（両方ローカル）と本番（別マシン）で同じコードが動く。
 */
export async function publish(
  key: string,
  source: string,
  data: unknown,
  options: PublishOptions = {},
  deps: PublishDeps = {},
): Promise<string> {
  const url = process.env["AIDE_INGEST_URL"];
  const secret = process.env["AIDE_INGEST_SECRET"];

  if (!url) {
    await writeCache(key, source, data);
    return "ローカルのキャッシュへ書いた";
  }
  if (!secret) {
    // 送信先だけ設定されていて認証情報が無いのは設定ミス。黙ってローカルへ書くと
    // 「送ったつもりで届いていない」状態になるため、失敗させる。
    throw new Error("AIDE_INGEST_URL が設定されていますが AIDE_INGEST_SECRET がありません");
  }

  const doFetch = deps.fetch ?? fetch;
  const wait = deps.sleep ?? sleep;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_PUBLISH_ATTEMPTS);
  const endpoint = `${url.replace(/\/$/, "")}/api/cache/${key}`;
  const body = JSON.stringify({ source, data });

  for (let attempt = 1; ; attempt++) {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).catch((cause: unknown) => describeFetchError(cause));

    let failure: string;
    if (typeof response === "string") {
      failure = response;
    } else {
      if (response.ok) {
        const retried = attempt > 1 ? `（${attempt}回目で成功）` : "";
        return `${endpoint} へ送信した${retried}`;
      }
      failure = `${response.status} ${await response.text()}`;
      // 4xx は認証や未知のキーなど、やり直しても同じ結果になる失敗。
      if (!isRetriableStatus(response.status)) {
        throw new Error(`送信に失敗しました: ${failure}`);
      }
    }

    if (attempt >= attempts) {
      const tried = attempts > 1 ? `（${attempts}回試行）` : "";
      throw new Error(`送信に失敗しました${tried}: ${failure}`);
    }
    await wait(retryDelayMs(attempt));
  }
}

/** 5xx と 429 は受け口側の一時的な不調なので、やり直す価値がある。 */
export function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** `attempt` 回目（1始まり）の失敗のあとに空ける時間。 */
export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 0;
}

/**
 * fetch の例外を1行にする。
 *
 * Node の fetch は通信の失敗をすべて `TypeError: fetch failed` で投げ、本当の理由
 * （接続タイムアウト・名前解決の失敗・切断など）は `cause` にしか入っていない。
 * メッセージだけを残すと、#295 のように「何が起きたのか」を後から辿れなくなる。
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return error.message;
  const code = (cause as { code?: unknown }).code;
  const detail = typeof code === "string" && code !== "" ? code : (cause as Error).message;
  return detail ? `${error.message}（${detail}）` : error.message;
}
