import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolRegistry } from "../mcp/registry.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { card, escapeHtml, renderPage, siteNav } from "./layout.ts";
import { accountAction, handleGatedPage, type LoginOptions } from "./login.ts";

/**
 * 機能一覧ページ（`GET /features`）。
 *
 * 「このAIDEで今なにが使えるか」をブラウザから確認するための人間向けページ。
 * `src/api/`（機械向けのJSON）とは用途が違うため層を分けている。
 *
 * **このページはログインの内側にある**（アプリ連携 `/map` と同じ関門。#332）。以前は認証なしで
 * 公開していたが、どのツール・エンドポイントを持つかの一覧は利用状況を読み取れる材料になる。
 * 載せてよいのは、どんな機能が存在するかという静的なカタログだけに限る。具体的には次を載せない。
 *
 * - キャッシュの中身・取得時刻などの実データや稼働状況
 * - 環境変数の値、シークレットの設定有無（認証が無効な環境で出す警告だけは例外）
 *
 * 稼働状況は ops-dashboard の「AIDE」タブ（`/api/status` を読む）が答える。
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

/**
 * 外部データの帰属表示。
 *
 * Open-Meteo の無料利用は **CC BY 4.0 の帰属表示が条件**（非商用・1日10,000回未満と併せて3つ）。
 * 天気予報そのものは認証の内側（キャッシュ・横断ビュー）にしか出ず、帰属表示は天気のデータにも
 * 同梱している（`WeatherForecast.attribution`）。このページは天気を見られる人（ログインした人）
 * だけが開けるため、そこへ載せておけば条件は満たせる。取得元を増やしたらここへ足す。
 *
 * リンクは踏むまで外部へリクエストが飛ばないので、レイアウトの「外部を読み込まない」方針
 * （`src/web/layout.ts`）とは両立する。
 */
const ATTRIBUTION_HTML =
  '天気予報のデータは <a href="https://open-meteo.com/" rel="noopener noreferrer">Open-Meteo</a>' +
  '（<a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener noreferrer">CC BY 4.0</a>）' +
  "を利用しています。";

/** `src/server.ts` が処理するHTTPエンドポイント。ルートを増やしたらここも足す。 */
export const ENDPOINTS: FeatureItem[] = [
  {
    name: "/mcp",
    meta: "POST / GET / DELETE",
    description: "MCPサーバー本体（Streamable HTTP）。OAuthのアクセストークンが要る。",
  },
  {
    name: "/map",
    meta: "GET",
    description:
      "アプリ連携の画面。AIDEを中心に、どのアプリがAIDEを使い、AIDEがどこへ読みに行き・書き込むのかを図で示す。許可されたGoogleアカウントでのログインが要る（未設定の環境ではパスワード）。",
  },
  {
    name: "/status/auth/start",
    meta: "GET",
    description: "画面のGoogleログインを始める。Supabase経由でGoogleへ送り出す。",
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
    description: "このページ。ログインが要る（/map と同じ。許可されたGoogleアカウント、未設定の環境ではパスワード）。",
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
      "個人アプリ向けの読み取りAPI。aide_money_summary と同じ内容（残高一覧・保有銘柄・連携口座のZaim側の最終更新・取得時刻・経過分数・月額固定費）をJSONで返す。読み取り専用の共有シークレットで認証する。",
  },
  {
    name: "/api/money/transactions",
    meta: "GET",
    description:
      "Zaim Web版の家計簿明細一覧（当月＋先月ぶん、JST）をJSONで返す。公式API（GET /v2/home/money）が返さない自動連携明細（スマートレシート等）も含む。1件の明細に複数品目がある場合、品目名は一覧に出る先頭の1件しか取れない。読み取り専用の共有シークレットで認証する。",
  },
  {
    name: "/api/status",
    meta: "GET",
    description:
      "ops-dashboard向けの動作状況API。ジョブ・キャッシュ・接続先・MCPアクセスの判定（health）とMCPツール名一覧（tools）をJSONで返す。動作状況専用の共有シークレットで認証する。",
  },
  {
    name: "/api/status/checks",
    meta: "POST",
    description:
      "押されたときだけ外部の接続先へ疎通確認を行い、結果をJSONで返す。/api/status と同じ共有シークレットで認証する。",
  },
  {
    name: "/api/zaim/payment",
    meta: "POST",
    description:
      "個人アプリ向けのZaim登録API。支出を1件Zaimへ登録し、Zaim側のレコードID（money_id）を返す。requestId が同じ再送はZaimへ送らず前回の結果を返す。Zaim書き込み専用の共有シークレットで認証する。",
  },
  {
    name: "/api/zaim/payment/web",
    meta: "POST",
    description:
      "Zaim Web版の入力画面を操作して品目明細を1件登録する。公式APIで作った明細は「レシート置き換え」の候補にならないため、置き換えに載せたいものはこちらを通す。応答まで数十秒かかり、レコードIDは返らない。画面の操作が成立するのはログイン状態のあるサブPCだけなので、VPSのサーバーはそこへ中継する。",
  },
  {
    name: "/api/zaim/payment/web/genre",
    meta: "POST",
    description:
      "Zaim Web版の編集画面を操作して、既存明細（自動連携明細を含む）のカテゴリ・内訳だけを変更する。金額・日付・口座・品目・お店・集計対象外は変えない。開いた明細の日付・金額が本文と一致しなければ何も変えずに止める。応答まで数十秒かかり、渡した moneyId をそのまま返す。画面の操作が成立するのはログイン状態のあるサブPCだけなので、VPSのサーバーはそこへ中継する。",
  },
  {
    name: "/api/zaim/master",
    meta: "GET",
    description:
      "Zaimの口座・カテゴリ・ジャンルのID一覧。登録時に渡すIDを呼び出し元が引くための口で、/api/zaim/payment と同じシークレットで認証する。",
  },
  {
    name: "/api/image-mail/send",
    meta: "POST",
    description:
      "Research Deskのサーバーからmultipart/form-dataで届く画像ZIPを、AIDEが保持するGmail資格情報で社用メールへ送信する。件名は「[画像] {title}」固定、宛先・BCCも環境変数で固定する。専用の共有シークレットで認証し、idempotencyKeyで二重送信を防ぐ。",
  },
  {
    name: "/api/news-mail/send",
    meta: "POST",
    description:
      "Research Deskのサーバーから届く業界ニュース週報（HTMLとテキストの本文）を、画像メールと同じGmail資格情報で社用メールへ送信する。宛先・送信元は環境変数で固定し、画像メールとは別の共有シークレットで認証する。",
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

export interface FeaturesPageOptions {
  /** ヘッダー右端（ログイン中の表示・ログアウト）。 */
  headerAction?: string;
  /** 認証が無効な環境か。無効なら画面の先頭で警告する。 */
  authDisabled?: boolean;
}

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderFeaturesPage(
  sections: FeatureSection[],
  baseUrl: string,
  options: FeaturesPageOptions = {},
): string {
  const warning = options.authDisabled
    ? `<p class="notice">認証が無効です（AIDE_AUTH_DISABLED=1）。この画面もMCPも誰でも開けます。</p>`
    : "";
  const body = `<section class="hero">
<div class="hero-top"><h1>機能一覧</h1></div>
<p class="lead">生活情報まわりの共通バックエンド／ハブ。このサーバーで使える機能の一覧です。</p>
${warning}
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
    nav: siteNav("features"),
    headerAction: options.headerAction ?? "",
    body,
    footer: `このページには機能の一覧だけを載せています（実データ・設定値は含みません）。各アプリとのつながりは「アプリ連携」で図にしています。<br>${ATTRIBUTION_HTML}`,
  });
}

export async function handleFeaturesPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
): Promise<void> {
  await handleGatedPage(req, res, options, "/features", (session) =>
    renderFeaturesPage(buildSections(options.registry), options.baseUrl, {
      headerAction: accountAction(session, options.authConfig.enabled),
      authDisabled: !options.authConfig.enabled,
    }),
  );
}
