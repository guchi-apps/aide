import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeProfile, HomeProfileStore } from "../../core/home-profile/store.ts";
import type { ScheduleSummary } from "../../core/views/schedule.ts";
import { createHomeProfileTool, homeProfileTool, type ScheduleReader } from "./home-profile.ts";

// すべて架空の値。
const PROFILE: HomeProfile = {
  label: "自宅",
  area: { prefecture: "テスト県", city: "テスト市", town: "テスト町", postalCode: "000-0000" },
  exactAddress: "テスト町1-2-3",
  coordinates: { latitude: 12.345678, longitude: 98.765432 },
  accessRoutes: [{ to: "テスト駅", mode: "WALK", typicalMinutes: 12, bufferMinutes: 3, priority: 1 }],
  departurePreferences: { defaultBufferMinutes: 10, stationArrivalBufferMinutes: 5, rainExtraMinutes: 5 },
  updatedAt: "2026-11-27T00:00:00.000Z",
  version: 1,
};

function store(read: () => Promise<HomeProfile | null>): () => HomeProfileStore {
  return () => ({ read, save: () => Promise.reject(new Error("読み取りツールは書き込まない")) });
}

function schedule(...days: { date: string; origins: [string | null, string][] }[]): ScheduleReader {
  return async () =>
    ({
      configured: true,
      days: days.map((day) => ({
        date: day.date,
        travels: day.origins.map(([origin, startTime]) => ({ origin, startTime })),
      })),
    }) as unknown as ScheduleSummary;
}

async function call(profile: HomeProfile | null, scopes: string[] = ["home:read"], reader = schedule({ date: "2026-11-28", origins: [] })) {
  const tool = createHomeProfileTool(store(async () => profile), () => new Date("2026-11-27T12:00:00Z"), reader);
  const response = await tool.handler({}, { sessionId: null, scopes });
  const text = response.content[0]!.text;
  return { response, text, body: JSON.parse(text) };
}

test("home:read を要求する", () => {
  assert.deepEqual(homeProfileTool.requiredScopes, ["home:read"]);
});

test("登録済みのプロフィールを updatedAt とともに返す", async () => {
  const { body } = await call(PROFILE);
  assert.equal(body.configured, true);
  assert.equal(body.complete, true);
  assert.deepEqual(body.problems, []);
  assert.equal(body.updatedAt, PROFILE.updatedAt);
  assert.equal(body.checkedAt, "2026-11-27T12:00:00.000Z");
  assert.deepEqual(body.profile.accessRoutes, PROFILE.accessRoutes);
  assert.deepEqual(body.profile.area, PROFILE.area);
});

test("未設定は configured: false で、推測した値を返さない", async () => {
  const { body } = await call(null);
  assert.equal(body.configured, false);
  assert.equal(body.profile, null);
  assert.equal(body.updatedAt, null);
});

test("location:read が無い接続には座標と正確な住所を返さない", async () => {
  const { body, text } = await call(PROFILE);
  assert.ok(!("exactAddress" in body.profile));
  assert.ok(!("coordinates" in body.profile));
  assert.ok(!text.includes("1-2-3") && !text.includes("12.345678"));
});

test("location:read がある接続には座標と正確な住所を返す", async () => {
  const { body } = await call(PROFILE, ["home:read", "location:read"]);
  assert.equal(body.profile.exactAddress, PROFILE.exactAddress);
  assert.deepEqual(body.profile.coordinates, PROFILE.coordinates);
});

test("各日の最初の移動の出発地が区間と一致しないと problems に出る", async () => {
  const { body } = await call(
    PROFILE,
    ["home:read"],
    schedule(
      // 2件目の出発地は見ない。
      { date: "2026-11-28", origins: [["別の駅", "12:00"], ["テスト", "08:00"]] },
      { date: "2026-11-29", origins: [["別の駅", "09:00"]] },
      { date: "2026-11-30", origins: [[null, "09:00"]] },
      { date: "2026-12-01", origins: [["テスト駅", "09:00"], ["別の駅", "18:00"]] },
      { date: "2026-12-02", origins: [["自宅", "09:00"]] },
    ),
  );
  assert.equal(body.problems.length, 3);
  assert.match(body.problems[0], /2026-11-28.*「テスト」.*表記が違う/);
  assert.match(body.problems[1], /2026-11-29.*「別の駅」/);
  assert.match(body.problems[2], /2026-11-30.*出発地/);
});

test("移動を取得できないときは照合していないと伝え、プロフィールは返す", async () => {
  const { body } = await call(PROFILE, ["home:read"], async () => {
    throw new Error("down");
  });
  assert.equal(body.configured, true);
  assert.match(body.problems[0], /照合はしていません/);
});

test("登録の不足は complete: false と problems で分かる", async () => {
  const { body } = await call({ ...PROFILE, accessRoutes: [] });
  assert.equal(body.complete, false);
  assert.match(body.problems[0], /accessRoutes/);
});

test("読めないときは未設定とせずエラーで返し、中身を含めない", async () => {
  const tool = createHomeProfileTool(store(async () => {
    throw new Error("テスト町1-2-3");
  }));
  const response = await tool.handler({}, { sessionId: null, scopes: ["home:read"] });
  assert.equal(response.isError, true);
  assert.ok(!response.content[0]!.text.includes("1-2-3"));
});
