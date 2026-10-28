import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 本番の `.env` は `.github/workflows/deploy.yml` がデプロイのたびにVPSのgate
 * （guchi-apps/vps の app-deploy-gate）へ送る値で書き換わる。**送っていない値はGitHub側に正が無く**、
 * 手作業の追記だけで運用されることになる。
 *
 * 実際に AIDE_GITHUB_TOKEN（aide#47）と AIDE_OPS_DASHBOARD_TOKEN（aide#42）が手作業の
 * 追記だけで運用されており、当時の deploy.yml（.env をまるごと上書きしていた）で消える状態だった（aide#55）。
 * これらが無くても例外にはならず、対応するMCPツールが「未設定」を返すだけなので、
 * 呼ぶまで誰も気づけない。**気づけない不具合は検査で塞ぐ。**
 *
 * このテストは `src/` が実行時に読む `AIDE_*` を洗い出し、それぞれが
 *
 *   1. `.github/secrets-manifest.tsv`（1Password → GitHub の対応表）
 *   2. deploy.yml のジョブの `env:`
 *   3. deploy.yml の「Send environment variables」ステップの `env:`
 *   4. 同ステップの改行チェックの `for name in ...` の一覧
 *   5. 同ステップが gate へ送る `printf '%s\n' "NAME=..."` の行
 *
 * すべてに載っていることを確かめる（#662 で gate へ移した）。本番で要らない値は下の NOT_REQUIRED_IN_PRODUCTION に
 * 理由付きで登録する。新しい `AIDE_*` を足した人は、必ずどちらかを選ぶことになる。
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));

/**
 * 本番（VPS）の `.env` に無くてよい `AIDE_*` と、その理由。
 * ここに足すのは「既定値で足りる」か「サブPCのworker側でしか読まない」場合に限る。
 */
const NOT_REQUIRED_IN_PRODUCTION: Record<string, string> = {
  AIDE_AUTH_DISABLED: "認証を切る開発用のスイッチ。本番では設定しない",
  AIDE_AUTH_STATE_PATH:
    "OAuthの状態（トークン等）の置き場。テストが本番の状態を汚さないための差し替えで、既定（data/auth/oauth-state.json）で足りる",
  AIDE_CACHE_DIR: "既定（リポジトリ基準の data/cache）で足りる",
  AIDE_CLAUDE_SESSIONS_DIR:
    "Claude Code のセッション台帳の置き場。読むのはサブPCのworkerだけで、既定（~/.claude/sessions）で足りる",
  AIDE_DAYSPAN_URL: "既定 http://127.0.0.1:3113 で足りる",
  AIDE_GITHUB_ORG: "既定 guchi-apps で足りる",
  AIDE_GITHUB_REPOS: "未設定なら活動中のリポジトリを自動で拾う",
  AIDE_GITHUB_ACTIVE_DAYS: "未設定なら既定の日数を使う",
  AIDE_IMAGE_MAIL_IDEMPOTENCY_LOG_PATH: "画像メール送信の冪等記録の置き場。既定（data/image-mail-idempotency.json）で足りる",
  AIDE_IMAGE_MAIL_LOG_PATH: "画像メール送信の履歴の置き場。既定（data/image-mail-log.json）で足りる",
  AIDE_INGEST_URL: "送信側（サブPCのworker）の設定。受け側のVPSでは読まない",
  AIDE_WORK_REPORTS_PATH: "dotの作業報告の置き場。既定（data/work-reports.json）で足りる",
  AIDE_LOCATION_PATH: "位置共有の保存先。既定（data/location.json）で足りる",
  AIDE_MCP_ACCESS_LOG_PATH: "MCPアクセスの記録の置き場。既定（data/mcp-access.json）で足りる",
  AIDE_NEWS_MAIL_IDEMPOTENCY_LOG_PATH: "業界ニュース週報メール送信の冪等記録の置き場。既定（data/news-mail-idempotency.json）で足りる",
  AIDE_NEWS_MAIL_LOG_PATH: "業界ニュース週報メール送信の履歴の置き場。既定（data/news-mail-log.json）で足りる",
  AIDE_OPS_DASHBOARD_URL: "既定 http://127.0.0.1:3110 で足りる",
  AIDE_MYROOM_URL: "既定 http://127.0.0.1:8000 で足りる",
  AIDE_DISCORD_WEBHOOK_URL: "workerジョブの通知用。workerはサブPCで動く",
  AIDE_WEATHER_LAT: "天気予報の地点。取得するのはサブPCのworkerで、既定値でも足りる",
  AIDE_WEATHER_LON: "天気予報の地点。取得するのはサブPCのworkerで、既定値でも足りる",
  AIDE_WEATHER_LOCATION_NAME:
    "天気予報の地点の名前（#673）。サブPCのworkerが予報と一緒にキャッシュへ載せ、VPSはそれを読むだけ",
  AIDE_ZAIM_WRITE_SECRET:
    "VPSの本体サーバーは issue-deck の共有トークンAPIから取得する（aide#665）。環境変数は共有トークンAPIの接続先を持たないサブPCの中継（aide-zaim-web）だけが読み、サブPCの .env に置く",
  AIDE_ZAIM_WEB_PAYMENT_LOG_PATH:
    "Web版の入力画面からの登録の冪等記録の置き場（#214）。既定（data/zaim-web-payments.json）で足りる。" +
    "そもそもこの経路が動くのは storage state と Playwright があるサブPCだけで、VPSでは使わない",
  AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH:
    "既存明細のカテゴリ変更の冪等記録の置き場（#273）。既定（data/zaim-web-genre-edits.json）で足りる。" +
    "AIDE_ZAIM_WEB_PAYMENT_LOG_PATH と同じく、この経路が動くのはサブPCだけで、VPSでは使わない",
  AIDE_WORKER_STATE_DIR: "worker（サブPC）の記録の置き場",
  AIDE_ZAIM_WEB_HOST:
    "Web版登録の受け口（#215）が待ち受けるアドレス。常駐するのはサブPCだけで、" +
    "VPSは中継する側なのでこの受け口を起動しない",
  AIDE_ZAIM_WEB_PORT: "同上。既定 4748 で足りる",
};

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    // テストは検証のために環境変数を差し替えるので、実行時の参照とは別扱いにする。
    .filter((entry) => !entry.name.endsWith(".test.ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

async function collectAideEnvNames(): Promise<string[]> {
  const files = await collectSourceFiles(SRC_DIR);
  const names = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/process\.env\[?"?(AIDE_[A-Z0-9_]+)"?\]?/g)) {
      names.add(match[1]!);
    }
  }
  return [...names].sort();
}

const deployYml = await readFile(`${REPO_ROOT}.github/workflows/deploy.yml`, "utf8");
const manifest = await readFile(`${REPO_ROOT}.github/secrets-manifest.tsv`, "utf8");
const aideEnvNames = await collectAideEnvNames();
const requiredInProduction = aideEnvNames.filter((name) => !(name in NOT_REQUIRED_IN_PRODUCTION));

/** 「Send environment variables」ステップ（gateへ .env の値を送る）の本文。 */
const sendStep =
  deployYml.match(/- name: Send environment variables\n([\s\S]*?)\n\s*- name: Deploy and restart/)?.[1] ?? "";

/** 同ステップが gate へ送る行（`printf '%s\n' "NAME=..."`）の `NAME=...` の部分。 */
const sentLines = [...sendStep.matchAll(/^\s*printf '%s\\n' "([A-Z][A-Z0-9_]*=[^"]*)"$/gm)].map((match) => match[1]!);

/** 同ステップの改行チェック（`for name in ...; do`）に並ぶ名前。 */
const checkedNames = (sendStep.match(/^\s*for name in (.+); do$/m)?.[1] ?? "").split(/\s+/).filter(Boolean);

/** マニフェストのKEY列（コメント行を除く）。 */
const manifestKeys = manifest
  .split("\n")
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split("\t")[0]!);

describe("本番の.envへの配線（deploy.yml）", () => {
  it("src が読む AIDE_* を検出できている", () => {
    // 走査そのものが壊れていると、以下の検査が全部素通りしてしまう。
    assert.ok(aideEnvNames.includes("AIDE_AUTH_PASSWORD"));
    assert.ok(requiredInProduction.length >= 5);
    // deploy.yml の形が変わって抜き出しが空になると、以下の検査が全部素通りしてしまう。
    assert.ok(sentLines.some((line) => line.startsWith("AIDE_AUTH_PASSWORD=")), "送信ステップの printf 行を読めていません");
    assert.ok(checkedNames.includes("AIDE_AUTH_PASSWORD"), "送信ステップの改行チェックを読めていません");
  });

  it("実行時に要る AIDE_* がマニフェストに載っている", () => {
    for (const name of requiredInProduction) {
      assert.ok(
        manifestKeys.includes(name),
        `${name} が .github/secrets-manifest.tsv にありません。` +
          "GitHubのsecret/variableへ同期されず、デプロイ時に空になります。",
      );
    }
  });

  it("実行時に要る AIDE_* がジョブとステップの env: に載っている", () => {
    for (const name of requiredInProduction) {
      assert.ok(
        deployYml.includes(`${name}: \${{ secrets.${name} }}`) ||
          deployYml.includes(`${name}: \${{ vars.${name} }}`),
        `${name} が deploy.yml のジョブの env: にありません。`,
      );
      assert.ok(
        deployYml.includes(`${name}: \${{ env.${name} }}`),
        `${name} が「Send environment variables」ステップの env: にありません。`,
      );
    }
  });

  it("実行時に要る AIDE_* が改行チェックの対象になっている", () => {
    for (const name of requiredInProduction) {
      assert.ok(
        checkedNames.includes(name),
        `${name} が送信ステップの改行チェック（for name in ...）にありません。` +
          "改行を含む値はgateが1行1変数として読めず、値が壊れたまま送られます。",
      );
    }
  });

  it("実行時に要る AIDE_* がgateへ送られている", () => {
    for (const name of requiredInProduction) {
      assert.ok(
        sentLines.some((line) => line.startsWith(`${name}=`)),
        `${name} が送信ステップの printf 行にありません。本番の .env へ届きません。`,
      );
    }
  });

  it("未発行でもデプロイが止まらないよう、トークン類は空を許している", () => {
    // 認証まわり（AIDE_AUTH_PASSWORD）は空だと起動しないので、あえて既定値を付けない。
    for (const name of [
      "AIDE_READ_SECRET",
      "AIDE_STATUS_SECRET",
      "AIDE_OPS_DASHBOARD_TOKEN",
      "AIDE_MYROOM_TOKEN",
      "AIDE_MYROOM_CONTROL_TOKEN",
      "AIDE_DAYSPAN_TOKEN",
      "AIDE_DAYSPAN_WRITE_TOKEN",
      "AIDE_DAYSPAN_TARGET_EMAIL",
      "AIDE_GITHUB_TOKEN",
      "AIDE_GITHUB_ISSUE_TOKEN",
    ]) {
      assert.ok(
        sentLines.includes(`${name}=\${${name}:-}`),
        `${name} は \${${name}:-} で書き、未設定でも set -u で落ちないようにします。`,
      );
    }
  });
});
