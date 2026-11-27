import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createHomeProfileStore, validateHomeProfile } from "../core/home-profile/store.ts";
import {
  formToInput,
  handleHomeSettingsSave,
  profileToForm,
  renderHomeSettingsPage,
} from "./home-settings.ts";
import type { LoginOptions } from "./login.ts";

const OPTIONS = { authConfig: { enabled: false }, supabase: null, baseUrl: "https://aide.example" } as LoginOptions;

async function post(body: Record<string, string>, headers: Record<string, string>, loggedIn = true) {
  const store = createHomeProfileStore(join(await mkdtemp(join(tmpdir(), "aide-home-")), "home-profile.json"));
  const req = Object.assign(Readable.from([Buffer.from(new URLSearchParams(body).toString())]), {
    headers,
  }) as unknown as IncomingMessage;
  const sent = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, h: Record<string, string>) {
      sent.status = status;
      sent.headers = h;
      return this;
    },
    end(text = "") {
      sent.body = text;
    },
  } as unknown as ServerResponse;
  await handleHomeSettingsSave(req, res, OPTIONS, {
    store: () => store,
    currentSession: async () => (loggedIn ? { email: null, sub: null } : null) as never,
  });
  return { sent, saved: await store.read() };
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const FORM = {
  version: "0",
  city: "テスト市",
  route_0_to: "テスト駅",
  route_0_mode: "WALK",
  route_0_typical: "１２",
};

test("入力した区間を保存して303で戻す", async () => {
  const { sent, saved } = await post(FORM, SAME_ORIGIN);
  assert.equal(sent.status, 303);
  assert.equal(sent.headers["Location"], "/settings/home?saved=1");
  assert.deepEqual(saved?.accessRoutes, [
    { to: "テスト駅", mode: "WALK", typicalMinutes: 12, bufferMinutes: null, priority: 1 },
  ]);
  assert.equal(saved?.coordinates, null);
});

test("未ログインと別オリジンのPOSTは保存しない", async () => {
  for (const [headers, loggedIn] of [
    [SAME_ORIGIN, false],
    [{ "sec-fetch-site": "same-site" }, true],
    [{ origin: "https://other.example" }, true],
    [{}, true],
  ] as const) {
    const { saved } = await post(FORM, headers, loggedIn);
    assert.equal(saved, null);
  }
  assert.equal((await post(FORM, { origin: "https://aide.example" })).sent.status, 303);
});

test("入力の誤りは保存せず、入力した値を残して出し直す", async () => {
  const { sent, saved } = await post({ ...FORM, latitude: "35" }, SAME_ORIGIN);
  assert.equal(sent.status, 400);
  assert.equal(saved, null);
  assert.match(sent.body, /value="テスト駅"/);
  assert.match(sent.body, /座標は/);
});

test("保存した値はフォームを往復しても変わらない", () => {
  const first = validateHomeProfile({
    label: "実家",
    area: { prefecture: "テスト県", city: "テスト市" },
    coordinates: { latitude: 1.5, longitude: -2 },
    accessRoutes: [{ to: "テスト駅", mode: "CAR", typicalMinutes: 5, bufferMinutes: 0, priority: 2 }],
    departurePreferences: { defaultBufferMinutes: 0 },
  });
  assert.ok(first.ok);
  const form = profileToForm({ ...first.input, updatedAt: "2026-11-27T00:00:00.000Z", version: 3 });
  assert.deepEqual(validateHomeProfile(formToInput(form)), first);
});

test("未設定の画面は呼び名のほかに初期値を持たない", () => {
  const page = renderHomeSettingsPage({ form: profileToForm(null) });
  const filled = [...page.matchAll(/<input type="text"[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(filled, ["label"]);
  assert.ok(!page.includes(" selected>CAR") && !/value="[A-Z_]+" selected/.test(page));
});
