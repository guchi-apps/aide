import type { IncomingMessage, ServerResponse } from "node:http";
import { card, escapeHtml, renderPage, siteNav } from "./layout.ts";
import { accountAction, handleGatedPage, type LoginOptions } from "./login.ts";

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
      "aide_money_summary",
      "aide_utility_bills",
      "asset_manager_subscriptions",
      "asset_manager_create_subscription",
      "asset_manager_add_subscription_price",
      "aide_ops_status",
      "aide_room_status",
      "aide_room_buttons",
      "aide_room_press",
      "aide_daily_briefing",
      "aide_schedule",
      "aide_create_event",
      "aide_dev_status",
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
          "aide_money_summary",
          "aide_utility_bills",
          "aide_zaim_master",
          "aide_zaim_payment",
          "/api/zaim/payment/web",
        ],
      },
      {
        id: "subscription-lists",
        name: "subscription-lists",
        dir: "read",
        what: "月額固定費を読む",
        uses: ["aide_money_summary"],
      },
      {
        id: "asset-manager",
        name: "Asset Manager",
        dir: "both",
        what: "サブスクを読む／登録・料金追加／請求メールを取り込む",
        uses: [
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
        uses: ["aide_schedule", "aide_daily_briefing", "aide_create_event"],
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
        what: "部屋の室温・CO2・エアコン／照明などを操作",
        uses: ["aide_room_status", "aide_room_buttons", "aide_room_press"],
      },
      { id: "open-meteo", name: "Open-Meteo", dir: "read", what: "今日・明日の天気", uses: ["aide_daily_briefing"] },
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
        uses: ["aide_dev_status", "aide_create_issue"],
      },
      { id: "ops-dashboard", name: "ops-dashboard", dir: "read", what: "VPS・サブPCの稼働状況", uses: ["aide_ops_status"] },
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
      `<text x="500" y="${hy - 8}" text-anchor="middle" class="hub-name">AIDE</text>` +
      `<text x="500" y="${hy + 18}" text-anchor="middle" class="hub-sub">取得・整形・中継</text>` +
      `<text x="500" y="${hy + 36}" text-anchor="middle" class="hub-sub">VPS ＋ サブPC</text>`,
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
      `<text x="180" y="${hubY + 36}" text-anchor="middle" class="hub-name" style="font-size:22px">AIDE</text>` +
      `<text x="180" y="${hubY + 58}" text-anchor="middle" class="hub-sub">取得・整形・中継</text>`,
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

function chips(values: string[]): string {
  return values.length
    ? `<span class="chips">${values.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</span>`
    : "";
}

/** 使う側の機能。MCPは本数だけにする（ツール名を並べると、また文字の壁になる）。 */
function callerChips(caller: Caller): string {
  return caller.via === "MCP" ? chips([`MCPツール ${caller.uses.length}本`]) : chips(caller.uses);
}

function callersCard(): string {
  const items = CALLERS.map(
    (caller) =>
      `<li id="from-${caller.id}"><span class="nm">${escapeHtml(caller.name)}</span>` +
      `<span class="dir"><span class="b r">${caller.via}</span></span>` +
      `<span class="ds">${escapeHtml(caller.what)}</span>${callerChips(caller)}</li>`,
  ).join("");
  return card({ title: "AIDEを使うアプリ", meta: String(CALLERS.length), body: `<ul class="apps">${items}</ul>` });
}

function groupCard(group: DestinationGroup): string {
  const items = group.apps
    .map(
      (app) =>
        `<li id="to-${app.id}"><span class="nm">${escapeHtml(app.name)}</span>` +
        `<span class="dir">${badges(app.dir)}</span>` +
        `<span class="ds">${escapeHtml(app.what)}</span>${chips(app.uses)}</li>`,
    )
    .join("");
  return card({ title: group.name, meta: String(group.apps.length), body: `<ul class="apps">${items}</ul>` });
}

const LEGEND = `<ul class="legend">
<li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="26" y2="5" stroke="var(--accent)" stroke-width="1.6"/><path d="M24,0 L34,5 L24,10z" fill="var(--accent)"/></svg>AIDEへ流れる（読む・呼び出す）</li>
<li><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="26" y2="5" stroke="var(--wr)" stroke-width="1.6"/><path d="M24,0 L34,5 L24,10z" fill="var(--wr)"/></svg>AIDEから流れる（書く・送る）</li>
</ul>`;

export interface MapPageOptions {
  /** ヘッダー右端（ログイン中の表示・ログアウト）。 */
  headerAction?: string;
  /** 認証が無効な環境か。無効なら画面の先頭で警告する。 */
  authDisabled?: boolean;
}

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderMapPage(options: MapPageOptions = {}): string {
  const warning = options.authDisabled
    ? `<p class="notice">認証が無効です（AIDE_AUTH_DISABLED=1）。この画面もMCPも誰でも開けます。</p>`
    : "";
  const body = `<section class="hero">
<div class="hero-top"><h1>アプリ連携</h1></div>
<p class="lead">AIDEを中心に、どのアプリがどうつながっているかを示します。左（スマホでは上）がAIDEを使うアプリ、右（スマホでは下）がAIDEが読みに行く・書き込む先です。アプリを押すと、下の一覧の該当する行へ移ります。</p>
${LEGEND}${warning}
</section>
<section class="mapcard">
<div class="map-wide"><div class="maphead"><span>AIDEを使うアプリ</span><span>AIDEがつなぐ先</span></div>${renderWideMap()}</div>
<div class="map-narrow">${renderNarrowMap()}</div>
</section>
<div class="grid">
${callersCard()}
${GROUPS.map(groupCard).join("\n")}
</div>`;

  return renderPage({
    title: "AIDE のアプリ連携",
    nav: siteNav("map"),
    headerAction: options.headerAction ?? "",
    body,
    footer: "細かなエンドポイントの一覧とworkerのジョブは「機能一覧」にあります。動作状況は ops-dashboard の「AIDE」タブで確認できます。",
  });
}

export async function handleMapPage(req: IncomingMessage, res: ServerResponse, options: LoginOptions): Promise<void> {
  await handleGatedPage(req, res, options, "/map", (session) =>
    renderMapPage({
      headerAction: accountAction(session, options.authConfig.enabled),
      authDisabled: !options.authConfig.enabled,
    }),
  );
}
