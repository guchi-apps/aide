import { headTags } from "./assets.ts";

/**
 * 人間向けHTMLページの共通レイアウト。
 *
 * AIDEがブラウザへ出す画面は3つある（アプリ連携・機能一覧・ログイン）。
 * それぞれが自前のCSSを持っていたため、同じ「カード」「見出し」でも余白も色も違っていた。
 * **配色・書体・部品はここだけが持ち**、各ページは中身の組み立てに専念する。
 *
 * 外部のCSS・フォント・スクリプトを読み込まない。ページを表示しただけで第三者へ
 * リクエストが飛ぶのを避けるためで、書体は端末が持っているものから選ぶ。
 * アイコンとPWAマニフェスト（`src/web/assets.ts`）だけは自分で配信しているため `<head>` に入れる。
 * 実行時依存を増やさない方針（README）と同じ理由で、ここでもテンプレートエンジンは使わない。
 */

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
 * 図から移動した一覧の行を目立たせる動き。3.5秒（70%）は淡い色を保ち、残りの1.5秒で消える。
 * **時間を変えるのは `.apps li` の `animation` の秒数だけ**で、JSは時間を持たない。
 *
 * 同じ動きを名前だけ変えて2つ出す。`:target`（直接URL・戻る操作・JS無効）と `.arrived`（JSでの移動）で
 * 名前が違えば、`:target` が残っていても `.arrived` を付け直したときに最初からやり直せる。
 * 名前が同じだと、規則が当たり続けるためアニメーションが再開しない。
 */
const ARRIVE_KEYFRAMES = (name: string) =>
  `@keyframes ${name}{0%,70%{background:var(--focus);outline-color:var(--focus-line)}100%{background:transparent;outline-color:transparent}}`;

/**
 * 配色は明暗の2組。切り替えスイッチは置かず、端末の設定にそのまま従う。
 * 差し色（青）は「読む・AIDEへ流れる」、茶（`--wr`）は「書く・AIDEから流れる」に使う
 * （アプリ連携の図）。赤（`--bad`）はエラー表示と「実在しない」印、緑（`--ok`）は「追加」の
 * 印にしか使わない（機能の同期。#355）。色だけに頼らず、＋・－の記号と語も併せて出す。
 */
const STYLE = `
:root{
 --bg:#eceff2;--panel:#fff;--panel-2:#f5f7f9;
 --ink:#131b22;--ink-2:#3c4a55;--muted:#67757f;
 --line:#d8e0e6;--line-2:#e9eef1;
 --accent:#1b5a75;--accent-soft:#e3edf2;--on-accent:#fff;
 --focus:#f1f6f8;--focus-line:#9dbbc9;
 --wr:#7a4d12;--wr-bg:#f6ecdc;
 --bad:#a52f26;--bad-bg:#f8e3e0;
 --ok:#2c6a3a;--ok-bg:#e2f0e4;
}
@media (prefers-color-scheme:dark){
 :root{
  --bg:#0c1216;--panel:#141d24;--panel-2:#19242c;
  --ink:#dde6ec;--ink-2:#b3c1cb;--muted:#8494a0;
  --line:#26333c;--line-2:#1e2a32;
  --accent:#6bb6d6;--accent-soft:#16313e;--on-accent:#0c1216;
  --focus:#172a34;--focus-line:#356071;
  --wr:#e0b070;--wr-bg:#33260f;
  --bad:#ef8175;--bad-bg:#3a1c19;
  --ok:#7fc48a;--ok-bg:#14301a;
 }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:${FONT_SANS};
 line-height:1.7;font-size:15px;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,svg a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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

/* ---- 一覧（機能一覧ページ） ---- */
.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.items li{padding:.55rem 0;border-bottom:1px solid var(--line-2);display:flex;flex-direction:column;gap:.1rem}
.items li:last-child{border-bottom:0}
.items .nm{font-family:${FONT_MONO};font-size:.84rem;font-weight:500;color:var(--accent);overflow-wrap:anywhere}
.items .mt{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted);margin-left:.5rem}
.items .ds{font-size:.82rem;color:var(--ink-2)}
.connect{background:var(--accent-soft);border:1px solid var(--accent);padding:.7rem .9rem;
 display:grid;grid-template-columns:auto minmax(0,1fr);gap:.25rem .9rem;font-size:.84rem;align-items:baseline}
.connect dt{color:var(--accent)}

/* ---- アプリ連携（図と一覧） ---- */
/* 図は横長（PC・iPad）と縦長（スマホ）の2枚を出し分ける。1枚を縮めるとスマホで字が読めない。 */
.legend{display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;font-size:.8rem;color:var(--muted);margin:0;padding:0;list-style:none}
.legend li{display:flex;align-items:center;gap:.4rem}
.legend svg{flex:none}
.mapcard{background:var(--panel);border:1px solid var(--line);padding:.8rem .6rem}
@media (min-width:720px){.mapcard{padding:1rem 1.2rem}}
.mapcard svg{display:block;width:100%;height:auto}
.map-wide{display:none}
@media (min-width:720px){.map-wide{display:block}.map-narrow{display:none}}
.maphead{display:flex;justify-content:space-between;font-size:.74rem;letter-spacing:.08em;color:var(--muted);margin:0 0 .4rem;padding:0 .2rem}
.n-box{fill:var(--panel-2);stroke:var(--line)}
.n-name{fill:var(--ink);font-size:14px;font-weight:600}
.n-sub{fill:var(--muted);font-size:11.5px}
.n-via{fill:var(--accent);font-size:11px;font-family:${FONT_MONO};font-weight:600}
.hub-box{fill:var(--accent)}
.hub-name{fill:var(--on-accent);font-size:26px;font-weight:700;letter-spacing:.14em;font-family:${FONT_MONO}}
.hub-sub{fill:var(--on-accent);font-size:11.5px;opacity:.85}
.g-name{fill:var(--muted);font-size:11.5px;font-weight:700;letter-spacing:.1em}
.row-box{fill:var(--panel);stroke:var(--line)}
svg a:hover .row-box,svg a:hover .n-box{stroke:var(--accent)}
.row-name{fill:var(--accent);font-size:13px;font-weight:600;font-family:${FONT_MONO}}
.row-what{fill:var(--ink-2);font-size:11.5px}
.edge{fill:none;stroke:var(--accent);stroke-width:1.4;opacity:.55}
.edge.w{stroke:var(--wr);opacity:.75}
.edge.solid{opacity:1}
.edge.trunk{stroke:var(--line);opacity:1;stroke-width:2}
.arrow{fill:var(--accent)}
.arrow.w{fill:var(--wr)}
.tag-r{fill:var(--accent-soft);stroke:var(--accent)}
.tag-w{fill:var(--wr-bg);stroke:var(--wr)}
.tag-rt{fill:var(--accent);font-size:10.5px;font-weight:700}
.tag-wt{fill:var(--wr);font-size:10.5px;font-weight:700}
.apps{list-style:none;margin:0;padding:0}
.apps li{padding:.55rem 0;border-bottom:1px solid var(--line-2);display:grid;
 grid-template-columns:minmax(0,1fr) auto;gap:.1rem .6rem;align-items:baseline;scroll-margin-top:1rem}
.apps li:last-child{border-bottom:0}
.apps li:target,.apps li.arrived{outline:1px solid transparent;outline-offset:0}
.apps li:target{animation:arrive 5s ease-out forwards}
.apps li.arrived{animation:arrive-again 5s ease-out forwards}
${ARRIVE_KEYFRAMES("arrive")}
${ARRIVE_KEYFRAMES("arrive-again")}
.apps .nm{font-family:${FONT_MONO};font-size:.86rem;font-weight:600;color:var(--accent);overflow-wrap:anywhere}
.apps .dir{display:flex;gap:.25rem}
.b{font-size:.7rem;font-weight:700;padding:0 .4rem;border:1px solid;white-space:nowrap}
.b.r{color:var(--accent);background:var(--accent-soft);border-color:var(--accent)}
.b.w{color:var(--wr);background:var(--wr-bg);border-color:var(--wr)}
.apps .ds{grid-column:1/-1;font-size:.84rem;color:var(--ink-2)}
.chips{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.3rem;margin:.15rem 0 0;padding:0;list-style:none}
.chips span,.detail-trigger{font-family:${FONT_MONO};font-size:.72rem;padding:.05rem .45rem;background:var(--panel-2);
 color:var(--muted);border:1px solid var(--line);overflow-wrap:anywhere}
.detail-trigger{cursor:pointer;text-align:left}
.detail-trigger:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.detail-popover{margin:auto;width:min(34rem,calc(100% - 2rem));max-height:calc(100vh - 2rem);overflow:auto;
 padding:.9rem 1rem;background:var(--panel);color:var(--ink);border:1px solid var(--line);box-shadow:0 .8rem 2rem #0004}
.detail-popover::backdrop{background:#0003}
.popover-head{display:flex;align-items:baseline;gap:.5rem;border-bottom:1px solid var(--line-2);padding-bottom:.5rem}
.popover-head h2{font-family:${FONT_MONO};font-size:.9rem;color:var(--accent);overflow-wrap:anywhere;margin:0}
.popover-meta{font-family:${FONT_MONO};font-size:.72rem;color:var(--muted)}
.popover-close{margin-left:auto;font:inherit;font-size:1.25rem;line-height:1;color:var(--muted);background:none;border:0;cursor:pointer}
.detail-popover>p{font-size:.84rem;color:var(--ink-2);margin:.7rem 0}
.popover-items{list-style:none;margin:0;padding:0}.popover-items li{padding:.55rem 0;border-top:1px solid var(--line-2)}
.popover-items li>.mono{color:var(--accent);font-size:.84rem;overflow-wrap:anywhere}.popover-items li>span:last-child{display:block;font-size:.8rem;color:var(--ink-2)}
.notice{margin:0;padding:.55rem .7rem;background:var(--bad-bg);border-left:3px solid var(--bad);font-size:.86rem}

/* ---- 機能の同期（アプリ連携。#355） ---- */
.sync-area{margin:0;display:flex;flex-direction:column;align-items:stretch;gap:.25rem;flex:1 1 100%}
@media (min-width:720px){.sync-area{align-items:flex-end;flex:none}}
.sync{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font:inherit;font-size:.86rem;font-weight:700;
 padding:.5rem .95rem;background:var(--panel);color:var(--accent);border:1px solid var(--accent);cursor:pointer;min-height:2.4rem}
.sync:hover{background:var(--accent-soft)}
.sync.primary{background:var(--accent);color:var(--on-accent)}
.sync.primary:hover{opacity:.9}
.sync.quiet{color:var(--ink-2);border-color:var(--line)}
.sync svg{flex:none}
.sync[aria-busy="true"]{cursor:progress;background:var(--accent-soft);color:var(--muted);border-color:var(--line)}
.sync[aria-busy="true"] svg{animation:spin 1s linear infinite}
.sync[disabled]:not([aria-busy]){cursor:default;background:var(--panel-2);color:var(--muted);border-color:var(--line)}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sync[aria-busy="true"] svg{animation:none}}
.synced-at{font-size:.74rem;color:var(--muted);font-family:${FONT_MONO};text-align:center}
@media (min-width:720px){.synced-at{text-align:right}}
.result{border:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column}
.result-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:.2rem .7rem;padding:.65rem .9rem;border-bottom:1px solid var(--line-2)}
.result-head h2{font-size:.92rem;margin:0;font-weight:700}
.result-head .t{font-family:${FONT_MONO};font-size:.74rem;color:var(--muted);margin-left:auto}
.counts{display:flex;flex-wrap:wrap;gap:.5rem;padding:.75rem .9rem 0}
.count{display:flex;align-items:baseline;gap:.45rem;padding:.3rem .7rem;border:1px solid;font-size:.82rem;font-weight:700;white-space:nowrap}
.count b{font-family:${FONT_MONO};font-size:1.15rem}
.count.add{color:var(--ok);background:var(--ok-bg);border-color:var(--ok)}
.count.del{color:var(--bad);background:var(--bad-bg);border-color:var(--bad)}
.count.same{color:var(--muted);background:var(--panel-2);border-color:var(--line)}
.jump{display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;padding:.6rem .9rem 0;font-size:.84rem}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .9rem;padding:.75rem .9rem 0}
.actions .sync{width:100%}
@media (min-width:720px){.actions .sync{width:auto}}
.actions .hint{font-size:.78rem;color:var(--muted);flex:1 1 14rem}
.result-note{margin:0;padding:.65rem .9rem .75rem;font-size:.78rem;color:var(--muted)}
.result.calm .result-head h2,.result.done .result-head h2{color:var(--ok)}
.result.calm .result-note,.result.done .result-note{padding-top:.55rem;color:var(--ink-2);font-size:.84rem}
.fail{margin:.75rem .9rem 0;padding:.5rem .7rem;background:var(--bad-bg);border-left:3px solid var(--bad);font-size:.84rem}
.card.found{border-style:dashed;border-color:var(--ok)}
.b.new{color:var(--ok);background:var(--ok-bg);border-color:var(--ok)}
.items .head{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.items .head .mt{margin-left:0}
.chips span.gone{color:var(--bad);background:var(--bad-bg);border-color:var(--bad)}
/* Issue起案の確認。ポップオーバー本体には display を与えない（閉じているときの非表示が効かなくなる）。 */
.draft dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:.35rem .8rem;font-size:.82rem}
.draft dt{color:var(--muted)}
.draft dd{margin:0;overflow-wrap:anywhere}
.draft pre{margin:0;padding:.55rem .7rem;background:var(--panel-2);border:1px solid var(--line-2);font-family:${FONT_MONO};font-size:.74rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.draft-actions{margin:.8rem 0 0;display:flex;flex-wrap:wrap;gap:.5rem;justify-content:flex-end}

/* ---- ログイン（画面のログイン・接続の許可） ---- */
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
export type NavKey = "map" | "features";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "map", href: "/map", label: "アプリ連携" },
  { key: "features", href: "/features", label: "機能一覧" },
];

/**
 * ヘッダーのナビ。**どの画面も同じ並びを持つよう、定義はここ1か所にする。**
 * 各ページが自前で配列を書いていたときは、画面を足すたびに書き漏らしが出ていた。
 */
export function siteNav(current: NavKey): NavItem[] {
  return NAV.map((item) => ({ href: item.href, label: item.label, current: item.key === current }));
}

/**
 * ログイン後の戻り先として許す画面か。
 *
 * **ここに無いものは受け付けない。** 戻り先は署名付きCookieやフォームで運ぶが、署名が保証
 * するのは「AIDEが書いた値であること」だけで、行き先が妥当かは別に確かめる必要がある
 * （外部URLを入れられると、ログイン直後に別サイトへ送り出す踏み台になる）。
 */
export function isSiteNavPath(path: string | null | undefined): boolean {
  return NAV.some((item) => item.href === path);
}

/** ナビに並ぶ画面の名前。ナビに無いパスなら `null`。ログイン画面の見出しに使う。 */
export function siteNavLabel(path: string | null | undefined): string | null {
  return NAV.find((item) => item.href === path)?.label ?? null;
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

export interface CardOptions {
  title: string;
  /** 見出しの脇の小さな補足（件数など）。 */
  meta?: string;
  body: string;
  /** 2列レイアウトのときに1行ぶん使う。 */
  wide?: boolean;
}

export function card(options: CardOptions): string {
  const meta = options.meta ? `<span class="n">${escapeHtml(options.meta)}</span>` : "";
  return `<section class="card${options.wide ? " wide" : ""}">
<div class="card-head"><h2>${escapeHtml(options.title)}</h2>${meta}</div>
<div class="card-body">${options.body}</div></section>`;
}
