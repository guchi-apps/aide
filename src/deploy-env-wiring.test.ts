import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * 本番の `.env` は `.github/workflows/deploy.yml` が**毎回まるごと上書き**する。
 * そのため、VPS上で手で `.env` へ追記した値はデプロイのたびに消える。
 *
 * 実際に AIDE_GITHUB_TOKEN（aide#47）と AIDE_OPS_DASHBOARD_TOKEN（aide#42）が手作業の
 * 追記だけで運用されており、次にデプロイが走った時点で消える状態だった（aide#55）。
 * これらが消えても例外にはならず、対応するMCPツールが「未設定」を返すだけなので、
 * 呼ぶまで誰も気づけない。**気づけない不具合は検査で塞ぐ。**
 *
 * このテストは `src/` が実行時に読む `AIDE_*` を洗い出し、それぞれが
 *
 *   1. `.github/secrets-manifest.tsv`（1Password → GitHub の対応表）
 *   2. deploy.yml のジョブの `env:`
 *   3. deploy.yml の「Deploy and restart」ステップの `env:`
 *   4. 同ステップの `envs:`（appleboy/ssh-action はここに書いた名前しかリモートへ渡さない）
 *   5. 同ステップが書き出す `.env` のheredoc
 *
 * すべてに載っていることを確かめる。本番で要らない値は下の NOT_REQUIRED_IN_PRODUCTION に
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
  AIDE_CACHE_DIR: "既定（リポジトリ基準の data/cache）で足りる",
  AIDE_GITHUB_ORG: "既定 guchi-apps で足りる",
  AIDE_GITHUB_REPOS: "未設定なら活動中のリポジトリを自動で拾う",
  AIDE_GITHUB_ACTIVE_DAYS: "未設定なら既定の日数を使う",
  AIDE_INGEST_URL: "送信側（サブPCのworker）の設定。受け側のVPSでは読まない",
  AIDE_OPS_DASHBOARD_URL: "既定 http://127.0.0.1:3110 で足りる",
  AIDE_MYROOM_URL: "既定 http://127.0.0.1:8000 で足りる",
  AIDE_SIGNALY_WEBHOOK_URL: "workerジョブの通知用。workerはサブPCで動く",
  AIDE_SUBSCRIPTIONS_URL: "既定 http://127.0.0.1:3107 で足りる",
  AIDE_WEATHER_LAT: "天気予報の地点。取得するのはサブPCのworkerで、既定値でも足りる",
  AIDE_WEATHER_LON: "天気予報の地点。取得するのはサブPCのworkerで、既定値でも足りる",
  AIDE_WORKER_STATE_DIR: "worker（サブPC）の記録の置き場",
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

/** deploy.yml が `.env` へ書き出すheredocの中身。 */
const envHeredoc = deployYml.match(/cat > \.env <<ENVFILE\n([\s\S]*?)\n\s*ENVFILE/)?.[1] ?? "";

/** 「Deploy and restart」ステップの `envs:` に列挙された名前。 */
const forwardedEnvs = (deployYml.match(/^\s*envs:\s*(.+)$/m)?.[1] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

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
        `${name} が「Deploy and restart」ステップの env: にありません。`,
      );
    }
  });

  it("実行時に要る AIDE_* が envs: でリモートへ渡されている", () => {
    for (const name of requiredInProduction) {
      assert.ok(
        forwardedEnvs.includes(name),
        `${name} が envs: にありません。appleboy/ssh-action は列挙した名前しか渡さないため、` +
          "リモート側では空になります。",
      );
    }
  });

  it("実行時に要る AIDE_* が .env のheredocに書き出されている", () => {
    for (const name of requiredInProduction) {
      assert.match(
        envHeredoc,
        new RegExp(`^\\s*${name}=`, "m"),
        `${name} が .env のheredocにありません。デプロイのたびに本番から消えます。`,
      );
    }
  });

  it("未発行でもデプロイが止まらないよう、トークン類は空を許している", () => {
    // 認証まわり（AIDE_AUTH_PASSWORD）は空だと起動しないので、あえて既定値を付けない。
    for (const name of [
      "AIDE_READ_SECRET",
      "AIDE_OPS_DASHBOARD_TOKEN",
      "AIDE_SUBSCRIPTIONS_TOKEN",
      "AIDE_GITHUB_TOKEN",
      "AIDE_GITHUB_ISSUE_TOKEN",
    ]) {
      assert.match(
        envHeredoc,
        new RegExp(`^\\s*${name}=\\$\\{${name}:-\\}$`, "m"),
        `${name} は \${${name}:-} で書き、未設定でも set -u で落ちないようにします。`,
      );
    }
  });
});
