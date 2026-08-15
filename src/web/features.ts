import type { ServerResponse } from "node:http";
import type { ToolRegistry } from "../mcp/registry.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";

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
 * MCPツールは登録簿（`src/mcp/registry.ts`）から自動生成するため、ツールを増やせば
 * 何もしなくてもここに出る。HTTPエンドポイントだけは静的な宣言（`ENDPOINTS`）なので、
 * `src/server.ts` にルートを足したらここも更新する。
 */

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
    name: "/features",
    meta: "GET",
    description: "このページ。認証は不要。",
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
      note: "MCP・OAuth・worker からの取り込み口を1プロセスで提供している。",
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

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
 :root{color-scheme:light dark;--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--card:#fff;--bg:#fafafa;--accent:#2b6cb0}
 @media (prefers-color-scheme:dark){
  :root{--fg:#e8e8e8;--muted:#a0a0a0;--line:#333;--card:#1c1c1c;--bg:#121212;--accent:#7fb3e8}
 }
 *{box-sizing:border-box}
 body{font-family:system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:3rem 1rem 4rem;
      line-height:1.7;color:var(--fg);background:var(--bg)}
 h1{font-size:1.5rem;margin:0 0 .25rem}
 h2{font-size:1.05rem;margin:2.5rem 0 .25rem;padding-bottom:.4rem;border-bottom:1px solid var(--line)}
 p{margin:.25rem 0}
 .lead{color:var(--muted)}
 .note{color:var(--muted);font-size:.875rem;margin:.5rem 0 1rem}
 .conn{margin-top:1.5rem;padding:.75rem 1rem;border:1px solid var(--line);border-radius:.5rem;background:var(--card)}
 .conn dt{color:var(--muted);font-size:.8125rem}
 .conn dd{margin:0 0 .5rem}
 .conn dd:last-child{margin-bottom:0}
 ul{list-style:none;padding:0;margin:0}
 li{padding:.75rem 1rem;border:1px solid var(--line);border-radius:.5rem;background:var(--card);margin-bottom:.5rem}
 .name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;color:var(--accent);
       word-break:break-all}
 .meta{margin-left:.5rem;color:var(--muted);font-size:.75rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 .desc{margin:.25rem 0 0;font-size:.9375rem}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9375rem;word-break:break-all}
 footer{margin-top:3rem;color:var(--muted);font-size:.8125rem}
`;

function renderItem(item: FeatureItem): string {
  const meta = item.meta ? `<span class="meta">${escapeHtml(item.meta)}</span>` : "";
  return `<li><span class="name">${escapeHtml(item.name)}</span>${meta}
  <p class="desc">${escapeHtml(item.description)}</p></li>`;
}

function renderSection(section: FeatureSection): string {
  const note = section.note ? `<p class="note">${escapeHtml(section.note)}</p>` : "";
  const items = section.items.length
    ? `<ul>${section.items.map(renderItem).join("\n")}</ul>`
    : `<p class="note">（まだありません）</p>`;
  return `<h2>${escapeHtml(section.title)}</h2>\n${note}\n${items}`;
}

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderFeaturesPage(sections: FeatureSection[], baseUrl: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>AIDE の機能一覧</title>
<style>${STYLE}</style></head><body>
<h1>AIDE の機能一覧</h1>
<p class="lead">生活情報まわりの共通バックエンド／ハブ。このサーバーで使える機能の一覧です。</p>
<dl class="conn">
  <dt>MCP接続先URL</dt>
  <dd><code>${escapeHtml(baseUrl)}/mcp</code></dd>
  <dt>接続方法</dt>
  <dd>ClaudeアプリのカスタムコネクタにこのURLを登録します（末尾の <code>/mcp</code> が要ります）。</dd>
</dl>
${sections.map(renderSection).join("\n")}
<footer>このページには機能の一覧だけを載せています（実データ・設定値は含みません）。</footer>
</body></html>
`;
}

export function handleFeaturesPage(res: ServerResponse, registry: ToolRegistry, baseUrl: string): void {
  res
    .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    .end(renderFeaturesPage(buildSections(registry), baseUrl));
}
