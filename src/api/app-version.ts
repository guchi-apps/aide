import type { ServerResponse } from "node:http";
import { getProcessInfo } from "../core/process-info.ts";

/**
 * `GET /api/app-version` の応答本文（#662）。
 *
 * `sha` は `deploy.yml` が `.env` へ書く `APP_COMMIT_SHA`。デプロイのヘルスチェックはこれが
 * 今回デプロイしたコミットと一致するまで成功にしない（旧版が `/health` に200を返しているだけの
 * 状態を成功と見なさないため）。issue-deck の新方式リリースもこの値で稼働中の版を照合する。
 * ローカル開発など未設定なら `null`（推測値は返さない）。
 */
export interface AppVersionBody {
  version: string;
  sha: string | null;
}

export function buildAppVersion(
  env: NodeJS.ProcessEnv = process.env,
  version: string = getProcessInfo().version,
): AppVersionBody {
  const sha = env["APP_COMMIT_SHA"]?.trim();
  return { version, sha: sha ? sha : null };
}

/**
 * 認証を通さない。返すのは公開リポジトリのコミットSHAと版だけで、デプロイ直後に
 * 127.0.0.1 から curl で取れる必要があるため（`/health` と同じ扱い）。
 * 取り違えを避けるため常にキャッシュさせない。
 */
export function handleAppVersion(method: string | undefined, res: ServerResponse): void {
  const body = JSON.stringify(buildAppVersion());
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(method === "HEAD" ? undefined : body);
}
