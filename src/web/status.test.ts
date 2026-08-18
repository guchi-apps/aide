import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Health } from "../core/views/health.ts";
import { ToolRegistry } from "../mcp/registry.ts";
import { pingTool } from "../mcp/tools/ping.ts";
import { renderLoginPage, renderStatusPage } from "./status.ts";

function registry(): ToolRegistry {
  const created = new ToolRegistry();
  created.register(pingTool);
  return created;
}

/** 何も問題が無い状態。個々のテストで必要な部分だけ差し替える。 */
function health(overrides: Partial<Health> = {}): Health {
  return {
    checkedAt: "2026-08-18T06:42:07.000Z",
    severity: "ok",
    attention: [],
    server: {
      version: "0.5.1",
      nodeVersion: "v24.18.0",
      uptimeSeconds: 3600 * 5,
      startedAt: "2026-08-18T01:42:07.000Z",
      authEnabled: true,
      baseUrl: "https://aide.example.com",
      mcpUrl: "https://aide.example.com/mcp",
    },
    jobs: [
      {
        name: "zaim-sync",
        description: "Zaimを巡回する",
        interval: "日次（23:35 JST）",
        staleAfterMinutes: 36 * 60,
        severity: "ok",
        lastRun: {
          ok: true,
          at: "2026-08-17T14:36:00.000Z",
          ageMinutes: 966,
          seconds: 42.1,
          message: "残高12件を取得した",
          host: "subpc",
        },
      },
    ],
    cache: {
      key: "zaim-snapshot",
      empty: false,
      fetchedAt: "2026-08-17T14:36:00.000Z",
      ageMinutes: 966,
      stale: false,
      balances: 12,
      holdings: 8,
      staleAccounts: [],
      severity: "ok",
    },
    connectors: [
      {
        key: "ops-dashboard",
        label: "ops-dashboard",
        side: "server",
        configured: true,
        probeable: true,
        note: "稼働状況の取得元。",
      },
      {
        key: "zaim",
        label: "Zaim",
        side: "worker",
        configured: null,
        probeable: false,
        note: "巡回は worker（サブPC）が担当する。",
      },
    ],
    mcp: { clients: 2, tokens: 2, nearestExpiryAt: "2026-09-11T00:00:00.000Z" },
    ...overrides,
  };
}

describe("動作状況ページ", () => {
  it("問題が無ければ、そう言い切る", () => {
    const html = renderStatusPage(health(), registry());
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("異常はありません"));
    assert.ok(html.includes("正常"));
  });

  it("注意すべきことを件数つきで先頭に出し、対応まで書く", () => {
    const html = renderStatusPage(
      health({
        severity: "danger",
        attention: [
          {
            severity: "danger",
            message: "zaim-keep-alive が失敗しています",
            action: "サブPCで login.mjs を実行する",
          },
        ],
      }),
      registry(),
    );
    assert.ok(html.includes("対応が必要なことが 1 件あります"));
    assert.ok(html.includes("zaim-keep-alive が失敗しています"));
    assert.ok(html.includes("サブPCで login.mjs を実行する"));
  });

  it("ジョブの最後の実行と、失敗していればその理由が出る", () => {
    const base = health();
    const html = renderStatusPage(
      {
        ...base,
        severity: "danger",
        jobs: [
          {
            ...base.jobs[0]!,
            severity: "danger",
            lastRun: { ...base.jobs[0]!.lastRun!, ok: false, message: "Error: セッションが失効" },
          },
        ],
      },
      registry(),
    );
    assert.ok(html.includes("zaim-sync"));
    assert.ok(html.includes("失敗"));
    assert.ok(html.includes("Error: セッションが失効"));
  });

  it("キャッシュは鮮度と件数だけを出し、金額は出さない", () => {
    const html = renderStatusPage(health(), registry());
    assert.ok(html.includes("残高 12 件"));
    assert.ok(html.includes("保有銘柄 8 件"));
    assert.ok(html.includes("金額は表示しません"));
  });

  it("まだ一度も巡回していなければ、その旨を出す", () => {
    const html = renderStatusPage(
      health({
        cache: {
          key: "zaim-snapshot",
          empty: true,
          fetchedAt: null,
          ageMinutes: null,
          stale: false,
          balances: 0,
          holdings: 0,
          staleAccounts: [],
          severity: "unknown",
        },
      }),
      registry(),
    );
    assert.ok(html.includes("まだ一度も巡回していません"));
  });

  it("認証が無効なら、そのことを画面でも示す", () => {
    const base = health();
    const html = renderStatusPage(
      { ...base, server: { ...base.server, authEnabled: false } },
      registry(),
    );
    assert.ok(html.includes("認証が無効"));
    // 守るものが無い状態なのでログアウトは出さない。
    assert.ok(!html.includes("ログアウト"));
  });

  it("登録済みのMCPツールが出る", () => {
    assert.ok(renderStatusPage(health(), registry()).includes(pingTool.name));
  });

  it("worker側の設定は「未設定」と断定せず、判定しないことを示す", () => {
    // 本番では worker がサブPC・サーバーがVPSにいて .env が別。サーバー側の環境変数で
    // 判定すると、正しく動いていても常に「未設定」と出てしまう。
    const html = renderStatusPage(health(), registry());
    assert.ok(html.includes("worker側"));
    assert.ok(!html.includes("未設定あり"));
  });

  it("Googleログインなら、誰で入っているかを画面に出す", () => {
    const html = renderStatusPage(health(), registry(), { email: "me@example.com" });
    assert.ok(html.includes("me@example.com"));
    assert.ok(html.includes("ログアウト"));
    assert.ok(html.includes("許可されたGoogleアカウント"));
  });

  it("パスワードでのログインなら、身元は出さない", () => {
    const html = renderStatusPage(health(), registry(), { email: null });
    assert.ok(html.includes("ログアウト"));
    assert.ok(html.includes("パスワード認証の内側"));
  });

  it("メールアドレスもエスケープして出す", () => {
    const html = renderStatusPage(health(), registry(), { email: "<img src=x onerror=1>@e.com" });
    assert.ok(!html.includes("<img src=x"));
  });

  it("機能一覧への行き来ができる", () => {
    const html = renderStatusPage(health(), registry());
    assert.ok(html.includes('href="/features"'));
  });

  it("外部から取り込んだ文字列をエスケープする", () => {
    const base = health();
    const html = renderStatusPage(
      {
        ...base,
        attention: [{ severity: "warn", message: `<script>alert("x")</script> & 'q'` }],
        jobs: [
          {
            ...base.jobs[0]!,
            lastRun: { ...base.jobs[0]!.lastRun!, ok: false, message: "<img src=x onerror=1>" },
          },
        ],
      },
      registry(),
    );
    assert.ok(!html.includes("<script>alert"), "生の script タグが混ざっている");
    assert.ok(!html.includes("<img src=x"), "生の img タグが混ざっている");
    assert.ok(html.includes("&lt;script&gt;alert"));
    assert.ok(html.includes("&#39;q&#39;"));
  });
});

describe("ログイン画面", () => {
  it("パスワードだけを尋ね、値を埋め込まない", () => {
    const html = renderLoginPage({ google: false });
    assert.ok(html.includes('type="password"'));
    assert.ok(html.includes('action="/status/login"'));
    assert.ok(!html.includes("value="));
  });

  it("Googleログインが有効なら、パスワード欄を出さない", () => {
    // 残すと「許可したメールアドレスの人しか開けない」制限がパスワード1本で迂回できる。
    const html = renderLoginPage({ google: true });
    assert.ok(html.includes('href="/status/auth/start"'));
    assert.ok(html.includes("Googleでログイン"));
    assert.ok(!html.includes('type="password"'));
    assert.ok(!html.includes('action="/status/login"'));
  });

  it("失敗の理由を出す", () => {
    const html = renderLoginPage({ google: false, error: "パスワードが違います。" });
    assert.ok(html.includes("パスワードが違います。"));
  });

  it("許可されていないアカウントには、誰なら開けるのかを教えない", () => {
    const html = renderLoginPage({ google: true, error: "このアカウントでは開けません。" });
    assert.ok(html.includes("このアカウントでは開けません。"));
    // 許可リストの中身が画面に出ると、総当たりの手がかりになる。
    assert.doesNotMatch(html, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it("エラー文もエスケープする", () => {
    assert.ok(!renderLoginPage({ google: false, error: "<b>x</b>" }).includes("<b>x</b>"));
  });
});
