import {
  NOT_DELIVERED_CODES,
  ZAIM_WEB_FORWARDED_HEADER,
  type ZaimWebForwardOptions,
  errorCode,
} from "./web-payment-forward.ts";

/**
 * 商品内訳の手動再取得（#600）を、サブPCの受け口へ中継する。
 *
 * 登録・編集の中継（`web-payment-forward.ts`）と違い、**数十秒待たない。** サブPC側は依頼を受け付けて
 * すぐ `jobId` を返し、状態は `GET` で読むため、1回の往復は短い。待ち時間の上限も短く取り、
 * VPSの応答がWebのタイムアウトに掛からないようにする。
 *
 * **サブPCの失敗はジョブの失敗と別の `kind` で返す**（`subpc_*`）。サブPCが止まっている・
 * 通信が届かない・受け口が未更新、のいずれも「取得を試みていない」ことが確かなので、
 * 呼び出し元は取得失敗（Zaim側の問題）と切り分けられる。
 */

export const ZAIM_RECEIPT_REFRESH_PATH = "/api/zaim/receipt-detail/refresh";

/** ジョブ1件の状態を読むパスから、ジョブIDを取り出す。 */
export function receiptRefreshJobId(path: string): string | null {
  const prefix = `${ZAIM_RECEIPT_REFRESH_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  // ジョブIDはUUID。パスの区切りや想定外の文字は受け付けない。
  return /^[0-9a-f-]{8,64}$/.test(id) ? id : null;
}

/** 受付・状態の読み取りはどちらも即座に返る。 */
const FORWARD_TIMEOUT_MS = 20_000;

/** サブPCの応答に載っていてよい失敗の種類。それ以外は中継の失敗として扱い直す。 */
const KNOWN_FAILURE_KINDS = new Set([
  "busy",
  "session_expired",
  "not_found",
  "detail_failed",
  "fetch_failed",
  "internal",
  "invalid",
  "job_not_found",
]);

export interface ForwardedResponse {
  status: number;
  body: Record<string, unknown>;
}

function subpcFailure(kind: string, message: string, retryable: boolean): ForwardedResponse {
  return { status: 502, body: { ok: false, failure: { kind, retryable, message } } };
}

export async function forwardReceiptRefresh(
  request: { method: "POST"; body: unknown } | { method: "GET"; jobId: string },
  options: ZaimWebForwardOptions,
): Promise<ForwardedResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const url =
    request.method === "POST"
      ? `${base}${ZAIM_RECEIPT_REFRESH_PATH}`
      : `${base}${ZAIM_RECEIPT_REFRESH_PATH}/${encodeURIComponent(request.jobId)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${options.secret}`,
        [ZAIM_WEB_FORWARDED_HEADER]: "1",
        ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? FORWARD_TIMEOUT_MS),
    });
  } catch (cause) {
    const code = errorCode(cause);
    if (code !== null && NOT_DELIVERED_CODES.has(code)) {
      return subpcFailure(
        "subpc_unreachable",
        `Zaimの取得を行うサブPCへ接続できませんでした（${code}）。取得は開始されていません。サブPCの受け口が起動しているかを確認してください。`,
        true,
      );
    }
    const name = cause instanceof Error ? cause.name : "Error";
    return subpcFailure(
      "subpc_timeout",
      `Zaimの取得を行うサブPCとの通信が途切れました（${code ?? name}）。受付済みかどうかは分かりません。`,
      true,
    );
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  const failure = body?.["failure"] as { kind?: unknown } | undefined;
  const upstreamKind = typeof failure?.kind === "string" ? failure.kind : null;

  // 受け口の判断（受付・ジョブの状態・取得の失敗）はそのまま通す。
  if (body && (body["ok"] === true || (upstreamKind !== null && KNOWN_FAILURE_KINDS.has(upstreamKind)))) {
    return { status: response.status, body };
  }

  if ([401, 403, 404, 405, 503].includes(response.status)) {
    return subpcFailure(
      "subpc_rejected",
      `サブPCの受け口が依頼を受け付けませんでした（HTTP ${response.status}）。シークレットの不一致か、サブPCの受け口が未更新の可能性があります。`,
      false,
    );
  }
  return subpcFailure(
    "subpc_bad_response",
    `サブPCの応答を読めませんでした（HTTP ${response.status}）。`,
    true,
  );
}
