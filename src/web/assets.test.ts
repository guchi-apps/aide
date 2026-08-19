import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { handleAsset, headTags, ICONS, manifest, mcpIcons, MANIFEST_PATH } from "./assets.ts";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
}

/** `writeHead` / `end` だけを記録する最小のスタブ。 */
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(body?: string | Buffer) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

async function get(path: string, method = "GET"): Promise<{ handled: boolean; captured: Captured }> {
  const { res, captured } = fakeRes();
  const handled = await handleAsset(method, path, res);
  return { handled, captured };
}

/** PNGのIHDRから幅・高さを読む。画像処理ライブラリを入れずにサイズを確かめるため。 */
function pngSize(body: Buffer): { width: number; height: number } {
  assert.equal(body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNGのシグネチャではない");
  assert.equal(body.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

describe("アイコン配信", () => {
  it("宣言したアイコンが実在し、宣言どおりの正方形になっている", async () => {
    for (const icon of ICONS) {
      const body = await readFile(new URL(`./icons/${icon.file}`, import.meta.url));
      const { width, height } = pngSize(body);
      assert.equal(width, icon.size, `${icon.file} の幅が宣言と違う`);
      assert.equal(height, icon.size, `${icon.file} の高さが宣言と違う`);
    }
  });

  it("アイコンのパスをGETするとPNGが返る", async () => {
    for (const icon of ICONS) {
      const { handled, captured } = await get(icon.path);
      assert.ok(handled, `${icon.path} が処理されていない`);
      assert.equal(captured.status, 200);
      assert.equal(captured.headers["Content-Type"], "image/png");
      assert.equal(pngSize(captured.body as Buffer).width, icon.size);
    }
  });

  it("/favicon.ico は <link> が無くても小さいアイコンを返す", async () => {
    const { handled, captured } = await get("/favicon.ico");
    assert.ok(handled);
    assert.equal(captured.headers["Content-Type"], "image/png");
    assert.equal(pngSize(captured.body as Buffer).width, 32);
  });

  it("HEAD では本体を返さないが Content-Length は返す", async () => {
    const { handled, captured } = await get("/icons/icon-192.png", "HEAD");
    assert.ok(handled);
    assert.equal(captured.body, undefined);
    assert.ok(Number(captured.headers["Content-Length"]) > 0);
  });

  it("担当外のパス・メソッドは処理せず、他のルートに渡す", async () => {
    assert.equal((await get("/mcp")).handled, false);
    assert.equal((await get("/icons/../server.ts")).handled, false);
    assert.equal((await get("/icons/icon-192.png", "POST")).handled, false);
  });
});

describe("PWAマニフェスト", () => {
  it("配信され、JSONとして読める", async () => {
    const { handled, captured } = await get(MANIFEST_PATH);
    assert.ok(handled);
    assert.equal(captured.status, 200);
    assert.match(captured.headers["Content-Type"] ?? "", /application\/manifest\+json/);
    assert.deepEqual(JSON.parse(String(captured.body)), manifest());
  });

  it("ホーム画面へ追加するのに要るサイズが載り、src はすべて配信対象になっている", () => {
    const parsed = manifest() as { icons: { src: string; sizes: string; purpose?: string }[] };
    const paths = new Set(ICONS.map((icon) => icon.path));
    for (const icon of parsed.icons) {
      assert.ok(paths.has(icon.src), `${icon.src} は配信されていない`);
    }
    for (const size of ["192x192", "512x512"]) {
      assert.ok(parsed.icons.some((icon) => icon.sizes === size), `${size} が載っていない`);
    }
    assert.ok(parsed.icons.some((icon) => icon.purpose === "maskable"), "maskable 版が載っていない");
  });
});

describe("head のタグ", () => {
  it("favicon・ホーム画面用アイコン・マニフェストを指す", () => {
    const html = headTags();
    assert.match(html, /rel="icon"[^>]*favicon-32\.png/);
    assert.match(html, /rel="apple-touch-icon"[^>]*apple-touch-icon\.png/);
    assert.ok(html.includes(`rel="manifest" href="${MANIFEST_PATH}"`));
  });

  it("マニフェストを外せる（PWAとして扱わない画面向け）", () => {
    const html = headTags({ manifest: false });
    assert.ok(!html.includes("rel=\"manifest\""));
    assert.match(html, /rel="icon"/);
  });
});

describe("MCPで名乗るアイコン", () => {
  it("配信しているパスを、渡された公開URLの絶対URLで返す", () => {
    const icons = mcpIcons("https://aide.example");
    assert.deepEqual(
      icons.map((icon) => icon.src),
      ICONS.map((icon) => `https://aide.example${icon.path}`),
    );
    for (const icon of icons) assert.equal(icon.mimeType, "image/png");
  });

  it("宣言したサイズがアイコンの定義と一致する", () => {
    assert.deepEqual(
      mcpIcons("https://aide.example").map((icon) => icon.sizes),
      ICONS.map((icon) => [`${icon.size}x${icon.size}`]),
    );
  });
});
