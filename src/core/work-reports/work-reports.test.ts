import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkReportStore } from "./store.ts";
import { LIMITS, STALE_AFTER_MS } from "./types.ts";
import { checkLink, parseWorkReport } from "./validate.ts";

const NOW = new Date("2026-10-10T03:00:00Z");

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workId: "work-1",
    eventId: "e1",
    version: 1,
    status: "started",
    occurredAt: "2026-10-10T11:59:00+09:00",
    title: "テスト作業",
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const parsed = parseWorkReport(base(overrides), NOW);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.input;
}

async function freshStore(clock: () => Date = () => NOW) {
  const dir = await mkdtemp(join(tmpdir(), "aide-work-reports-"));
  const path = join(dir, "work-reports.json");
  return { path, store: createWorkReportStore(path, clock) };
}

describe("入力検証", () => {
  it("許可していない項目・不正な値を拒否する", () => {
    for (const bad of [
      { owner: "someone" },
      { email: "x@example.com" },
      { version: 0 },
      { version: 1.5 },
      { status: "done" },
      { workId: "a b" },
      { occurredAt: "2026-10-10 12:00" },
      { occurredAt: "2026-10-10T13:00:00+09:00" },
      { title: "a".repeat(LIMITS.title + 1) },
      { progress: "a\nb" },
      { waitReason: "待つ" },
      { resultSummary: "終わり" },
      { progress: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { progress: "Authorization: Bearer abcdefghijklmnop" },
      { links: "https://example.com/a" },
      { links: Array.from({ length: LIMITS.links + 1 }, (_, i) => `https://example.com/${i}`) },
    ]) {
      assert.equal(parseWorkReport(base(bad), NOW).ok, false, JSON.stringify(bad));
    }
  });

  it("リンクは安全な https のみ受け付ける", () => {
    assert.ok(checkLink("https://github.com/guchi-apps/aide/pull/1").ok);
    for (const bad of [
      "http://example.com/a",
      "https://user:pass@example.com/a",
      "https://example.com/a?token=abc",
      "https://example.com/a#frag",
      "https://localhost/a",
      "https://127.0.0.1/a",
      "https://printer.local/a",
      "javascript:alert(1)",
      `https://example.com/${"a".repeat(LIMITS.linkLength)}`,
    ]) {
      assert.equal(checkLink(bad).ok, false, bad);
    }
  });
});

describe("保存と順序規則", () => {
  it("開始→待機→完了を保存し、読み戻せる", async () => {
    const { store } = await freshStore();
    const a = await store.submit(input(), "client-a");
    assert.deepEqual([a.ok && a.result, a.ok && a.saved], ["applied", true]);
    const b = await store.submit(input({ eventId: "e2", version: 2, status: "waiting", waitReason: "承認待ち" }), "client-a");
    assert.ok(b.ok && b.result === "applied");
    const c = await store.submit(input({ eventId: "e3", version: 3, status: "completed", resultSummary: "完了した" }), "client-a");
    assert.ok(c.ok && c.saved);
    const list = await store.list();
    assert.equal(list.reportState, "reported");
    assert.equal(list.works.length, 1);
    const work = list.works[0]!;
    assert.deepEqual([work.workId, work.version, work.status, work.resultSummary, work.freshness], ["work-1", 3, "completed", "完了した", "final"]);
    assert.equal(work.title, "テスト作業");
    assert.equal(work.waitReason, null);
  });

  it("同じeventId・同じ内容の再送は重複として保存済みの状態を返す", async () => {
    const { store } = await freshStore();
    await store.submit(input(), "c");
    const again = await store.submit(input(), "c");
    assert.ok(again.ok && again.result === "duplicate" && again.saved);
    assert.equal((await store.list()).total, 1);
  });

  it("同じeventIdで内容が違えば競合", async () => {
    const { store } = await freshStore();
    await store.submit(input(), "c");
    const conflict = await store.submit(input({ title: "別の名前" }), "c");
    assert.ok(!conflict.ok && conflict.kind === "conflict");
  });

  it("同一版で別eventIdなら競合", async () => {
    const { store } = await freshStore();
    await store.submit(input(), "c");
    const conflict = await store.submit(input({ eventId: "other" }), "c");
    assert.ok(!conflict.ok && conflict.kind === "conflict");
  });

  it("古い版は適用せず、最新状態を巻き戻さない", async () => {
    const { store } = await freshStore();
    await store.submit(input(), "c");
    await store.submit(input({ eventId: "e3", version: 3, status: "running", progress: "半分" }), "c");
    const stale = await store.submit(input({ eventId: "e2", version: 2, status: "waiting" }), "c");
    assert.ok(stale.ok && stale.result === "stale" && stale.saved === false);
    const work = (await store.list()).works[0]!;
    assert.deepEqual([work.version, work.status, work.progress], [3, "running", "半分"]);
  });

  it("終了後の報告・途中でのstartedを拒否し、最初の報告にはtitleが要る", async () => {
    const { store } = await freshStore();
    const noTitle = await store.submit(input({ title: undefined }), "c");
    assert.ok(!noTitle.ok && noTitle.kind === "invalid_transition");
    await store.submit(input(), "c");
    const restart = await store.submit(input({ eventId: "e2", version: 2, status: "started" }), "c");
    assert.ok(!restart.ok);
    await store.submit(input({ eventId: "e3", version: 3, status: "failed", resultSummary: "失敗" }), "c");
    const after = await store.submit(input({ eventId: "e4", version: 4, status: "running" }), "c");
    assert.ok(!after.ok && after.kind === "invalid_transition");
    assert.equal((await store.list()).works[0]!.status, "failed");
  });

  it("再起動（別インスタンス）後も状態が残り、二重登録されない", async () => {
    const { store, path } = await freshStore();
    await store.submit(input(), "c");
    await store.submit(input({ eventId: "e2", version: 2, status: "running" }), "c");
    const restarted = createWorkReportStore(path, () => NOW);
    const dup = await restarted.submit(input({ eventId: "e2", version: 2, status: "running" }), "c");
    assert.ok(dup.ok && dup.result === "duplicate");
    const list = await restarted.list();
    assert.deepEqual([list.total, list.works[0]!.version], [1, 2]);
  });

  it("同時に届いた同じ報告は1件だけ適用される", async () => {
    const { store } = await freshStore();
    const results = await Promise.all([store.submit(input(), "c"), store.submit(input(), "c")]);
    assert.deepEqual(results.map((r) => r.ok && r.result).sort(), ["applied", "duplicate"]);
  });

  it("壊れた保存ファイルは上書きせず、読み書きとも失敗する", async () => {
    const { store, path } = await freshStore();
    await writeFile(path, "{broken", "utf8");
    await assert.rejects(store.list());
    await assert.rejects(store.submit(input(), "c"));
    assert.equal(await readFile(path, "utf8"), "{broken");
  });

  it("無報告・更新途絶・空を区別できる", async () => {
    let now = NOW;
    const { store } = await freshStore(() => now);
    assert.equal((await store.list()).reportState, "none");
    await store.submit(input(), "c");
    assert.equal((await store.list()).works[0]!.freshness, "fresh");
    now = new Date(NOW.getTime() + STALE_AFTER_MS + 1000);
    const later = await store.list();
    assert.deepEqual([later.works[0]!.freshness, later.works[0]!.status, later.staleCount], ["stale", "started", 1]);
  });

  it("保持期間を過ぎた作業は捨て、一覧は上限で切る", async () => {
    let now = NOW;
    const { store } = await freshStore(() => now);
    await store.submit(input({ workId: "old", eventId: "o1" }), "c");
    now = new Date(NOW.getTime() + (LIMITS.retentionDays + 1) * 86_400_000);
    for (let i = 0; i < 3; i++) await store.submit(input({ workId: `w${i}`, eventId: `e${i}` }), "c");
    const list = await store.list({ limit: 2 });
    assert.deepEqual([list.total, list.works.length], [3, 2]);
    assert.ok(!list.works.some((w) => w.workId === "old"));
    assert.equal((await store.list({ limit: 9999 })).limit, LIMITS.listMax);
  });
});
