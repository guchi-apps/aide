import { headTags } from "./assets.ts";

/**
 * 人間向けHTMLページの共通レイアウト。
 *
 * AIDEがブラウザへ出す画面は3つある（機能一覧・動作状況・パスワードの入力）。
 * それぞれが自前のCSSを持っていたため、同じ「カード」「見出し」でも余白も色も違っていた。
 * **配色・書体・部品はここだけが持ち**、各ページは中身の組み立てに専念する。
 *
 * 外部のCSS・フォント・スクリプトを読み込まない。ページを表示しただけで第三者へ
 * リクエストが飛ぶのを避けるためで、書体は端末が持っているものから選ぶ。
 * アイコンとPWAマニフェスト（`src/web/assets.ts`）だけは自分で配信しているため `<head>` に入れる。
 * 実行時依存を増やさない方針（README）と同じ理由で、ここでもテンプレートエンジンは使わない。
 */

/** 状態の色。`OpsSeverity`（ok / warn / danger）と対応させてある。 */
export type Tone = "ok" | "warn" | "danger" | "muted";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 書体。**ウェブフォントは読み込まない。**
 * 本文は端末の日本語UIフォント、数値・パス・ジョブ名は等幅にして、
 * 「読む文字」と「並べて読み比べる文字」を分ける。
 */
const FONT_SANS =
  'system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",sans-serif';
const FONT_MONO = 'ui-monospace,SFMono-Regular,Menlo,"DejaVu Sans Mono",monospace';

/**
 * 配色は明暗の2組。切り替えスイッチは置かず、端末の設定にそのまま従う。
 * 状態の色（緑・黄・赤）は差し色（青）とは別系統にして、状態の表示にしか使わない。
 */
const STYLE = `
:root{
 --bg:#eceff2;--panel:#fff;--panel-2:#f5f7f9;
 --ink:#131b22;--ink-2:#3c4a55;--muted:#67757f;
 --line:#d8e0e6;--line-2:#e9eef1;
 --accent:#1b5a75;--accent-soft:#e3edf2;--on-accent:#fff;
 --ok:#1f7346;--ok-bg:#e0f0e6;
 --warn:#8a5c07;--warn-bg:#f8ecd4;
 --bad:#a52f26;--bad-bg:#f8e3e0;
}
@media (prefers-color-scheme:dark){
 :root{
  --bg:#0c1216;--panel:#141d24;--panel-2:#19242c;
  --ink:#dde6ec;--ink-2:#b3c1cb;--muted:#8494a0;
  --line:#26333c;--line-2:#1e2a32;
  --accent:#6bb6d6;--accent-soft:#16313e;--on-accent:#0c1216;
  --ok:#57c489;--ok-bg:#14301f;
  --warn:#dda94a;--warn-bg:#332612;
  --bad:#ef8175;--bad-bg:#3a1c19;
 }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:${FONT_SANS};
 line-height:1.7;font-size:15px;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mono{font-family:${FONT_MONO};font-size:.95em}

/* ---- ヘッダー ---- */
.topbar{display:flex;align-items:center;gap:.9rem;flex-wrap:wrap;
 padding:.7rem 1rem;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-family:${FONT_MONO};font-weight:600;letter-spacing:.14em;color:var(--accent);font-size:.85rem}
nav{display:flex;gap:.15rem;margin-right:auto;flex-wrap:wrap}
nav a{font-size:.85rem;text-decoration:none;color:var(--muted);padding:.25rem .6rem;border:1px solid transparent}
nav a.on{color:var(--ink);border-color:var(--line);background:var(--panel-2)}
nav a:hover{color:var(--ink)}
.topbar form{margin:0}
.linkish{font:inherit;font-size:.8rem;color:var(--muted);background:none;border:0;
 border-bottom:1px solid var(--line);padding:0;cursor:pointer}
.linkish:hover{color:var(--ink)}
.who{font-family:${FONT_MONO};font-size:.74rem;color:var(--muted);overflow-wrap:anywhere}

/* ---- 本文 ---- */
main{padding:1.1rem 1rem 1.6rem;display:flex;flex-direction:column;gap:1.1rem;flex:1;
 width:100%;max-width:72rem;margin:0 auto}
@media (min-width:720px){main{padding:1.6rem 1.75rem 2.4rem;gap:1.4rem}}

.hero{background:var(--panel);border:1px solid var(--line);padding:1rem 1.1rem;
 display:flex;flex-direction:column;gap:.75rem}
@media (min-width:720px){.hero{padding:1.3rem 1.5rem}}
.hero-top{display:flex;align-items:flex-start;gap:.8rem;flex-wrap:wrap}
.hero h1{font-size:1.25rem;line-height:1.4;margin:0;font-weight:700;flex:1 1 12rem;min-width:0;text-wrap:balance}
@media (min-width:720px){.hero h1{font-size:1.5rem}}
.lead{margin:0;color:var(--ink-2);font-size:.9rem;max-width:44em}
.stamp{font-family:${FONT_MONO};font-size:.75rem;color:var(--muted);
 display:flex;flex-wrap:wrap;gap:.15rem .9rem;font-variant-numeric:tabular-nums}
.attention{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem}
.attention li{padding:.55rem .7rem;background:var(--warn-bg);border-left:3px solid var(--warn);font-size:.88rem}
.attention li.danger{background:var(--bad-bg);border-left-color:var(--bad)}
.attention b{font-family:${FONT_MONO};font-weight:600;font-size:.85rem}
.fix{color:var(--ink-2);font-size:.82rem;display:block;margin-top:.15rem}

/* ---- 状態のバッジ ---- */
.pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .7rem;font-size:.78rem;
 font-weight:700;border:1px solid transparent;white-space:nowrap}
.pill::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:currentColor}
.pill.ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok)}
.pill.warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn)}
.pill.danger{color:var(--bad);background:var(--bad-bg);border-color:var(--bad)}
.pill.muted{color:var(--muted);background:var(--panel-2);border-color:var(--line)}

/* ---- カード ---- */
.grid{display:grid;gap:.9rem;grid-template-columns:minmax(0,1fr)}
@media (min-width:720px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:1.1rem}}
.card{background:var(--panel);border:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.card.wide{grid-column:1/-1}
.card-head{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-bottom:1px solid var(--line-2)}
.card-head h2{font-size:.9rem;margin:0;font-weight:700;margin-right:auto}
.card-head .n{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted)}
.card-body{padding:.7rem .9rem .9rem;display:flex;flex-direction:column;gap:.6rem}
.sub{color:var(--muted);font-size:.8rem;margin:0}

/* ---- 定義リスト・表 ---- */
dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:.3rem .9rem;
 font-size:.86rem;align-items:baseline}
dt{color:var(--muted);white-space:nowrap}
dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tblwrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.84rem}
th{text-align:left;font-weight:500;color:var(--muted);font-size:.74rem;letter-spacing:.06em;
 padding:.3rem .5rem .35rem 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:.45rem .5rem;padding-left:0;border-bottom:1px solid var(--line-2);vertical-align:top;
 font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.key{font-family:${FONT_MONO};font-weight:500;white-space:nowrap}

/* ---- 一覧（機能一覧ページ） ---- */
.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.items li{padding:.55rem 0;border-bottom:1px solid var(--line-2);display:flex;flex-direction:column;gap:.1rem}
.items li:last-child{border-bottom:0}
.items .nm{font-family:${FONT_MONO};font-size:.84rem;font-weight:500;color:var(--accent);overflow-wrap:anywhere}
.items .mt{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted);margin-left:.5rem}
.items .ds{font-size:.82rem;color:var(--ink-2)}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:0;list-style:none}
.chips li{font-family:${FONT_MONO};font-size:.76rem;padding:.15rem .5rem;
 background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent)}
.chips li .c{font-weight:700;margin-left:.4em;font-variant-numeric:tabular-nums}
.connect{background:var(--accent-soft);border:1px solid var(--accent);padding:.7rem .9rem;
 display:grid;grid-template-columns:auto minmax(0,1fr);gap:.25rem .9rem;font-size:.84rem;align-items:baseline}
.connect dt{color:var(--accent)}

/* ---- MCPアクセスの記録（動作状況ページ）---- */
/* 接続確認・一覧の取得は数が多く、ツールの呼び出しを押し流す。
   既定では畳んでおき、チェックを入れたときだけ同じ表に混ぜて出す。
   JavaScriptを使わないのは、この画面が素のfetch1か所しか持たない方針に合わせるため。 */
.log{min-width:0}
.log input.logtoggle{accent-color:var(--accent);vertical-align:middle;margin:0 .35rem 0 0}
.log label.logfilter{font-size:.8rem;color:var(--muted);vertical-align:middle;cursor:pointer}
.log .tblwrap{margin-top:.5rem}
.log input.logtoggle:not(:checked) ~ .tblwrap tr.quiet{display:none}
.when{font-family:${FONT_MONO};white-space:nowrap;color:var(--ink-2)}
tr.quiet td{color:var(--muted)}
.why{display:block;color:var(--bad);font-size:.78rem;font-variant-numeric:normal}

/* ---- ファイル別の折りたたみ（共通知識ページ）---- */
/* JavaScriptを使わず <details> だけで開閉する。この画面はGitHubから取った内容を
   並べるだけで、押した先で通信するものが無い。 */
.files{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;min-width:0}
.files > li{border-bottom:1px solid var(--line-2)}
.files > li:last-child{border-bottom:0}
.files summary{cursor:pointer;padding:.5rem 0;display:flex;align-items:baseline;gap:.5rem;
 flex-wrap:wrap;font-size:.84rem;list-style:none}
.files summary::-webkit-details-marker{display:none}
.files summary::before{content:"▸";color:var(--muted);font-size:.7rem;line-height:1.6}
.files details[open] > summary::before{content:"▾"}
.files summary .fname{font-family:${FONT_MONO};color:var(--accent);font-weight:500;
 margin-right:auto;overflow-wrap:anywhere}
.files summary .fcount{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted);
 font-variant-numeric:tabular-nums}
.sections{list-style:none;margin:0 0 .6rem;padding:0 0 0 1.1rem;
 display:flex;flex-direction:column;gap:.45rem}
.sections li{display:flex;flex-direction:column;gap:.1rem;min-width:0}
.sections .t{font-size:.84rem;color:var(--ink);line-height:1.5;overflow-wrap:anywhere}
.sections .m{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted);
 display:flex;gap:.15rem .8rem;flex-wrap:wrap;font-variant-numeric:tabular-nums}

/* ---- 操作 ---- */
button.act{font:inherit;font-size:.82rem;padding:.35rem .85rem;background:var(--panel-2);
 color:var(--ink);border:1px solid var(--line);cursor:pointer;align-self:flex-start}
button.act:hover{border-color:var(--accent);color:var(--accent)}
button.act[disabled]{opacity:.6;cursor:progress}

/* ---- ログイン（動作状況のログイン・接続の許可） ---- */
body.centered{justify-content:center;align-items:center;padding:2rem 1rem}
.box{background:var(--panel);border:1px solid var(--line);padding:1.6rem 1.4rem;width:100%;
 max-width:22rem;display:flex;flex-direction:column;gap:.85rem}
.box h1{font-size:1.15rem;margin:0;font-weight:700}
.box p{margin:0;font-size:.85rem;color:var(--muted)}
.box label{font-size:.8rem;color:var(--muted);display:flex;flex-direction:column;gap:.3rem}
.box input{font:inherit;font-size:.95rem;padding:.55rem .7rem;background:var(--panel-2);
 color:var(--ink);border:1px solid var(--line);width:100%}
.box button{font:inherit;font-weight:700;font-size:.9rem;padding:.6rem;background:var(--accent);
 color:var(--on-accent);border:1px solid var(--accent);cursor:pointer}
/* Googleログインは素のリンク。JSが動かなくても押せるようにボタンの見た目だけを与える。 */
.box .signin{font-weight:700;font-size:.9rem;padding:.6rem;background:var(--accent);
 color:var(--on-accent);border:1px solid var(--accent);text-align:center;text-decoration:none}
.err{color:var(--bad);font-size:.82rem;background:var(--bad-bg);border-left:3px solid var(--bad);padding:.4rem .6rem}

footer{padding:.9rem 1rem 1.4rem;color:var(--muted);font-size:.78rem;border-top:1px solid var(--line);
 width:100%;max-width:72rem;margin:0 auto}
@media (min-width:720px){footer{padding:1rem 1.75rem 2rem}}
`;

export interface NavItem {
  href: string;
  label: string;
  current: boolean;
}

/** ヘッダーのナビに並べる画面。ページを増やしたらここへ足す。 */
export type NavKey = "status" | "knowledge" | "features";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "status", href: "/status", label: "動作状況" },
  { key: "knowledge", href: "/knowledge", label: "共通知識" },
  { key: "features", href: "/features", label: "機能一覧" },
];

/**
 * ヘッダーのナビ。**3つの画面が同じ並びを持つよう、定義はここ1か所にする。**
 * 各ページが自前で配列を書いていたときは、画面を足すたびに書き漏らしが出ていた。
 */
export function siteNav(current: NavKey): NavItem[] {
  return NAV.map((item) => ({ href: item.href, label: item.label, current: item.key === current }));
}

export interface PageOptions {
  title: string;
  /** ヘッダーのナビ。空なら見出しだけの簡素なページ（パスワード入力）になる。 */
  nav?: NavItem[];
  /** ナビの右端に置く操作（ログアウトのフォームなど）。 */
  headerAction?: string;
  /** `<main>` の中身。組み立て済みのHTML。 */
  body: string;
  footer?: string;
  /** 中央寄せの1枚もの（パスワード入力）にする。 */
  centered?: boolean;
  /**
   * PWAのマニフェストを指すか。既定は指す。
   * 接続を許可するだけの画面など、ホーム画面へ追加させたくないページで false にする。
   */
  manifest?: boolean;
}

/** ページ全体を組み立てる純粋関数。テストはここに当てる。 */
export function renderPage(options: PageOptions): string {
  const nav = options.nav?.length
    ? `<nav>${options.nav
        .map(
          (item) =>
            `<a href="${escapeHtml(item.href)}"${item.current ? ' class="on" aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`,
        )
        .join("")}</nav>`
    : "";
  const header =
    options.centered && !nav
      ? ""
      : `<div class="topbar"><span class="brand">AIDE</span>${nav}${options.headerAction ?? ""}</div>`;
  const footer = options.footer ? `<footer>${options.footer}</footer>` : "";
  const main = options.centered ? options.body : `<main>${options.body}</main>`;

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
${headTags({ manifest: options.manifest ?? true })}
<style>${STYLE}</style></head><body${options.centered ? ' class="centered"' : ""}>
${header}${main}${footer}
</body></html>
`;
}

/** 状態のバッジ。**色だけに頼らず、語でも状態が分かるようにする。** */
export function pill(tone: Tone, label: string): string {
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

export interface CardOptions {
  title: string;
  /** 見出しの脇の小さな補足（件数など）。 */
  meta?: string;
  /** 見出しの右端のバッジ。 */
  status?: string;
  body: string;
  /** 2列レイアウトのときに1行ぶん使う。 */
  wide?: boolean;
}

export function card(options: CardOptions): string {
  const meta = options.meta ? `<span class="n">${escapeHtml(options.meta)}</span>` : "";
  return `<section class="card${options.wide ? " wide" : ""}">
<div class="card-head"><h2>${escapeHtml(options.title)}</h2>${meta}${options.status ?? ""}</div>
<div class="card-body">${options.body}</div></section>`;
}

/**
 * 定義リスト。値は**HTMLとして扱う**（バッジを混ぜるため）ので、
 * 呼び出し側で `escapeHtml()` を通してから渡すこと。
 */
export function defList(rows: [label: string, valueHtml: string][]): string {
  return `<dl>${rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
}

/**
 * 表。セルも `defList` と同じくHTMLとして扱う。
 *
 * `rowClasses` は行ごとのclass（同じ添字で対応させる）。CSSだけで一部の行を畳むために使う。
 */
export function table(
  headers: string[],
  rows: string[][],
  rowClasses: (string | undefined)[] = [],
): string {
  const head = headers.length
    ? `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`
    : "";
  const body = rows
    .map((cells, index) => {
      const className = rowClasses[index];
      return `<tr${className ? ` class="${escapeHtml(className)}"` : ""}>${cells
        .map((cell) => `<td>${cell}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  return `<div class="tblwrap"><table>${head}<tbody>${body}</tbody></table></div>`;
}
