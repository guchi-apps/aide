import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { McpIcon } from "../mcp/types.ts";

/**
 * アイコンとPWAマニフェストの配信（`src/web/icons/`）。
 *
 * ブラウザのタブ・ホーム画面へ追加したときのアイコンを、AIDE自身が返せるようにする層。
 * 実行時依存を増やさない方針のため画像処理は行わず、**あらかじめ縮小して置いた PNG を
 * そのまま返すだけ**にしている。サイズを増やす場合も同じで、生成した PNG を
 * `src/web/icons/` へ置き、`ICONS` に足す（元画像は Issue #80 の添付）。
 *
 * 中身は公開してよい静的な画像とメタデータだけなので、認証は通さない。
 */

export interface IconAsset {
  /** 配信するパス。 */
  path: string;
  /** `src/web/icons/` 配下のファイル名。 */
  file: string;
  /** 正方形の一辺（px）。マニフェストの `sizes` にもテストにも使う。 */
  size: number;
}

/** 配信するアイコン。ここに足したものがマニフェストにも自動で載る。 */
export const ICONS: IconAsset[] = [
  { path: "/icons/icon-512.png", file: "icon-512.png", size: 512 },
  { path: "/icons/icon-192.png", file: "icon-192.png", size: 192 },
  { path: "/icons/apple-touch-icon.png", file: "apple-touch-icon.png", size: 180 },
  { path: "/icons/favicon-32.png", file: "favicon-32.png", size: 32 },
];

/** マニフェストの配信パス。 */
export const MANIFEST_PATH = "/manifest.webmanifest";

/** アイコンの背景（赤）に合わせた色。ブラウザのUIとPWAの起動画面に出る。 */
export const THEME_COLOR = "#c9514a";
const BACKGROUND_COLOR = "#b94944";

const ICON_DIR = new URL("./icons/", import.meta.url);

/** 読み込んだ画像の使い回し。数十KB×4枚で、毎回ディスクを読む必要がない。 */
const cache = new Map<string, Buffer>();

async function readIcon(file: string): Promise<Buffer> {
  const cached = cache.get(file);
  if (cached) return cached;
  const body = await readFile(new URL(file, ICON_DIR));
  cache.set(file, body);
  return body;
}

/**
 * PWAのマニフェスト。ホーム画面へ追加したときの名前とアイコンになる。
 *
 * `start_url` は機能一覧ページにしている。AIDEにはまだ人間が開く画面がここしか無く、
 * `/` は404を返すため。
 */
export function manifest(): unknown {
  const icons = ICONS.filter((icon) => icon.size >= 192).map((icon) => ({
    src: icon.path,
    sizes: `${icon.size}x${icon.size}`,
    type: "image/png",
  }));
  return {
    name: "AIDE",
    short_name: "AIDE",
    description: "生活情報まわりの共通バックエンド／ハブ。",
    start_url: "/features",
    scope: "/",
    display: "standalone",
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      ...icons,
      // 端末側で好きな形に切り抜いてよい版。ロボットが中央60%に収まっており、
      // 円形に切り抜かれても欠けない。
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/**
 * MCPの `initialize` で名乗るアイコン（仕様 2025-11-25 の `Implementation.icons`）。
 * ブラウザに出しているのと同じ画像を、Claudeアプリなどのクライアントにも出す。
 *
 * **同一オリジンの絶対URLで渡す。** クライアントはアイコンを資格情報なしで取りに行き、
 * サーバーと別オリジンのURLは拒否してよいことになっているため、相対パスでは足りない。
 * `baseUrl` は `AIDE_BASE_URL`（無ければリクエストのHost）から組み立てたもの。
 *
 * サイズを選ぶのはクライアントの仕事なので、配信しているものをそのまま並べる。
 */
export function mcpIcons(baseUrl: string): McpIcon[] {
  return ICONS.map((icon) => ({
    src: `${baseUrl}${icon.path}`,
    mimeType: "image/png",
    sizes: [`${icon.size}x${icon.size}`],
  }));
}

/**
 * HTMLの `<head>` に入れるアイコン関連のタグ。
 * 画面を増やしたらここを差し込む（機能一覧・認可画面で共有している）。
 */
export function headTags(options: { manifest: boolean } = { manifest: true }): string {
  return [
    `<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png">`,
    `<link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png">`,
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
    options.manifest ? `<link rel="manifest" href="${MANIFEST_PATH}">` : "",
    `<meta name="theme-color" content="${THEME_COLOR}">`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * アイコンとマニフェストのGET/HEADを処理する。担当外のパスなら false を返し、
 * 呼び出し元（`src/server.ts`）が他のルートを探せるようにする。
 */
export async function handleAsset(method: string | undefined, path: string, res: ServerResponse): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;

  if (path === MANIFEST_PATH) {
    res
      .writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" })
      .end(JSON.stringify(manifest(), null, 2));
    return true;
  }

  // ブラウザは <link> が無くても /favicon.ico を取りにくる。
  // ICOを別に持たず、同じPNGを返す（画像形式は Content-Type で伝わる）。
  const icon = ICONS.find((candidate) => candidate.path === path)
    ?? (path === "/favicon.ico" ? ICONS.find((candidate) => candidate.size === 32) : undefined);
  if (!icon) return false;

  const body = await readIcon(icon.file);
  res
    .writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=86400",
    })
    .end(method === "HEAD" ? undefined : body);
  return true;
}
