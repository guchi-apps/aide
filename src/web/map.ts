import type { IncomingMessage, ServerResponse } from "node:http";
import { createIssue, DEFAULT_LABELS } from "../core/connectors/github/write.ts";
import { readGitHubWriteConfig } from "../core/connectors/github/index.ts";
import { buildToolRegistry } from "../mcp/catalog.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { logoSize, logoSvg } from "./brand.ts";
import { card, escapeHtml, renderPage, siteNav } from "./layout.ts";
import { ENDPOINTS, type FeatureItem } from "./features.ts";
import { accountAction, currentSession, handleGatedPage, type LoginOptions } from "./login.ts";
import { renderInlineMarkdown } from "./markdown.ts";
import {
  buildIssueDraft,
  collectSync,
  formatSyncedAt,
  hasDifference,
  ISSUE_REPO,
  MAP_SYNC_FOOTNOTE,
  type DeclaredUse,
  type SyncResult,
} from "./map-sync.ts";

/**
 * アプリ連携の画面（`GET /map`。#328）。
 *
 * AIDEを中心に、どのアプリがAIDEを使い、AIDEがどこへ読みに行き・書き込むのかを1枚の図で示す。
 * 機能一覧（`/features`）は文字の一覧で、「何と何が繋がっているか」が読み取れなかった。
 *
 * **ログインの内側に置く（機能一覧 `/features` も同じ。#332）。** 載せるのはアプリの名前と繋がり方
 * だけで実データは無いが、利用者がどのアプリを使っているかの一覧そのものが個人の情報にあたる
 * （Issueでの指定）。
 *
 * **中身は下の静的な宣言（`CALLERS` / `GROUPS`）。** 繋がりはコードのあちこち（MCPツール・
 * HTTPエンドポイント・コネクタ・worker）に散っていて、機械的に集めても「どのアプリか」までは
 * 分からない。代わりに、宣言に書いたツール名・パスが実在すること、登録簿の全ツールが
 * どこかに載っていることを `map.test.ts` が確かめる。MCPツールやコネクタを足したら、ここへも足す。
 *
 * 図はHTML/CSSの枠と、JavaScriptが引く矢印でできている（#460。外部の描画ライブラリは使わない。
 * 実行時依存を増やさない方針。README）。図の各アプリは下の一覧へのページ内リンクになっている。
 *
 * **「機能を同期」（#355）は、宣言と今の機能の差を画面に出すだけで、宣言は書き換えない。**
 * 突き合わせは `map-sync.ts`。差があれば、図を直すIssueを起案できる（`POST /map/issue`）。
 */

/** データの流れる向き。read = アプリ→AIDE（読む）、write = AIDE→アプリ（書く・送る）。 */
export type Direction = "read" | "write" | "both";

/** AIDEを使う側のアプリ。 */
export interface Caller {
  id: string;
  name: string;
  /** 図で使う短い名前（スマホの枠に収めるため）。無ければ `name`。 */
  short?: string;
  via: "MCP" | "API";
  /** 何ができるか。1行に収める。 */
  what: string;
  /** 使う機能。`/` で始まればHTTPエンドポイント、それ以外はMCPツール名。 */
  uses: string[];
}

/** AIDEが繋ぐ先のアプリ・サービス。 */
export interface Destination {
  id: string;
  name: string;
  dir: Direction;
  what: string;
  uses: string[];
}

export interface DestinationGroup {
  name: string;
  apps: Destination[];
}

export const CALLERS: Caller[] = [
  {
    id: "claude",
    name: "Claudeアプリ・Claude Code",
    short: "Claude・Code",
    via: "MCP",
    what: "状況を聞く・登録する",
    uses: [
      "aide_ping",
      "aide_balances",
      "aide_fixed_costs",
      "aide_utility_bills",
      "asset_manager_subscriptions",
      "asset_manager_create_subscription",
      "asset_manager_add_subscription_price",
      "aide_host_status",
      "aide_uptime_monitors",
      "aide_service_quotas",
      "aide_room_sensors",
      "aide_aircon_status",
      "aide_printer_status",
      "aide_room_buttons",
      "aide_room_press",
      "aide_aircon_control",
      "aide_weather",
      "aide_schedule",
      "aide_garbage_collection",
      "aide_create_event",
      "aide_dev_status",
      "aide_repo_status",
      "aide_repo_labels",
      "aide_create_issue",
      "aide_claude_sessions",
      "aide_zaim_master",
      "aide_zaim_payment",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPTスケジュール",
    short: "ChatGPT",
    via: "MCP",
    what: "定期の取り込み・通知／サブスク登録",
    uses: [
      "asset_manager_import_payment",
      "asset_manager_create_subscription",
      "asset_manager_add_subscription_price",
      "aide_create_notification",
      "aide_create_task_candidate",
      "aide_save_daily_brief",
      "aide_research_desk_import_weekly_report",
    ],
  },
  {
    id: "asset-manager",
    name: "Asset Manager",
    via: "API",
    what: "残高・明細を読む／Zaimへ登録",
    uses: [
      "/api/money/summary",
      "/api/money/transactions",
      "/api/zaim/payment",
      "/api/zaim/payment/web",
      "/api/zaim/payment/web/genre",
      "/api/zaim/payment/web/memo",
    ],
  },
  {
    id: "car-care",
    name: "car-care",
    via: "API",
    what: "給油をZaimへ登録",
    uses: ["/api/zaim/payment", "/api/zaim/master"],
  },
  {
    id: "research-desk",
    name: "Research Desk",
    via: "API",
    what: "画像・週報をメールで送る",
    uses: ["/api/image-mail/send", "/api/news-mail/send"],
  },
  {
    id: "ops-dashboard",
    name: "ops-dashboard",
    via: "API",
    what: "AIDEの動作状況を表示",
    uses: ["/api/status", "/api/status/checks"],
  },
  {
    id: "aide-ios",
    name: "AIDE iOSアプリ",
    via: "API",
    what: "ショートカット・Siriから室温を読む／ホーム画面ウィジェットに表示",
    uses: ["/api/mobile/token", "/api/mobile/room-temperature", "/api/room/summary"],
  },
];

export const GROUPS: DestinationGroup[] = [
  {
    name: "お金",
    apps: [
      {
        id: "zaim",
        name: "Zaim",
        dir: "both",
        what: "残高・明細を読む／支出を登録",
        uses: [
          "aide_balances",
          "aide_utility_bills",
          "aide_zaim_master",
          "aide_zaim_payment",
          "/api/zaim/payment/web",
        ],
      },
      {
        id: "asset-manager",
        name: "Asset Manager",
        dir: "both",
        what: "月額固定費・サブスクを読む／登録・料金追加／請求メールを取り込む",
        uses: [
          "aide_fixed_costs",
          "asset_manager_subscriptions",
          "asset_manager_create_subscription",
          "asset_manager_add_subscription_price",
          "asset_manager_import_payment",
        ],
      },
    ],
  },
  {
    name: "予定",
    apps: [
      {
        id: "dayspan",
        name: "DaySpan",
        dir: "both",
        what: "予定・空き時間・ゴミ収集日を読む／予定を作る",
        uses: ["aide_schedule", "aide_garbage_collection", "aide_create_event"],
      },
    ],
  },
  {
    name: "暮らし",
    apps: [
      {
        id: "myroom",
        name: "myroom",
        dir: "both",
        what: "部屋の室温・CO2・エアコン・3Dプリンターの状態／照明・エアコンを操作",
        uses: [
          "aide_room_sensors",
          "aide_aircon_status",
          "aide_printer_status",
          "aide_room_buttons",
          "aide_room_press",
          "aide_aircon_control",
        ],
      },
      { id: "open-meteo", name: "Open-Meteo", dir: "read", what: "今日・明日の天気", uses: ["aide_weather"] },
    ],
  },
  {
    name: "開発・運用",
    apps: [
      {
        id: "github",
        name: "GitHub",
        dir: "both",
        what: "開発状況を読む／Issueを起票",
        uses: ["aide_dev_status", "aide_repo_status", "aide_repo_labels", "aide_create_issue"],
      },
      { id: "ops-dashboard", name: "ops-dashboard", dir: "read", what: "VPS・サブPCの稼働状況", uses: ["aide_host_status", "aide_uptime_monitors", "aide_service_quotas"] },
      {
        id: "claude-code",
        name: "Claude Code",
        dir: "read",
        what: "サブPCで動くセッション",
        uses: ["aide_claude_sessions"],
      },
      { id: "signaly", name: "Signaly", dir: "write", what: "ジョブの失敗を通知", uses: [] },
    ],
  },
  {
    name: "知らせる・送る",
    apps: [
      {
        id: "gmail",
        name: "Gmail",
        dir: "write",
        what: "画像・週報を社用メールへ",
        uses: ["/api/image-mail/send", "/api/news-mail/send"],
      },
      {
        id: "aide-bot",
        name: "aide-bot",
        dir: "write",
        what: "通知・タスク候補・日次ブリーフ",
        uses: ["aide_create_notification", "aide_create_task_candidate", "aide_save_daily_brief"],
      },
      {
        id: "research-desk",
        name: "Research Desk",
        dir: "write",
        what: "業界情報を登録",
        uses: ["aide_research_desk_import_weekly_report"],
      },
    ],
  },
];

// ---- 図 ----

/**
 * 図は**HTMLの枠（CSS Grid）と、JavaScriptが引く矢印**でできている（#460）。
 * 枠・文字はふつうのHTMLなので、説明文の折り返しやスマホ幅への切り替えはブラウザに任せ、
 * 座標や文字幅を計算しない。矢印だけは枠の実際の位置が要るため、`MAP_WIRE_SCRIPT` が測って
 * 重ねたSVGへ引く（ウィンドウ幅が変わるたびに引き直す）。JavaScriptが動かない環境では矢印が
 * 出ないが、枠のリンクと下の一覧は読める。
 * 矢印の向きはデータの流れ。**読む（アプリ→AIDE）は差し色、書く（AIDE→アプリ）は茶。**
 * 読む・書く両方あるコネクタは `data-dir="both"` で、スクリプトが2本の線に分けて引く（#426）。
 */

/** 行の右端に置く「読む」「書く」の札。色だけに頼らず語でも向きが分かるようにする（スマホ幅で表示）。 */
function tags(dir: Direction): string {
  return (
    '<span class="tags">' +
    (dir !== "write" ? '<span class="tag r">読む</span>' : "") +
    (dir !== "read" ? '<span class="tag w">書く</span>' : "") +
    "</span>"
  );
}

/**
 * 図の中央。ロゴは**左上のブランド表示と同じデータ**（`brand.ts`）を使い、`取得・整形・中継` は文字で置く。
 * ロゴの下に「VPS」「Worker＝サブPC」の2段を積む（#431）。ロゴだけだとAIDEが常時1台で動いていると
 * 誤解されるため、重い処理を担うWorkerがサブPCで動いていることを文字で示す。
 * Workerは下の一覧の`#worker-jobs`カードへ飛ぶページ内リンク。
 */
function hubHtml(): string {
  return `<div class="hub">${logoSvg(logoSize(52))}
<div class="hub-sub">取得・整形・中継</div><hr>
<div class="hub-vps">VPS ・常時稼働</div>
<a class="hub-worker" href="#worker-jobs"><b>Worker ＝ サブPC</b><span>重い処理を定期実行（${JOB_CATALOG.length}件）</span></a></div>`;
}

/** 使う側の枠。押すと下の一覧の行（`#from-…`）へ飛ぶ。スマホ幅では短い名前を出す。 */
function callerNode(caller: Caller): string {
  return `<a class="node caller" href="#from-${caller.id}"><span class="nm"><span class="nm-l">${escapeHtml(caller.name)}</span><span class="nm-s">${escapeHtml(caller.short ?? caller.name)}</span></span>` +
    `<span class="what"><span class="via">${caller.via}</span>　${escapeHtml(caller.what)}</span></a>`;
}

function destNode(app: Destination): string {
  return `<a class="node dest" href="#to-${app.id}" data-dir="${app.dir}"><span class="nm">${escapeHtml(app.name)}</span>${tags(app.dir)}` +
    `<span class="what">${escapeHtml(app.what)}</span></a>`;
}

/** アプリ連携の図。PC・iPadは左に使う側・中央にAIDE・右に繋ぐ先、スマホ幅は上・中央・下の縦並び。 */
export function renderMap(): string {
  const dests = GROUPS.map(
    (group) => `<p class="gname">${escapeHtml(group.name)}</p>${group.apps.map(destNode).join("")}`,
  ).join("");
  return `<div class="map" id="map-figure"><div class="stage">
<svg class="wires" aria-hidden="true" focusable="false"><defs>
<marker id="map-r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>
<marker id="map-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="arrow w"/></marker></defs></svg>
<div class="col callers"><p class="colhead">AIDEを使うアプリ</p>${CALLERS.map(callerNode).join("")}</div>
<div class="col hubcol">${hubHtml()}</div>
<div class="col dests"><p class="colhead">AIDEがつなぐ先</p>${dests}</div>
</div></div>`;
}

/**
 * 矢印を引くスクリプト。枠の位置は `offsetLeft` / `offsetTop` を `.stage` まで辿って求める
 * （スクロールや拡大の影響を受けない）。スマホ幅（CSSの `max-width:719px` と同じ条件）では
 * 使う側から中央へ、中央の左の幹から繋ぐ先の各行へ、PC・iPadでは中央の左右へ引く。
 */
const MAP_WIRE_SCRIPT = `<script>
(() => {
  const stage = document.querySelector("#map-figure .stage");
  if (!stage) return;
  const svg = stage.querySelector("svg.wires");
  const narrow = matchMedia("(max-width:719px)");
  const rect = (el) => {
    let l = 0, t = 0;
    for (let e = el; e && e !== stage; e = e.offsetParent) { l += e.offsetLeft; t += e.offsetTop; }
    return { l, t, r: l + el.offsetWidth, b: t + el.offsetHeight, cx: l + el.offsetWidth / 2, cy: t + el.offsetHeight / 2 };
  };
  const path = (d, cls, marker) => {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    p.setAttribute("class", cls);
    if (marker) p.setAttribute("marker-end", "url(#" + marker + ")");
    svg.appendChild(p);
  };
  const draw = () => {
    svg.querySelectorAll("path.edge").forEach((p) => p.remove());
    const hub = rect(stage.querySelector(".hub"));
    const callers = [...stage.querySelectorAll(".caller")];
    const dests = [...stage.querySelectorAll(".dest")];
    const step = (i, n) => (n > 1 ? i / (n - 1) : 0.5);
    callers.forEach((el, i) => {
      const a = rect(el), f = step(i, callers.length);
      if (narrow.matches) {
        const x = hub.l + 20 + f * (hub.r - hub.l - 40);
        path("M" + a.cx + "," + a.b + " C" + a.cx + "," + (a.b + 16) + " " + x + "," + (hub.t - 20) + " " + x + "," + (hub.t - 2), "edge", "map-r");
      } else {
        const y = hub.cy - 50 + f * 100;
        path("M" + a.r + "," + a.cy + " C" + (a.r + 70) + "," + a.cy + " " + (hub.l - 70) + "," + y + " " + (hub.l - 2) + "," + y, "edge", "map-r");
      }
    });
    if (narrow.matches && dests.length) {
      const trunk = 12;
      path("M" + hub.l + "," + hub.cy + " H" + trunk + " V" + rect(dests[dests.length - 1]).t + " ", "edge trunk");
    }
    dests.forEach((el, i) => {
      const a = rect(el), dir = el.dataset.dir, o = dir === "both" ? 4 : 0;
      const reads = dir !== "write", writes = dir !== "read";
      if (narrow.matches) {
        const y = a.t + 14, trunk = 12;
        if (reads) path("M" + (a.l - 1) + "," + (y - o / 2) + " H" + trunk, "edge solid", "map-r");
        if (writes) path("M" + trunk + "," + (y + o / 2) + " H" + (a.l - 2), "edge solid w", "map-w");
      } else {
        const y = hub.cy - 60 + step(i, dests.length) * 120;
        if (reads) path("M" + (a.l - 2) + "," + (a.cy - o) + " C" + (a.l - 40) + "," + (a.cy - o) + " " + (hub.r + 40) + "," + (y - o) + " " + (hub.r + 2) + "," + (y - o), "edge", "map-r");
        if (writes) path("M" + hub.r + "," + (y + o) + " C" + (hub.r + 40) + "," + (y + o) + " " + (a.l - 40) + "," + (a.cy + o) + " " + (a.l - 2) + "," + (a.cy + o), "edge w", "map-w");
      }
    });
  };
  draw();
  new ResizeObserver(draw).observe(stage);
})();
</script>`;

// ---- 一覧 ----

function badges(dir: Direction): string {
  return (
    (dir !== "write" ? '<span class="b r">読む</span>' : "") +
    (dir !== "read" ? '<span class="b w">書く</span>' : "")
  );
}

interface MapPopover {
  id: string;
  title: string;
  meta?: string;
  description: string;
  items?: FeatureItem[];
}

/** MCPの登録簿・HTTPの静的カタログ・workerジョブを、連携図のチップと同じ説明の出典にする。 */
function featureCatalog(): Map<string, FeatureItem> {
  const catalog = new Map<string, FeatureItem>();
  for (const tool of buildToolRegistry().list()) catalog.set(tool.name, tool);
  for (const endpoint of ENDPOINTS) catalog.set(endpoint.name, endpoint);
  for (const job of JOB_CATALOG) catalog.set(job.name, { name: job.name, description: job.description, meta: job.interval });
  return catalog;
}

function renderPopover(popover: MapPopover): string {
  const meta = popover.meta ? `<span class="popover-meta">${escapeHtml(popover.meta)}</span>` : "";
  const items = popover.items?.length
    ? `<ul class="popover-items">${popover.items
        .map(
          (item) =>
            `<li><span class="mono">${escapeHtml(item.name)}</span>${item.meta ? ` <span class="popover-meta">${escapeHtml(item.meta)}</span>` : ""}` +
            `<span>${renderInlineMarkdown(item.description)}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  return `<section id="${popover.id}" class="detail-popover" popover="auto" role="dialog" aria-labelledby="${popover.id}-title">
<div class="popover-head"><h2 id="${popover.id}-title">${escapeHtml(popover.title)}</h2>${meta}
<button type="button" class="popover-close" popovertarget="${popover.id}" popovertargetaction="hide" aria-label="閉じる">×</button></div>
<p>${renderInlineMarkdown(popover.description)}</p>${items}</section>`;
}

function detailTrigger(value: string, catalog: Map<string, FeatureItem>, popovers: MapPopover[]): string {
  const item = catalog.get(value);
  if (!item) return `<span>${escapeHtml(value)}</span>`;
  const id = `map-detail-${popovers.length}`;
  popovers.push({
    id,
    title: item.name,
    meta: item.meta,
    description: item.description,
  });
  return `<button type="button" class="detail-trigger" popovertarget="${id}" aria-haspopup="dialog">${escapeHtml(value)}</button>`;
}

function chips(values: string[], catalog: Map<string, FeatureItem>, popovers: MapPopover[]): string {
  return values.length
    ? `<span class="chips">${values.map((value) => detailTrigger(value, catalog, popovers)).join("")}</span>`
    : "";
}

/** 使う側の機能。MCPは通常は本数だけにし、押されたときだけ全件を開く。 */
function callerChips(caller: Caller, catalog: Map<string, FeatureItem>, popovers: MapPopover[]): string {
  if (caller.via !== "MCP") return chips(caller.uses, catalog, popovers);
  const id = `map-detail-${popovers.length}`;
  const tools = caller.uses.flatMap((name) => {
    const item = catalog.get(name);
    return item ? [item] : [];
  });
  popovers.push({
    id,
    title: `MCPツール ${caller.uses.length}本`,
    description: `${caller.name}から利用できるMCPツールです。`,
    items: tools,
  });
  return `<span class="chips"><button type="button" class="detail-trigger" popovertarget="${id}" aria-haspopup="dialog">MCPツール ${caller.uses.length}本</button></span>`;
}

function callersCard(catalog: Map<string, FeatureItem>, popovers: MapPopover[], gone: GoneByOwner): string {
  const items = CALLERS.map(
    (caller) =>
      `<li id="from-${caller.id}"><span class="nm">${escapeHtml(caller.name)}</span>` +
      `<span class="dir"><span class="b r">${caller.via}</span></span>` +
      `<span class="ds">${escapeHtml(caller.what)}</span>${callerChips(caller, catalog, popovers)}` +
      `${goneChips(caller.name, gone)}</li>`,
  ).join("");
  return card({ title: "AIDEを使うアプリ", meta: String(CALLERS.length), body: `<ul class="apps">${items}</ul>` });
}

function groupCard(
  group: DestinationGroup,
  catalog: Map<string, FeatureItem>,
  popovers: MapPopover[],
  gone: GoneByOwner,
): string {
  const items = group.apps
    .map(
      (app) =>
        `<li id="to-${app.id}"><span class="nm">${escapeHtml(app.name)}</span>` +
        `<span class="dir">${badges(app.dir)}</span>` +
        `<span class="ds">${escapeHtml(app.what)}</span>${chips(app.uses, catalog, popovers)}` +
        `${goneChips(app.name, gone)}</li>`,
    )
    .join("");
  return card({ title: group.name, meta: String(group.apps.length), body: `<ul class="apps">${items}</ul>` });
}

/**
 * Worker（サブPC・重い処理）の一覧（#431）。図のハブから`#worker-jobs`でここへ飛べる。
 * 出典は機能一覧の「workerジョブ」節と同じ `JOB_CATALOG`（`src/worker/jobs/catalog.ts`）で、
 * 実行間隔・何をするかを図の宣言とは別に自動で追従させる。
 */
function workerCard(): string {
  const items = JOB_CATALOG.map(
    (job) =>
      `<li><span class="nm">${escapeHtml(job.name)}</span><span class="mt">${escapeHtml(job.interval)}</span>` +
      `<span class="ds">${renderInlineMarkdown(job.description)}</span></li>`,
  ).join("");
  return card({
    id: "worker-jobs",
    title: "Worker（サブPC・重い処理）",
    meta: String(JOB_CATALOG.length),
    body: `<ul class="items">${items}</ul>`,
    wide: true,
  });
}

// ---- 機能の同期（#355） ----

/** 図のアプリ名 → そこに載っているのに実在しない機能名。 */
type GoneByOwner = Map<string, string[]>;

/** 図の宣言を、突き合わせ用の形にする（同じアプリが使う側と繋ぐ先の両方にあっても1つにまとまる）。 */
function declaredUses(): DeclaredUse[] {
  return [
    ...CALLERS.map((caller) => ({ owner: caller.name, uses: caller.uses })),
    ...GROUPS.flatMap((group) => group.apps.map((app) => ({ owner: app.name, uses: app.uses }))),
  ];
}

/** 今のAIDEの機能（MCPの登録簿と機能一覧の宣言）と図の宣言を突き合わせる。 */
export function syncMap(registry: ToolRegistry): SyncResult {
  return collectSync({ tools: registry.list(), endpoints: ENDPOINTS, declared: declaredUses() });
}

function goneByOwner(result: SyncResult): GoneByOwner {
  const gone: GoneByOwner = new Map();
  for (const feature of result.removed) {
    for (const owner of feature.owners) gone.set(owner, [...(gone.get(owner) ?? []), feature.name]);
  }
  return gone;
}

function goneChips(owner: string, gone: GoneByOwner): string {
  const names = gone.get(owner);
  if (!names?.length) return "";
  return `<span class="chips">${names
    .map((name) => `<span class="gone" title="いまのAIDEには無い"><s>${escapeHtml(name)}</s>　－ 実在しない</span>`)
    .join("")}</span>`;
}

/** 「実在しない」印が付いた最初の行。結果欄のリンクの飛び先。 */
function firstGoneAnchor(gone: GoneByOwner): string | null {
  for (const caller of CALLERS) if (gone.has(caller.name)) return `from-${caller.id}`;
  for (const app of GROUPS.flatMap((group) => group.apps)) if (gone.has(app.name)) return `to-${app.id}`;
  return null;
}

/** Issueの起票の結果。`POST /map/issue` の戻り（`?issue=` `?issue_error=`）から作る。 */
export type IssueView =
  | { kind: "done"; number?: number; url?: string; labelDropped?: boolean }
  | { kind: "failed" };

/** 同期した結果の見せ方。`renderMapPage` へ渡すと、結果欄と「未掲載の機能」が出る。 */
export interface SyncView {
  result: SyncResult;
  /** 同期した日時（JST。`formatSyncedAt`）。 */
  syncedAt: string;
  /** Issueの起案を出すか。起票の設定が無い環境では出さない（設定の有無は画面に書かない）。 */
  canDraftIssue: boolean;
  /** 起票先の表記（`guchi-apps/aide`）。 */
  issueTarget: string;
  issue?: IssueView | undefined;
}

const SYNC_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 5.5A5.75 5.75 0 0 0 3.2 4.6L2.5 5.8"/><path d="M2.5 2.5v3.3h3.3"/><path d="M2.5 10.5a5.75 5.75 0 0 0 10.3.9l.7-1.2"/><path d="M13.5 13.5v-3.3h-3.3"/></svg>';

/**
 * 同期ボタン。**読み取りだけなので素のフォーム（GET）で送る。** JavaScriptが動かなくても押せ、
 * 何も書き換えないのでCSRFの心配も要らない。
 */
function syncButton(sync: SyncView | undefined): string {
  const note = sync ? `同期 ${escapeHtml(sync.syncedAt)}` : "押すと、今のAIDEの機能と突き合わせます";
  return `<form class="sync-area" method="get" action="/map" data-busy="確認しています…">
<input type="hidden" name="sync" value="1">
<button type="submit" class="sync">${SYNC_ICON}<span class="sync-label">機能を同期</span></button>
<span class="synced-at">${note}</span>
</form>`;
}

function counts(result: SyncResult): string {
  return `<div class="counts"><span class="count add">＋ 追加 <b>${result.added.length}</b></span>` +
    `<span class="count del">－ 削除 <b>${result.removed.length}</b></span>` +
    `<span class="count same">＝ 変更なし <b>${result.same}</b></span></div>`;
}

/** 起案の確認。押すと起票内容（タイトルと本文）を見せ、「起票する」で `POST /map/issue` へ送る。 */
function issueDraft(result: SyncResult, syncedAt: string, target: string): string {
  const draft = buildIssueDraft(result, syncedAt);
  const button =
    '<button type="button" class="sync primary" popovertarget="issue-draft" aria-haspopup="dialog">Issueを起案…</button>' +
    '<span class="hint">図を直すIssueを、この差から作ります。押すと内容を確認できます。</span>';
  const dialog = `<section id="issue-draft" class="detail-popover draft" popover="auto" role="dialog" aria-labelledby="issue-draft-title">
<div class="popover-head"><h2 id="issue-draft-title">Issueを起案</h2>
<button type="button" class="popover-close" popovertarget="issue-draft" popovertargetaction="hide" aria-label="閉じる">×</button></div>
<p>${escapeHtml(target)} に、ラベル <span class="mono">${escapeHtml(DEFAULT_LABELS.join(" / "))}</span> を付けて作成します。内容は同期の結果から自動で組み立てられ、ここでは編集できません。</p>
<dl><dt>タイトル</dt><dd>${escapeHtml(draft.title)}</dd><dt>本文</dt><dd><pre>${escapeHtml(draft.body)}</pre></dd></dl>
<form class="draft-actions" method="post" action="/map/issue" data-busy="起票しています…">
<button type="button" class="sync quiet" popovertarget="issue-draft" popovertargetaction="hide">やめる</button>
<button type="submit" class="sync primary"><span class="sync-label">起票する</span></button>
</form></section>`;
  return `<div class="actions">${button}</div>${dialog}`;
}

/** 同期の結果欄。差の有無・起票の結果に応じて中身が変わる。 */
function syncResult(sync: SyncView): string {
  const { result, syncedAt, issue } = sync;
  const time = `<span class="t">${escapeHtml(syncedAt)}</span>`;

  if (!hasDifference(result) && issue?.kind !== "done") {
    return `<section class="result calm" aria-live="polite">
<div class="result-head"><h2>差はありません</h2>${time}</div>${counts(result)}
<p class="result-note">図に載っている機能は、いまのAIDEの機能と一致しています。</p></section>`;
  }

  if (issue?.kind === "done") {
    const link = issue.url
      ? `<a href="${escapeHtml(issue.url)}" rel="noopener noreferrer">${escapeHtml(sync.issueTarget)} #${issue.number} を開く</a>`
      : "";
    return `<section class="result done" aria-live="polite">
<div class="result-head"><h2>Issueを起票しました</h2>${time}</div>${counts(result)}
<div class="actions"><button type="button" class="sync" disabled>起票済み</button>${link}</div>
${
      issue.labelDropped
        ? `<p class="fail" role="alert">ラベル ${escapeHtml(DEFAULT_LABELS.join(" / "))} を付けられませんでした。無人実行が着手し得るので、GitHubの画面でラベルを付けてください。</p>`
        : `<p class="result-note">ラベルは ${escapeHtml(DEFAULT_LABELS.join(" / "))} です。着手するかは issue-deck で決めます。</p>`
    }</section>`;
  }

  const gone = goneByOwner(result);
  const goneAnchor = firstGoneAnchor(gone);
  const jumps =
    (result.added.length > 0 ? '<a href="#found">未掲載の機能へ</a>' : "") +
    (goneAnchor ? `<a href="#${goneAnchor}">実在しない項目へ</a>` : "");
  const fail =
    issue?.kind === "failed"
      ? '<p class="fail" role="alert">Issueを起票できませんでした。直前に同じ内容を起票していないか確認し、時間をおいてもう一度お試しください。</p>'
      : "";
  return `<section class="result" aria-live="polite">
<div class="result-head"><h2>同期しました</h2>${time}</div>${counts(result)}
${jumps ? `<div class="jump">${jumps}</div>` : ""}${fail}
${sync.canDraftIssue ? issueDraft(result, syncedAt, sync.issueTarget) : ""}
<p class="result-note">対象はMCPツールと /api/ のエンドポイントです。図の宣言は書き換えません。図へ載せる・外すにはコードの修正が要ります。</p></section>`;
}

/** 図に載っていない機能。宣言（`CALLERS` / `GROUPS`）には無いので、同期のたびに集め直して出す。 */
function foundCard(result: SyncResult): string {
  if (result.added.length === 0) return "";
  const items = result.added
    .map((feature) => {
      const meta = feature.meta ? `${feature.kind}・${feature.meta}` : feature.kind;
      return `<li><span class="head"><span class="nm">${escapeHtml(feature.name)}</span><span class="mt">${escapeHtml(meta)}</span><span class="b new">＋ 追加</span></span>` +
        `<span class="ds">${escapeHtml(feature.description)}</span></li>`;
    })
    .join("");
  return `<section class="card wide found" id="found">
<div class="card-head"><h2>未掲載の機能</h2><span class="n">${result.added.length}</span></div>
<div class="card-body"><p class="sub">同期で見つかった、図にまだ載っていない機能です。</p><ul class="items">${items}</ul></div></section>`;
}

const LEGEND = `<ul class="legend">
<li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="26" y2="5" stroke="var(--accent)" stroke-width="1.6"/><path d="M24,0 L34,5 L24,10z" fill="var(--accent)"/></svg>AIDEへ流れる（読む・呼び出す）</li>
<li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="26" y2="5" stroke="var(--wr)" stroke-width="1.6"/><path d="M24,0 L34,5 L24,10z" fill="var(--wr)"/></svg>AIDEから流れる（書く・送る）</li>
</ul>`;

/**
 * 図のリンクは、JavaScriptが無効なら通常のアンカーリンクとして働く。
 * 有効なときだけ既定の上端寄せを止めて、対象を画面中央付近へ表示する。
 *
 * **`history.pushState` はURLを書き換えるだけで、CSSの `:target` は更新されない。** そのため
 * 強調は `:target` に頼らず、移動先へ `.arrived` を付けて出す。消えるまでの時間はCSS
 * （`src/web/layout.ts` の `.apps li.arrived`）が持つので、ここでは外さない。
 * 同じ行をもう一度選んだときは、付け直して強調を最初からやり直す。
 */
const CENTER_TARGET_SCRIPT = `<script>
const arriveAt = (target) => {
  target.classList.remove("arrived");
  void target.offsetWidth;
  target.classList.add("arrived");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
};
document.querySelectorAll('.mapcard a[href^="#"], .result .jump a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const href = link.getAttribute("href");
    const target = href ? document.getElementById(href.slice(1)) : null;
    if (!target) return;
    event.preventDefault();
    history.pushState(null, "", href);
    arriveAt(target);
  });
});
addEventListener("popstate", () => {
  const target = document.getElementById(location.hash.slice(1));
  if (target) arriveAt(target);
});
</script>`;

/**
 * 送信中の表示。ボタンを押せなくして文言を差し替える（二重に起票させないためでもある）。
 * 送信そのものはJavaScriptに頼らない素のフォームなので、ここは見た目だけ。
 * 戻る操作でページが復元されたときは、押せる状態へ戻す。
 */
const BUSY_SCRIPT = `<script>
document.querySelectorAll("form[data-busy]").forEach((form) => {
  const button = form.querySelector('button[type="submit"]');
  const label = button && button.querySelector(".sync-label");
  if (!button || !label) return;
  const original = label.textContent;
  form.addEventListener("submit", () => {
    label.textContent = form.dataset.busy;
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  });
  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    label.textContent = original;
    button.removeAttribute("aria-busy");
    button.disabled = false;
  });
});
</script>`;

export interface MapPageOptions {
  /** ヘッダー右端（ログイン中の表示・ログアウト）。 */
  headerAction?: string;
  /** 認証が無効な環境か。無効なら画面の先頭で警告する。 */
  authDisabled?: boolean;
  /** 「機能を同期」を押した後の結果。無ければ従来どおりの画面（ボタンだけが出る）。 */
  sync?: SyncView;
}

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderMapPage(options: MapPageOptions = {}): string {
  const catalog = featureCatalog();
  const popovers: MapPopover[] = [];
  const gone = options.sync ? goneByOwner(options.sync.result) : new Map<string, string[]>();
  const warning = options.authDisabled
    ? `<p class="notice">認証が無効です（AIDE_AUTH_DISABLED=1）。この画面もMCPも誰でも開けます。</p>`
    : "";
  const body = `<section class="hero">
<div class="hero-top"><h1>アプリ連携</h1>${syncButton(options.sync)}</div>
<p class="lead">AIDEを中心に、どのアプリがどうつながっているかを示します。左（スマホでは上）がAIDEを使うアプリ、右（スマホでは下）がAIDEが読みに行く・書き込む先です。アプリを押すと、下の一覧の該当する行へ移ります。重い処理（Zaimの巡回など）はサブPCで動くWorkerが定期的に行い、結果をVPSへ送ります。</p>
${LEGEND}${warning}
</section>
${options.sync ? syncResult(options.sync) : ""}
<section class="mapcard">
${renderMap()}
</section>
<div class="grid">
${options.sync ? foundCard(options.sync.result) : ""}
${callersCard(catalog, popovers, gone)}
${workerCard()}
${GROUPS.map((group) => groupCard(group, catalog, popovers, gone)).join("\n")}
</div>
${popovers.map(renderPopover).join("\n")}
${MAP_WIRE_SCRIPT}
${CENTER_TARGET_SCRIPT}
${BUSY_SCRIPT}`;

  return renderPage({
    title: "AIDE のアプリ連携",
    nav: siteNav("map"),
    headerAction: options.headerAction ?? "",
    body,
    footer: "細かなエンドポイントの一覧は「機能一覧」にあります。動作状況は ops-dashboard の「AIDE」タブで確認できます。",
  });
}

/** テストで差し替えられるよう、時計と起票の口を外から渡せるようにしてある。 */
export interface MapDeps {
  now?: () => Date;
  /** 起票の設定。無ければ null（＝起案のボタンを出さない）。 */
  readIssueConfig?: typeof readGitHubWriteConfig;
  createIssue?: typeof createIssue;
  /** ログインの判定。テストが本物のセッション鍵ファイルを作らずに済むよう差し替えられる。 */
  currentSession?: typeof currentSession;
}

/** 起票の設定が無い環境で、表記にだけ使う組織名（`github/index.ts` の既定と同じ）。 */
const DEFAULT_ISSUE_ORG = "guchi-apps";

/** Issue番号として受け付ける形。**戻り先のクエリはそのまま信用せず、数字だけを通す。** */
const ISSUE_NUMBER = /^\d{1,9}$/;

function issueViewFrom(params: URLSearchParams, deps: MapDeps): IssueView | undefined {
  if (params.has("issue_error")) return { kind: "failed" };
  const raw = params.get("issue");
  if (raw === null) return undefined;
  // 真偽だけを取り出す。値そのものは画面に出さないので、クエリの中身は信用しなくてよい。
  const labelDropped = params.get("label_dropped") === "1";
  if (raw === "ok") return { kind: "done", labelDropped };
  if (!ISSUE_NUMBER.test(raw)) return undefined;
  const org = (deps.readIssueConfig ?? readGitHubWriteConfig)()?.org;
  const number = Number(raw);
  return org
    ? { kind: "done", number, labelDropped, url: `https://github.com/${org}/${ISSUE_REPO}/issues/${number}` }
    : { kind: "done", number, labelDropped };
}

export async function handleMapPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: MapDeps = {},
): Promise<void> {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  // 起票の戻り（?issue=・?issue_error=）は、結果欄を出すために同期も兼ねる。
  const issue = issueViewFrom(params, deps);
  const wantsSync = params.get("sync") === "1" || issue !== undefined;

  await handleGatedPage(req, res, options, "/map", (session) => {
    const config = wantsSync ? (deps.readIssueConfig ?? readGitHubWriteConfig)() : null;
    const sync: SyncView | undefined = wantsSync
      ? {
          result: syncMap(options.registry),
          syncedAt: formatSyncedAt((deps.now ?? (() => new Date()))()),
          canDraftIssue: config !== null,
          issueTarget: `${config?.org ?? DEFAULT_ISSUE_ORG}/${ISSUE_REPO}`,
          issue,
        }
      : undefined;
    return renderMapPage({
      headerAction: accountAction(session, options.authConfig.enabled),
      authDisabled: !options.authConfig.enabled,
      ...(sync ? { sync } : {}),
    });
  });
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" }).end();
}

/**
 * 同期の結果からIssueを起票する（`POST /map/issue`）。
 *
 * **本文はここで同期し直して組み立て、画面からの入力は一切使わない。** 送られてくるのは
 * ボタンを押したという事実だけで、起票の内容を利用者が書き換える口は持たない。
 * ログインの関門は他の画面と同じ `currentSession` を通す（Cookieは SameSite=Lax で、
 * 別サイトからの送信には付かない）。結果は303で `/map` へ戻して画面に出すため、
 * 再読み込みしても二重には起票されない。
 *
 * 失敗の理由は画面へ出さず（トークンの名前などが混ざるため）ログにだけ残す。
 */
export async function handleMapIssue(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: MapDeps = {},
): Promise<void> {
  // 本文は使わないので読まずに捨てる。
  req.resume();

  const session = await (deps.currentSession ?? currentSession)(req, options);
  if (!session) {
    redirect(res, "/map");
    return;
  }

  const result = syncMap(options.registry);
  if (!hasDifference(result)) {
    redirect(res, "/map?sync=1");
    return;
  }

  const config = (deps.readIssueConfig ?? readGitHubWriteConfig)();
  if (!config) {
    redirect(res, "/map?sync=1&issue_error=1");
    return;
  }

  const draft = buildIssueDraft(result, formatSyncedAt((deps.now ?? (() => new Date()))()));
  const outcome = await (deps.createIssue ?? createIssue)(config, {
    repo: ISSUE_REPO,
    title: draft.title,
    body: draft.body,
    footnote: MAP_SYNC_FOOTNOTE,
  });

  if (!outcome.ok) {
    console.warn(`[map-sync] 起票せず: ${outcome.reason ?? "理由不明"}`);
    redirect(res, "/map?sync=1&issue_error=1");
    return;
  }
  console.log(`[map-sync] 起票: ${outcome.repo}#${outcome.number}`);
  if (outcome.warning) console.warn(`[map-sync] ${outcome.repo}#${outcome.number}: ${outcome.warning}`);
  const dropped = outcome.warning ? "&label_dropped=1" : "";
  redirect(res, `/map?sync=1&issue=${typeof outcome.number === "number" ? outcome.number : "ok"}${dropped}`);
}
