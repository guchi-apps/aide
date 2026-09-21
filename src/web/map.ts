import type { IncomingMessage, ServerResponse } from "node:http";
import { createIssue, DEFAULT_LABELS } from "../core/connectors/github/write.ts";
import { readGitHubWriteConfig } from "../core/connectors/github/index.ts";
import { buildToolRegistry } from "../mcp/catalog.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { logoSize, logoSvg, logoWidth } from "./brand.ts";
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
 * 図はサーバー側でSVGとして組み立て、JavaScriptも外部の描画ライブラリも使わない
 * （実行時依存を増やさない方針。README）。図の各アプリは下の一覧へのページ内リンクになっている。
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
        what: "予定・空き時間を読む／予定を作る",
        uses: ["aide_schedule", "aide_create_event"],
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
 * 矢印の定義。**向きはデータの流れ。** 読む（アプリ→AIDE）は差し色、書く（AIDE→アプリ）は茶。
 * 2枚の図が同じページに載るため、IDは図ごとに接頭辞を変える。
 */
function markers(prefix: string): string {
  const marker = (id: string, cls: string) =>
    `<marker id="${prefix}${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow${cls}"/></marker>`;
  return `<defs>${marker("r", "")}${marker("w", " w")}</defs>`;
}

/** AIDE と繋ぐ先の間の線。読むはAIDE側に、書くはアプリ側に矢じりを付ける。 */
function edge(prefix: string, d: string, dir: Direction, extra = ""): string {
  const start = dir === "write" ? "" : ` marker-start="url(#${prefix}r)"`;
  const end = dir === "read" ? "" : ` marker-end="url(#${prefix}w)"`;
  return `<path d="${d}" class="edge${dir === "read" ? "" : " w"}${extra}"${start}${end}/>`;
}

interface PlacedRow extends Destination {
  y: number;
}

/** 繋ぐ先を上から順に並べたときの行の位置と、領域の見出しの位置。 */
function layoutRows(start: number, rowH: number, headH: number, gap: number) {
  let y = start;
  const rows: PlacedRow[] = [];
  const heads: { name: string; y: number }[] = [];
  GROUPS.forEach((group, index) => {
    if (index > 0) y += gap;
    heads.push({ name: group.name, y: y + headH - 9 });
    y += headH;
    for (const app of group.apps) {
      rows.push({ ...app, y });
      y += rowH;
    }
  });
  return { rows, heads, end: y };
}

/**
 * 図の中央に置くワードマーク。**左上のブランド表示と同じデータ**（`brand.ts`）を、中心の
 * x・上端のy・高さで指定して置く。`取得・整形・中継` はこの下に文字（`<text>`）で置き、
 * 画像には焼かない。
 */
function hubLogo(centerX: number, top: number, height: number): string {
  return logoSvg(`x="${centerX - logoWidth(height) / 2}" y="${top}" ${logoSize(height)}`);
}

/** PC・iPad向け。左に使う側、中央にAIDE、右に繋ぐ先。 */
export function renderWideMap(): string {
  const p = "mw-";
  const W = 1030;
  const RX = 662;
  const rowH = 34;
  const { rows, heads, end } = layoutRows(6, rowH, 26, 14);
  const H = end + 6;
  const hy = H / 2;
  const hubH = 150;
  const cH = 56;
  const cGap = (H - CALLERS.length * cH) / Math.max(1, CALLERS.length - 1);

  const parts: string[] = [];
  CALLERS.forEach((caller, i) => {
    const cy = Math.round(i * (cH + cGap));
    const my = cy + cH / 2;
    const ty = Math.round(hy - 50 + (i * 100) / Math.max(1, CALLERS.length - 1));
    parts.push(`<path d="M232,${my} C320,${my} 330,${ty} 408,${ty}" class="edge" marker-end="url(#${p}r)"/>`);
    parts.push(
      `<a href="#from-${caller.id}"><rect x="0" y="${cy}" width="232" height="${cH}" class="n-box"/>` +
        `<text x="12" y="${cy + 23}" class="n-name">${escapeHtml(caller.name)}</text>` +
        `<text x="12" y="${cy + 43}" class="n-sub"><tspan class="n-via">${caller.via}</tspan>  ${escapeHtml(caller.what)}</text></a>`,
    );
  });
  rows.forEach((row, i) => {
    const my = row.y + (rowH - 4) / 2;
    const ty = Math.round(hy - 60 + (i * 120) / Math.max(1, rows.length - 1));
    parts.push(edge(p, `M592,${ty} C630,${ty} 630,${my} ${RX - 2},${my}`, row.dir));
    parts.push(
      `<a href="#to-${row.id}"><rect x="${RX}" y="${row.y}" width="${W - RX}" height="${rowH - 4}" class="row-box"/>` +
        `<text x="${RX + 10}" y="${row.y + 20}" class="row-name">${escapeHtml(row.name)}</text>` +
        `<text x="${RX + 176}" y="${row.y + 20}" class="row-what">${escapeHtml(row.what)}</text></a>`,
    );
  });
  for (const head of heads) parts.push(`<text x="${RX}" y="${head.y}" class="g-name">${escapeHtml(head.name)}</text>`);
  parts.push(
    `<rect x="408" y="${hy - hubH / 2}" width="184" height="${hubH}" class="hub-box"/>` +
      hubLogo(500, hy - 56, 64) +
      `<text x="500" y="${hy + 30}" text-anchor="middle" class="hub-sub">取得・整形・中継</text>` +
      `<text x="500" y="${hy + 48}" text-anchor="middle" class="hub-sub">VPS ＋ サブPC</text>`,
  );

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="AIDEとアプリのつながり">${markers(p)}${parts.join("")}</svg>`;
}

/** 行の右端に置く「読む」「書く」の札。色だけに頼らず語でも向きが分かるようにする。 */
function tags(right: number, y: number, dir: Direction): string {
  const out: string[] = [];
  let x = right;
  const put = (label: string, kind: "r" | "w") => {
    out.push(
      `<rect x="${x - 30}" y="${y - 9}" width="30" height="18" class="tag-${kind}"/>` +
        `<text x="${x - 15}" y="${y + 4}" text-anchor="middle" class="tag-${kind}t">${label}</text>`,
    );
    x -= 34;
  };
  if (dir !== "read") put("書く", "w");
  if (dir !== "write") put("読む", "r");
  return out.join("");
}

/** スマホ向け。上に使う側を2列で、中央にAIDE、下に繋ぐ先を縦に並べる。 */
export function renderNarrowMap(): string {
  const p = "mn-";
  const W = 360;
  const cw = 174;
  const ch = 50;
  const hubY = 240;
  const hubH = 76;
  const { rows, heads, end } = layoutRows(hubY + hubH + 30, 44, 22, 10);
  const H = end + 4;
  const TX = 14;
  const RX = 38;

  const parts: string[] = [];
  CALLERS.forEach((caller, i) => {
    const x = (i % 2) * (cw + 12);
    const y = Math.floor(i / 2) * (ch + 10);
    const tx = Math.round(110 + (i * 140) / Math.max(1, CALLERS.length - 1));
    parts.push(
      `<path d="M${x + cw / 2},${y + ch} C${x + cw / 2},212 ${tx},196 ${tx},${hubY - 2}" class="edge" marker-end="url(#${p}r)"/>`,
    );
    parts.push(
      `<a href="#from-${caller.id}"><rect x="${x}" y="${y}" width="${cw}" height="${ch}" class="n-box"/>` +
        `<text x="${x + 9}" y="${y + 20}" class="n-name" style="font-size:12.5px">${escapeHtml(caller.short ?? caller.name)}</text>` +
        `<text x="${x + 9}" y="${y + 38}" class="n-via">${caller.via}</text></a>`,
    );
  });
  const last = rows[rows.length - 1];
  if (last) {
    parts.push(`<path d="M90,${hubY + hubH / 2} H${TX} V${last.y + 20}" class="edge trunk"/>`);
  }
  for (const row of rows) {
    parts.push(edge(p, `M${TX},${row.y + 20} H${RX - 1}`, row.dir, " solid"));
    parts.push(
      `<a href="#to-${row.id}"><rect x="${RX}" y="${row.y}" width="${W - RX}" height="40" class="row-box"/>` +
        `<text x="${RX + 9}" y="${row.y + 17}" class="row-name" style="font-size:12.5px">${escapeHtml(row.name)}</text>` +
        tags(W - 6, row.y + 12, row.dir) +
        `<text x="${RX + 9}" y="${row.y + 33}" class="row-what" style="font-size:11px">${escapeHtml(row.what)}</text></a>`,
    );
  }
  for (const head of heads) parts.push(`<text x="${RX}" y="${head.y}" class="g-name">${escapeHtml(head.name)}</text>`);
  parts.push(
    `<rect x="90" y="${hubY}" width="180" height="${hubH}" class="hub-box"/>` +
      hubLogo(180, hubY + 9, 40) +
      `<text x="180" y="${hubY + 66}" text-anchor="middle" class="hub-sub">取得・整形・中継</text>`,
  );

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="AIDEとアプリのつながり">${markers(p)}${parts.join("")}</svg>`;
}

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

/** MCPの登録簿とHTTPの静的カタログを、連携図のチップと同じ説明の出典にする。 */
function featureCatalog(): Map<string, FeatureItem> {
  const catalog = new Map<string, FeatureItem>();
  for (const tool of buildToolRegistry().list()) catalog.set(tool.name, tool);
  for (const endpoint of ENDPOINTS) catalog.set(endpoint.name, endpoint);
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
<p class="lead">AIDEを中心に、どのアプリがどうつながっているかを示します。左（スマホでは上）がAIDEを使うアプリ、右（スマホでは下）がAIDEが読みに行く・書き込む先です。アプリを押すと、下の一覧の該当する行へ移ります。</p>
${LEGEND}${warning}
</section>
${options.sync ? syncResult(options.sync) : ""}
<section class="mapcard">
<div class="map-wide"><div class="maphead"><span>AIDEを使うアプリ</span><span>AIDEがつなぐ先</span></div>${renderWideMap()}</div>
<div class="map-narrow">${renderNarrowMap()}</div>
</section>
<div class="grid">
${options.sync ? foundCard(options.sync.result) : ""}
${callersCard(catalog, popovers, gone)}
${GROUPS.map((group) => groupCard(group, catalog, popovers, gone)).join("\n")}
</div>
${popovers.map(renderPopover).join("\n")}
${CENTER_TARGET_SCRIPT}
${BUSY_SCRIPT}`;

  return renderPage({
    title: "AIDE のアプリ連携",
    nav: siteNav("map"),
    headerAction: options.headerAction ?? "",
    body,
    footer: "細かなエンドポイントの一覧とworkerのジョブは「機能一覧」にあります。動作状況は ops-dashboard の「AIDE」タブで確認できます。",
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
