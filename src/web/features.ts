import type { ServerResponse } from "node:http";
import type { ToolRegistry } from "../mcp/registry.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { card, escapeHtml, renderPage } from "./layout.ts";

/**
 * 機能一覧ページ（`GET /features`）。
 *
 * 「このAIDEで今なにが使えるか」をブラウザから確認するための人間向けページ。
 * `src/api/`（機械向けのJSON）とは用途が違うため層を分けている。
 *
 * **このページは認証なしで公開される。** 載せてよいのは、どんな機能が存在するかという
 * 静的なカタログだけに限る。具体的には次を載せない。
 *
 * - キャッシュの中身・取得時刻などの実データや稼働状況
 * - 環境変数の値、シークレットの設定有無、認証の有効・無効
 *
 * それらを見たい場合は動作状況ページ（`/status`）が答える。**あちらは認証の内側にある。**
 * 見た目は共通（`src/web/layout.ts`）だが、公開範囲は混ぜない。
 *
 * MCPツールは登録簿（`src/mcp/registry.ts`）から自動生成するため、ツールを増やせば
 * 何もしなくてもここに出る。HTTPエンドポイントだけは静的な宣言（`ENDPOINTS`）なので、
 * `src/server.ts` にルートを足したらここも更新する。
 */

export { escapeHtml };

export interface FeatureItem {
  name: string;
  description: string;
  /** 名前の脇に小さく添える補足（HTTPメソッド・実行間隔など）。 */
  meta?: string;
}

export interface FeatureSection {
  title: string;
  note?: string;
  items: FeatureItem[];
}

/** `src/server.ts` が処理するHTTPエンドポイント。ルートを増やしたらここも足す。 */
const ENDPOINTS: FeatureItem[] = [
  {
    name: "/mcp",
    meta: "POST / GET / DELETE",
    description: "MCPサーバー本体（Streamable HTTP）。OAuthのアクセストークンが要る。",
  },
  {
    name: "/status",
    meta: "GET",
    description:
      "動作状況の画面。ジョブの成否・キャッシュの鮮度・接続先の設定を人間向けに表示する。許可されたGoogleアカウントでのログインが要る（未設定の環境ではパスワード）。",
  },
  {
    name: "/status/auth/start",
    meta: "GET",
    description: "動作状況の画面のGoogleログインを始める。Supabase経由でGoogleへ送り出す。",
  },
  {
    name: "/status/auth/callback",
    meta: "GET",
    description:
      "Googleログインの戻り先。メールアドレスが許可リストにあるときだけログイン状態にする。",
  },
  {
    name: "/features",
    meta: "GET",
    description: "このページ。認証は不要。",
  },
  {
    name: "/manifest.webmanifest",
    meta: "GET",
    description: "PWAのマニフェスト。ホーム画面へ追加したときの名前とアイコンを返す。認証は不要。",
  },
  {
    name: "/icons/:name",
    meta: "GET",
    description: "アイコン画像。/favicon.ico も同じ画像を返す。認証は不要。",
  },
  {
    name: "/health",
    meta: "GET",
    description: "死活確認。ok を返すだけ。認証は不要。",
  },
  {
    name: "/.well-known/oauth-protected-resource",
    meta: "GET",
    description: "保護リソースのメタデータ。末尾に /mcp が付いた形でも同じ内容を返す。",
  },
  {
    name: "/.well-known/oauth-authorization-server",
    meta: "GET",
    description: "認可サーバーのメタデータ。クライアントはここから各エンドポイントを見つける。",
  },
  {
    name: "/oauth/register",
    meta: "POST",
    description: "動的クライアント登録（RFC 7591）。仕様上、未認証で公開される。",
  },
  {
    name: "/oauth/authorize",
    meta: "GET / POST",
    description: "認可画面。パスワードを確認して認可コードを発行する（PKCE必須）。",
  },
  {
    name: "/oauth/token",
    meta: "POST",
    description: "アクセストークンの発行と、リフレッシュトークンによる更新。",
  },
  {
    name: "/api/cache/:key",
    meta: "POST",
    description: "worker が取得結果を送り込む受け口。OAuthとは別系統の共有シークレットで認証する。",
  },
  {
    name: "/api/money/summary",
    meta: "GET",
    description:
      "個人アプリ向けの読み取りAPI。aide_money_summary と同じ内容（残高一覧・保有銘柄・連携口座のZaim側の最終更新・取得時刻・経過分数）をJSONで返す。読み取り専用の共有シークレットで認証する。",
  },
];

export function buildSections(registry: ToolRegistry): FeatureSection[] {
  return [
    {
      title: "MCPツール",
      note: "ClaudeアプリなどのLLMクライアントから呼べる機能。横断ビューと、公式MCPが無い領域だけを出している。",
      items: registry.list().map((tool) => ({ name: tool.name, description: tool.description })),
    },
    {
      title: "HTTPエンドポイント",
      note: "MCP・OAuth・worker からの取り込み口・個人アプリ向けの読み取りAPIを1プロセスで提供している。",
      items: ENDPOINTS,
    },
    {
      title: "worker ジョブ",
      note: "重い取得処理は常駐させず、ワンショットで実行してキャッシュへ書く。スケジューリングは cron / systemd timer / PM2 に任せている。",
      items: JOB_CATALOG.map((job) => ({
        name: job.name,
        description: job.description,
        meta: job.interval,
      })),
    },
  ];
}

function renderItem(item: FeatureItem): string {
  const meta = item.meta ? `<span class="mt">${escapeHtml(item.meta)}</span>` : "";
  return `<li><span><span class="nm">${escapeHtml(item.name)}</span>${meta}</span>
<span class="ds">${escapeHtml(item.description)}</span></li>`;
}

function renderSection(section: FeatureSection): string {
  const note = section.note ? `<p class="sub">${escapeHtml(section.note)}</p>` : "";
  const items = section.items.length
    ? `<ul class="items">${section.items.map(renderItem).join("\n")}</ul>`
    : `<p class="sub">（まだありません）</p>`;
  return card({
    title: section.title,
    meta: String(section.items.length),
    body: `${note}${items}`,
    // 節ごとの項目数に差があるため、2列に分けず縦に並べる。
    wide: true,
  });
}

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderFeaturesPage(sections: FeatureSection[], baseUrl: string): string {
  const body = `<section class="hero">
<div class="hero-top"><h1>機能一覧</h1></div>
<p class="lead">生活情報まわりの共通バックエンド／ハブ。このサーバーで使える機能の一覧です。</p>
<dl class="connect">
  <dt>MCP接続先</dt>
  <dd><span class="mono">${escapeHtml(baseUrl)}/mcp</span></dd>
  <dt>接続方法</dt>
  <dd>ClaudeアプリのカスタムコネクタにこのURLを登録します（末尾の <span class="mono">/mcp</span> が要ります）。</dd>
</dl>
</section>
<div class="grid">
${sections.map(renderSection).join("\n")}
</div>`;

  return renderPage({
    title: "AIDE の機能一覧",
    nav: [
      { href: "/status", label: "動作状況", current: false },
      { href: "/features", label: "機能一覧", current: true },
    ],
    body,
    footer:
      "このページには機能の一覧だけを載せています（実データ・設定値は含みません）。稼働状況は /status で確認できます。",
  });
}

export function handleFeaturesPage(res: ServerResponse, registry: ToolRegistry, baseUrl: string): void {
  res
    .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    .end(renderFeaturesPage(buildSections(registry), baseUrl));
}
