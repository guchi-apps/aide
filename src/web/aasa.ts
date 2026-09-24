import type { ServerResponse } from "node:http";

/**
 * iOSアプリ（AIDE iOS）のUniversal Links用 `apple-app-site-association`（#464）。
 *
 * AppleのCDNとiOSは、`/.well-known/apple-app-site-association` を**リダイレクトなし・拡張子なし**で
 * 取りに来る。認証も通さない（通すと検証に失敗する）ので、`handleAsset` と同じ公開の静的応答にする。
 *
 * Team ID は `AIDE_IOS_TEAM_ID` から読む。公開される値で秘密ではないが、ソースへ直書きせず
 * 設定に置く。未設定なら**空の appID を配信せず404**にする（半端な内容をAppleにキャッシュさせない）。
 */

export const AASA_PATH = "/.well-known/apple-app-site-association";

/** iOSアプリのBundle ID。 */
export const IOS_BUNDLE_ID = "com.gucchii.AIDEios";

/**
 * アプリで開かない経路。認証はアプリ側で扱うため、ログインの受け口とAPIはブラウザに残す。
 * Appleの仕様では components は先頭から順に評価され、最初に一致したものが効く。
 */
const EXCLUDED_PATHS = ["/status/auth/*", "/auth/*", "/api/*"];

/** Team ID が未設定なら null。 */
export function aasa(teamId: string | undefined): unknown | null {
  const id = teamId?.trim();
  if (!id) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [`${id}.${IOS_BUNDLE_ID}`],
          components: [
            ...EXCLUDED_PATHS.map((path) => ({ "/": path, exclude: true })),
            { "/": "/*" },
          ],
        },
      ],
    },
  };
}

/** GET/HEAD を処理する。担当外のパスなら false を返す。 */
export function handleAasa(
  method: string | undefined,
  path: string,
  res: ServerResponse,
  teamId: string | undefined = process.env["AIDE_IOS_TEAM_ID"],
): boolean {
  if (path !== AASA_PATH || (method !== "GET" && method !== "HEAD")) return false;
  const body = aasa(teamId);
  if (body === null) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
    return true;
  }
  const json = JSON.stringify(body);
  res
    .writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(json)),
      "Cache-Control": "public, max-age=3600",
    })
    .end(method === "HEAD" ? undefined : json);
  return true;
}
