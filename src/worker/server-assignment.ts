import { hostname } from "node:os";
import { describeFetchError } from "./sink.ts";
import { COLOR_WARNING, type DiscordPayload, formatJst, send, webhookUrl } from "./notify.ts";

/**
 * worker 側の担当の問い合わせ（#891）。
 *
 * ジョブを始める前に、AIDE のサーバー（VPS）の `POST /api/worker/claim` へ「このホストがいま動かして
 * よいか」を聞く。サーバーは問い合わせをハートビートとして記録し、担当ホストを判定して返す
 * （判定は `src/core/worker-assignment.ts`）。
 *
 * - `AIDE_INGEST_URL` が無い（開発機・サーバーと同居）: 問い合わせない。従来どおり動かす
 * - 問い合わせに失敗した（VPSに届かない・認証の誤り）: **動かさない。** 二重実行より停止の方が
 *   気づける——実行記録（`job-<name>`）が古くなり、動作状況（`/api/status`）が知らせる
 * - サーバーが404を返した: **まだ口の無い版のサーバー**として扱い、従来どおり（`AIDE_WORKER_JOBS` だけで）動かす。
 *   worker は `origin/develop` を毎時追従する（`self-update`）一方、VPS は `main` からデプロイされるため、
 *   リリースまでの間は必ずこの状態になる。ここで止めると、その間すべてのジョブが止まる
 */

/** 問い合わせの待ち時間。2分ごとのジョブ（`TimeoutStartSec=1min`）の時間を食いすぎないよう、再試行もしない。 */
export const CLAIM_TIMEOUT_MS = 10_000;

export interface ClaimNotice {
  at: string;
  from: string;
  to: string;
  reason: "failover" | "failback" | "manual";
}

export interface ClaimResponse {
  run: boolean;
  owner: string;
  mode: string;
  notice: ClaimNotice | null;
}

export type ClaimOutcome =
  | { kind: "local" }
  | { kind: "unsupported" }
  | { kind: "decided"; response: ClaimResponse }
  | { kind: "failed"; reason: string };

/**
 * このホストの名前。`AIDE_WORKER_HOST` が無ければ OS のホスト名の先頭ラベル（`macmini.local` → `macmini`）。
 * サーバーが知っているのは `subpc`・`macmini` だけなので、ホスト名が違う機では `.env` に書く。
 */
export function workerHostName(): string {
  const explicit = process.env["AIDE_WORKER_HOST"]?.trim();
  if (explicit) return explicit;
  return (hostname().split(".")[0] ?? "").toLowerCase();
}

export async function askServer(
  job: string,
  deps: { fetch?: typeof fetch; host?: string } = {},
): Promise<ClaimOutcome> {
  const url = process.env["AIDE_INGEST_URL"];
  if (!url) return { kind: "local" };
  const secret = process.env["AIDE_INGEST_SECRET"];
  if (!secret) return { kind: "failed", reason: "AIDE_INGEST_URL が設定されていますが AIDE_INGEST_SECRET がありません" };

  const endpoint = `${url.replace(/\/$/, "")}/api/worker/claim`;
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ host: deps.host ?? workerHostName(), job }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: "unsupported" };
    if (!response.ok) {
      return { kind: "failed", reason: `${response.status} ${(await response.text()).slice(0, 200)}` };
    }
    const body = (await response.json()) as Partial<ClaimResponse>;
    if (typeof body.run !== "boolean" || typeof body.owner !== "string") {
      return { kind: "failed", reason: "応答の形が想定と違います" };
    }
    return {
      kind: "decided",
      response: {
        run: body.run,
        owner: body.owner,
        mode: typeof body.mode === "string" ? body.mode : "auto",
        notice: body.notice ?? null,
      },
    };
  } catch (cause) {
    return { kind: "failed", reason: describeFetchError(cause) };
  }
}

const REASON_TEXT: Record<ClaimNotice["reason"], string> = {
  failover: "担当ホストからの問い合わせが途切れたため、自動で引き継ぎました。",
  failback: "主のホストの問い合わせが続いているため、自動で主へ戻しました。",
  manual: "担当の固定（手動の切り替え）により移しました。",
};

export function buildSwitchPayload(notice: ClaimNotice, mode: string): DiscordPayload {
  return {
    embeds: [
      {
        title: `🔀 [AIDE] worker の担当を ${notice.from} → ${notice.to} へ切り替えました`,
        description:
          `${REASON_TEXT[notice.reason]}\n` +
          "Zaim のログイン状態はホストごとに別なので、引き継いだ側で再ログインが要ることがあります" +
          "（`zaim-keep-alive` の結果を確認してください）。",
        color: COLOR_WARNING,
        fields: [
          { name: "切り替え時刻", value: formatJst(new Date(notice.at)), inline: true },
          { name: "モード", value: mode === "auto" ? "自動" : `${mode} に固定`, inline: true },
        ],
      },
    ],
  };
}

/** 切り替えを Discord へ知らせる。**呼び出し側を失敗させない。** */
export async function notifySwitch(notice: ClaimNotice, mode: string): Promise<void> {
  const url = webhookUrl();
  if (!url) {
    console.log(`[assignment] 担当の切り替えを受け取りました（${notice.from} → ${notice.to}）が、通知先が未設定です`);
    return;
  }
  try {
    await send(url, buildSwitchPayload(notice, mode));
  } catch (cause) {
    console.error(`[assignment] 切り替えの通知に失敗しました: ${cause instanceof Error ? cause.message : cause}`);
  }
}
