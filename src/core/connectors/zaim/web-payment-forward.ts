import type {
  CreateWebPaymentOutcome,
  ZaimWebPaymentInput,
  ZaimWebPaymentRegistered,
} from "./web-payment.ts";
import { WEB_PAYMENT_TIMEOUT_MS } from "./web-payment.ts";

/**
 * Web版の入力画面からの登録を、**それが成立するマシンへ中継する**（#215）。
 *
 * ## なぜ要るのか
 *
 * `POST /api/zaim/payment/web` は Playwright とログイン状態（`data/zaim/storage-state.json`）が
 * ある環境——いまはサブPC——でしか成立しない。ところが呼び出し元（asset-manager）も AIDE の
 * サーバーもVPSにいるため、**#214 の実装だけでは呼び出し元から一度も届かない**。
 *
 * そこでサブPCにもこの1経路だけを開いた受け口（`src/worker/zaim-web-server.ts`）を常駐させ、
 * VPSの同じパスがそこへ同期で中継する。**呼び出し元から見えるURLは変えない**——
 * asset-manager が知っているのは `AIDE_BASE_URL` だけで、AIDEの置き場所は AIDE 側の都合だから。
 *
 * ## 記録はここに残さない
 *
 * 二重登録を止める記録（`web-idempotency.ts`）は**実際に画面を操作した側にだけ**残す。
 * 中継する側にも書くと、サブPCが登録できていないのにVPSでは「登録済み」になり、
 * 再送が永久に `duplicated` で返る。中継はHTTPの往復と失敗の分類だけを持つ。
 */

/** 中継先のURL。未設定なら中継しない（＝自分のところで画面を操作する）。 */
export function zaimWebUpstreamUrl(): string | null {
  const raw = process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"]?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

/**
 * 中継したことを表すヘッダ。
 *
 * **受け側はこれが付いていたらもう中継しない。** 受け側の `.env` に中継先URLが残っていると
 * 2台のあいだで永久に回り続けるため、1往復で必ず止める。
 */
export const ZAIM_WEB_FORWARDED_HEADER = "x-aide-zaim-web-forwarded";

/**
 * 中継の上限。
 *
 * 相手は画面を操作して数十秒かける（上限 `WEB_PAYMENT_TIMEOUT_MS`）。**その上限より必ず長く取る**——
 * 短いと、相手が正常に失敗を返そうとしている最中にこちらが切ることになり、
 * 「登録されたか分からない」状態を自分で作る。
 */
export const ZAIM_WEB_FORWARD_TIMEOUT_MS = WEB_PAYMENT_TIMEOUT_MS + 30_000;

/**
 * 接続そのものが確立できなかったことを示すエラーコード。
 *
 * **ここに当てはまる失敗だけ「Zaimには何も登録されていない」と言い切れる。** リクエストが
 * 相手のプロセスへ届いていないため。それ以外（応答待ちでの切断・打ち切り）は、相手が
 * すでに送信ボタンを押していた可能性が残る。
 */
const NOT_DELIVERED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
]);

/**
 * 相手が画面を操作する前に断ったと分かるHTTPステータス。
 *
 * 認証・設定・叩き方の誤りで、いずれも**Zaimへは何も送られていない**。`rejected` にすると
 * 呼び出し元は直して送り直せる（`failed` にすると人がZaimを確認するまで止まる）。
 */
const NOT_STARTED_STATUSES = new Set([401, 403, 404, 405, 413, 429, 503]);

/** 相手の応答に載っていた `kind` として信用してよい値。 */
const KNOWN_KINDS = new Set(["invalid", "conflict", "rejected", "failed"]);

function errorCode(cause: unknown): string | null {
  let current: unknown = cause;
  // fetch の失敗は `TypeError: fetch failed` で、実際の理由は cause に入れ子で入る。
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 相手が返した「実際に入力された内容」を読み直す。
 *
 * **これは呼び出し元が桁違いや口座の取り違えに気づくための値**なので、読めなかった項目を
 * 入力値で埋めない（埋めると「送ったとおりに入っていた」と誤って見える）。
 */
function normalizeRegistered(raw: unknown): ZaimWebPaymentRegistered | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  return {
    date: text("date"),
    amount: typeof value["amount"] === "number" ? value["amount"] : 0,
    name: text("name"),
    place: text("place"),
    genre: text("genre"),
    accountName: text("accountName"),
    comment: text("comment"),
  };
}

/**
 * 受け口が生きているかだけを確かめる（動作状況ページの「疎通を確認する」から呼ぶ）。
 *
 * **配線が効いているかを確かめる手段がこれしか無い。** 実際に登録して確かめると本物の明細が
 * でき、この経路には削除が無いので人がZaimの画面から手で消すことになる。
 *
 * **URLも理由の全文も返さない。** 中継先はTailscaleのアドレスそのもので、画面へ出す値ではない
 * （`runProbes()` が「コネクタ側で外へ出してよい粒度に丸めてある」前提で動いている）。
 * 相手は静的な `/health` を返すだけなので、待つのは3秒で足りる。
 */
export async function probeZaimWebUpstream(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const base = zaimWebUpstreamUrl();
  if (!base) return { ok: false, detail: "未設定" };
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true, detail: "" };
  } catch (cause) {
    const code = errorCode(cause);
    return { ok: false, detail: code ?? (cause instanceof Error ? cause.name : "接続できない") };
  }
}

export interface ZaimWebForwardOptions {
  /** 中継先の基底URL（末尾の `/` は付けない）。 */
  baseUrl: string;
  /** 中継先の認証に使う値。`AIDE_ZAIM_WRITE_SECRET` を両方のマシンで同じにする。 */
  secret: string;
  timeoutMs?: number;
  /** テスト用の差し替え。 */
  fetchImpl?: typeof fetch;
}

/**
 * 中継先の応答を、ローカルで実行したときと同じ形へ戻す。
 *
 * **相手が返した `kind` はそのまま通す。** 特に `conflict`（前回の結果が確定していない）を
 * 別の分類へ潰すと、呼び出し元が再送してよいかの判断を誤り、同じ支出が2件できうる。
 */
export async function forwardZaimWebPayment(
  input: ZaimWebPaymentInput,
  options: ZaimWebForwardOptions,
): Promise<CreateWebPaymentOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/zaim/payment/web`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.secret}`,
        "content-type": "application/json",
        [ZAIM_WEB_FORWARDED_HEADER]: "1",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(options.timeoutMs ?? ZAIM_WEB_FORWARD_TIMEOUT_MS),
    });
  } catch (cause) {
    const code = errorCode(cause);
    if (code !== null && NOT_DELIVERED_CODES.has(code)) {
      return {
        ok: false,
        kind: "rejected",
        reason:
          `Zaim Web版の登録を行うマシンへ接続できませんでした（${code}）。` +
          "Zaimには何も登録されていません。受け口が起動しているかを確認してください。",
      };
    }
    // 打ち切り・応答待ちでの切断。**送信ボタンを押した後かもしれない**ので言い切らない。
    const name = cause instanceof Error ? cause.name : "Error";
    return {
      ok: false,
      kind: "failed",
      reason:
        `Zaim Web版の登録を行うマシンとの通信が途切れました（${code ?? name}）。` +
        "登録されたかどうかは分かりません。Zaimの画面で確認してください。",
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (response.ok && body?.["ok"] === true) {
    return {
      ok: true,
      moneyId: null,
      duplicated: body["duplicated"] === true,
      registered: normalizeRegistered(body["registered"]),
    };
  }

  const kind = typeof body?.["kind"] === "string" ? (body["kind"] as string) : null;
  const reason = typeof body?.["error"] === "string" ? (body["error"] as string) : null;

  if (kind !== null && KNOWN_KINDS.has(kind)) {
    return {
      ok: false,
      kind: kind as "invalid" | "conflict" | "rejected" | "failed",
      reason: reason ?? `Zaim Web版の登録に失敗しました（${kind}）`,
    };
  }

  if (NOT_STARTED_STATUSES.has(response.status)) {
    return {
      ok: false,
      kind: "rejected",
      reason:
        `Zaim Web版の登録を行うマシンが受け付けませんでした（HTTP ${response.status}）。` +
        `Zaimには何も登録されていません。${reason ?? ""}`.trimEnd(),
    };
  }

  return {
    ok: false,
    kind: "failed",
    reason:
      `Zaim Web版の登録を行うマシンの応答を読めませんでした（HTTP ${response.status}）。` +
      "登録されたかどうかは分かりません。Zaimの画面で確認してください。",
  };
}
