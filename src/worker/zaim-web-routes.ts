import type { IncomingMessage, ServerResponse } from "node:http";
import { handleZaimWebPayment, zaimWriteSecret } from "../api/zaim.ts";
import { zaimWebUpstreamUrl } from "../core/connectors/zaim/web-payment-forward.ts";

/**
 * サブPC側の受け口が処理するリクエスト（#215）。
 *
 * 起動そのものは `zaim-web-server.ts`。**ここに分けてあるのは、待ち受けを始めずに
 * 経路の判定を検査できるようにするため**（`src/server.ts` はモジュールを読んだ時点で
 * listen するので同じことができない）。
 */

/** 待ち受けるパス。**この1本以外は開かない。** */
export const ZAIM_WEB_PAYMENT_PATH = "/api/zaim/payment/web";

export type ZaimWebRoute = "health" | "payment" | "not-found";

/**
 * パスから経路を決める。
 *
 * **MCPもOAuthも画面も載せない。** 本体（`src/server.ts`）をそのままサブPCで動かせば
 * 済むように見えるが、それだと認可サーバーとログイン画面がもう1組でき、`data/auth/` が
 * 二重になる。ここで要るのは「Zaimの画面を操作する」1経路だけなので、それだけを開く。
 *
 * `/health` は systemd と人が生死を見るためのもので、認証を通さない代わりに
 * **何の情報も載せない**（`ok` の1語だけ）。
 */
export function routeZaimWeb(path: string): ZaimWebRoute {
  if (path === "/health") return "health";
  if (path === ZAIM_WEB_PAYMENT_PATH) return "payment";
  return "not-found";
}

/**
 * 起動してよい状態かを確かめる。
 *
 * **シークレットが無ければ起動しない。** 本体サーバーの `/api/zaim/*` は未設定なら503を返す
 * だけでよい（他の機能が生きている）が、この受け口はこの1経路のためだけに常駐するので、
 * 開かないまま動いていても意味が無く、気づく口も無い。
 *
 * 中継先URLが設定されていたら止める。**受け口とVPSの `.env` を取り違えた状態**で、
 * そのまま動かすと登録が2台のあいだを往復しかねない（1往復で止まるようにはしてあるが、
 * どちらが画面を操作するのかが設定から読み取れなくなる）。
 */
export function checkZaimWebServerConfig(): { ok: true } | { ok: false; reason: string } {
  if (!zaimWriteSecret()) {
    return {
      ok: false,
      reason:
        "AIDE_ZAIM_WRITE_SECRET が未設定です。この受け口はZaimへの登録専用なので、" +
        "設定せずに起動しても何も受け付けられません。VPSと同じ値を .env へ設定してください。",
    };
  }
  if (zaimWebUpstreamUrl()) {
    return {
      ok: false,
      reason:
        "AIDE_ZAIM_WEB_UPSTREAM_URL が設定されています。これは中継する側（VPS）の設定です。" +
        "画面を操作するこの受け口では設定しないでください。",
    };
  }
  return { ok: true };
}

/**
 * 受け口のリクエストを処理する。
 *
 * 認証・ボディの検査・失敗の分類は本体と**同じ実装**（`handleZaimWebPayment`）を通す。
 * 中継の途中で結果の読み方が変わらないようにするため、ここで別の応答を作らない。
 */
export async function handleZaimWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  switch (routeZaimWeb(path)) {
    case "health":
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      return;
    case "payment":
      await handleZaimWebPayment(req, res);
      return;
    default:
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
  }
}
