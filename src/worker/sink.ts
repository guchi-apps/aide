import { writeCache } from "../core/cache/store.ts";

/**
 * 取得結果の書き出し先。
 *
 * worker と MCPサーバーが同じマシンにいるとは限らない。
 * 本番では worker はサブPC、サーバーはVPSで動くため、ファイル共有ができない。
 *
 * `AIDE_INGEST_URL` が設定されていればHTTPで送り、無ければローカルのキャッシュへ書く。
 * これにより開発機（両方ローカル）と本番（別マシン）で同じコードが動く。
 */
export async function publish(key: string, source: string, data: unknown): Promise<string> {
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

  const endpoint = `${url.replace(/\/$/, "")}/api/cache/${key}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ source, data }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`送信に失敗しました: ${response.status} ${await response.text()}`);
  }
  return `${endpoint} へ送信した`;
}
