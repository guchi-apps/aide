import { createServer } from "node:http";
import { WEB_PAYMENT_TIMEOUT_MS } from "../core/connectors/zaim/web-payment.ts";
import { checkZaimWebServerConfig, handleZaimWebRequest } from "./zaim-web-routes.ts";

/**
 * Zaim Web版の入力画面からの登録を受け付ける、**サブPC側の常駐サーバー**（#215）。
 *
 *   node --env-file-if-exists=.env src/worker/zaim-web-server.ts
 *
 * ## なぜ worker だけでは足りないのか
 *
 * `worker/run.ts` のジョブはワンショットで、**自分から取りに行く**もの（巡回・天気）。
 * 一方これは asset-manager（VPS）が「いまこの1件を登録してほしい」と押し込んでくる経路で、
 * 呼ばれた時点で画面を操作する必要がある。定期実行では代われない。
 *
 * ## 待ち受ける場所
 *
 * 既定は `127.0.0.1`。**本番（サブPC）では Tailscale のアドレスを明示する**
 * （`AIDE_ZAIM_WEB_HOST`）。LANや外へ出さないのは、この口がZaimへの書き込みそのもの
 * だから——シークレットで守ってはいるが、届く範囲は狭いほどよい。
 *
 * ポートの既定は 4748。本体（`src/server.ts`）の既定 4747 の隣に置き、同じマシンで
 * 両方を起動しても衝突しないようにしている。
 *
 * ## 落ちたときにどうなるか
 *
 * VPS側の中継は接続できないことを `rejected`（Zaimには何も登録していない）として返す。
 * asset-manager は確認待ちで止まり、勝手に公式APIへは倒れない。**復旧後に送り直せば続きから
 * 登録できる**ので、常駐が止まっている間に取りこぼしが増えることは無い。
 */

const PORT = Number(process.env["AIDE_ZAIM_WEB_PORT"] ?? 4748);
const HOST = process.env["AIDE_ZAIM_WEB_HOST"] ?? "127.0.0.1";

const config = checkZaimWebServerConfig();
if (!config.ok) {
  // 起動時に落とす。開かないまま常駐していても、呼ばれるまで誰も気づけない。
  console.error(`[zaim-web] 起動できません: ${config.reason}`);
  process.exit(2);
}

const server = createServer((req, res) => {
  void handleZaimWebRequest(req, res).catch((cause: unknown) => {
    console.error("[zaim-web] 未処理の例外", cause);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

// **既定（2分）では足りない。** 画面の操作に最大 WEB_PAYMENT_TIMEOUT_MS かかり、
// Nodeがその前にソケットを切ると、呼び出し元には「登録されたか分からない」失敗だけが残る。
server.requestTimeout = WEB_PAYMENT_TIMEOUT_MS + 60_000;
server.headersTimeout = 60_000;
// 呼び出し元は1件ずつ送るため、応答後の接続は長く抱えない。
server.keepAliveTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`AIDE Zaim Web版登録の受け口: http://${HOST}:${PORT}/api/zaim/payment/web`);
});
