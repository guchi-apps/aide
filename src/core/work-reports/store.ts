import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "../paths.ts";
import {
  LIMITS,
  STALE_AFTER_MS,
  isTerminal,
  type FileShape,
  type PublicWork,
  type SubmitOutcome,
  type WorkListing,
  type WorkRecord,
  type WorkReportInput,
} from "./types.ts";

/**
 * 作業報告の保存と読み出し（#609）。
 *
 * **`core/record-file.ts` は使わない。** あちらは「読めなければ空として扱い、次の書込みで上書きする」
 * 設計で、消えても再登録が起きるだけの冪等記録向け。作業報告は正本なので、壊れたファイルは
 * 上書きせず、読み書きとも失敗させる（人が `data/work-reports.json` を調べて直す）。
 *
 * 書込みは1プロセス内で直列化し、一時ファイルへ書いて `rename` するため、書き込み中に落ちても
 * 前の内容が残る。**`saved: true` を返すのは `rename` が終わった後だけ**で、受け付けただけの
 * 状態を保存成功として返さない。
 */

export const WORK_REPORTS_PATH = process.env["AIDE_WORK_REPORTS_PATH"]
  ? resolve(process.env["AIDE_WORK_REPORTS_PATH"])
  : resolve(DATA_DIR, "work-reports.json");

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ファイルの中身を検査する。**形が合わなければ例外**（空として扱わない）。 */
function parseFile(raw: string): FileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("作業報告の保存ファイルが壊れています（JSONとして読めません）。上書きせず停止します");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["works"])) {
    throw new Error("作業報告の保存ファイルの形式が不正です。上書きせず停止します");
  }
  for (const work of parsed["works"] as unknown[]) {
    if (!isRecord(work) || typeof work["workId"] !== "string" || typeof work["version"] !== "number" || !Array.isArray(work["events"])) {
      throw new Error("作業報告の保存ファイルに不正な項目があります。上書きせず停止します");
    }
  }
  return parsed as unknown as FileShape;
}

async function readFileShape(path: string): Promise<FileShape> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { works: [] };
    throw cause;
  }
  return parseFile(raw);
}

async function writeFileShape(path: string, data: FileShape): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

/** 内容の指紋。同じeventIdの再送が「同じ内容」かを見分けるためだけに使う。 */
export function fingerprintOf(input: WorkReportInput): string {
  const canonical = JSON.stringify([
    input.workId,
    input.eventId,
    input.version,
    input.status,
    input.occurredAt,
    input.title ?? null,
    input.progress ?? null,
    input.waitReason ?? null,
    input.resultSummary ?? null,
    input.links,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function toPublic(work: WorkRecord, now: Date): PublicWork {
  const age = now.getTime() - Date.parse(work.receivedAt);
  return {
    workId: work.workId,
    version: work.version,
    status: work.status,
    title: work.title,
    progress: work.progress,
    waitReason: work.waitReason,
    resultSummary: work.resultSummary,
    links: work.links,
    occurredAt: work.occurredAt,
    receivedAt: work.receivedAt,
    reporter: work.reporter,
    freshness: isTerminal(work.status) ? "final" : age > STALE_AFTER_MS ? "stale" : "fresh",
  };
}

/** 保持期間と件数の上限を適用する。 */
function prune(data: FileShape, now: Date): void {
  const cutoff = now.getTime() - LIMITS.retentionDays * DAY_MS;
  data.works = data.works.filter((work) => Date.parse(work.receivedAt) >= cutoff);
  if (data.works.length > LIMITS.maxWorks) {
    // 古い更新から捨てる。終端状態のものを先に捨てる（進行中の作業を守る）。
    const order = [...data.works].sort((a, b) => {
      const finalDiff = Number(isTerminal(b.status)) - Number(isTerminal(a.status));
      return finalDiff !== 0 ? finalDiff : Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    });
    const drop = new Set(order.slice(0, data.works.length - LIMITS.maxWorks).map((work) => work.workId));
    data.works = data.works.filter((work) => !drop.has(work.workId));
  }
}

export interface WorkReportStore {
  submit(input: WorkReportInput, reporter: string): Promise<SubmitOutcome>;
  list(options?: { limit?: number; workId?: string }): Promise<WorkListing>;
}

export function createWorkReportStore(
  path: string = WORK_REPORTS_PATH,
  clock: () => Date = () => new Date(),
): WorkReportStore {
  /** 直列化のためのキュー。失敗しても後続を止めない。 */
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<R>(task: () => Promise<R>): Promise<R> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    submit(input, reporter) {
      return serialize(async () => {
        const now = clock();
        const data = await readFileShape(path);
        const fingerprint = fingerprintOf(input);
        const existing = data.works.find((work) => work.workId === input.workId);

        if (existing) {
          const sameEvent = existing.events.find((event) => event.eventId === input.eventId);
          if (sameEvent) {
            // 応答喪失後の再送。保存済みなので書き直さず、保存済みの状態を返す。
            if (sameEvent.fingerprint === fingerprint) {
              return { ok: true, result: "duplicate", saved: true, work: toPublic(existing, now) };
            }
            return {
              ok: false,
              kind: "conflict",
              reason: "同じ eventId で内容の違う報告が既にあります。新しい eventId と版で送り直してください",
              work: toPublic(existing, now),
            };
          }
          if (input.version === existing.version) {
            return {
              ok: false,
              kind: "conflict",
              reason: `版 ${input.version} は別の報告（eventId違い）で適用済みです。版を進めて送り直してください`,
              work: toPublic(existing, now),
            };
          }
          if (input.version < existing.version) {
            return {
              ok: true,
              result: "stale",
              saved: false,
              reason: `現在の版は ${existing.version} です。古い版の報告は適用しません（状態は巻き戻しません）`,
              work: toPublic(existing, now),
            };
          }
          if (isTerminal(existing.status)) {
            return {
              ok: false,
              kind: "invalid_transition",
              reason: `この作業は ${existing.status} で終了済みです。終了後の報告は受け付けません（新しい workId で報告してください）`,
              work: toPublic(existing, now),
            };
          }
          if (input.status === "started") {
            return {
              ok: false,
              kind: "invalid_transition",
              reason: "開始（started）は作業の最初の報告にだけ使えます",
              work: toPublic(existing, now),
            };
          }
        } else if (!input.title) {
          return { ok: false, kind: "invalid_transition", reason: "最初の報告には title が必要です", work: null };
        }

        const receivedAt = now.toISOString();
        const event = { eventId: input.eventId, version: input.version, fingerprint, receivedAt };
        const next: WorkRecord = {
          workId: input.workId,
          owner: "owner",
          reporter,
          version: input.version,
          status: input.status,
          title: input.title ?? existing!.title,
          progress: input.progress ?? null,
          waitReason: input.waitReason ?? null,
          resultSummary: input.resultSummary ?? null,
          links: input.links,
          occurredAt: input.occurredAt,
          receivedAt,
          createdAt: existing?.createdAt ?? receivedAt,
          lastEventId: input.eventId,
          events: [...(existing?.events ?? []), event].slice(-LIMITS.maxEventsPerWork),
        };
        data.works = [...data.works.filter((work) => work.workId !== input.workId), next];
        prune(data, now);
        await writeFileShape(path, data);
        return { ok: true, result: "applied", saved: true, work: toPublic(next, now) };
      });
    },

    list(options = {}) {
      return serialize(async () => {
        const now = clock();
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? LIMITS.listDefault), 1), LIMITS.listMax);
        const data = await readFileShape(path);
        const matching = options.workId ? data.works.filter((work) => work.workId === options.workId) : data.works;
        const sorted = [...matching].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
        const works = sorted.slice(0, limit).map((work) => toPublic(work, now));
        return {
          ok: true,
          reportState: data.works.length === 0 ? "none" : "reported",
          works,
          total: sorted.length,
          limit,
          staleCount: sorted.filter((work) => toPublic(work, now).freshness === "stale").length,
          staleAfterMinutes: STALE_AFTER_MS / 60_000,
          retention: { days: LIMITS.retentionDays, maxWorks: LIMITS.maxWorks },
          checkedAt: now.toISOString(),
        };
      });
    },
  };
}

let shared: WorkReportStore | null = null;
/** サーバー・MCPが共有する1つのstore。ファイルへの書込みを同じキューで直列化するため1つにする。 */
export function workReportStore(): WorkReportStore {
  shared ??= createWorkReportStore();
  return shared;
}
