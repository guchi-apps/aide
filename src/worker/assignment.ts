import { JOB_CATALOG, type JobName } from "./jobs/catalog.ts";

/**
 * worker ジョブの担当ホスト判定（#874）。
 *
 * サブPCと Mac mini のどちらでも同じタイマーを入れられるようにしつつ、同じジョブが2台で
 * 重複して動かない（Zaim のセッションを奪い合う・同じ通知が2回届く）ようにする。
 * 各ホストの `.env` の `AIDE_WORKER_JOBS` に、**そのホストが担当するジョブ名**をカンマ区切りで書く。
 *
 * - 未設定・空・`all`・`*`: 全ジョブを担当する（従来どおり。設定を入れていないホストの挙動を変えない）
 * - `none`: 何も担当しない（ジョブの付け替え中に一時的に使う）
 * - ジョブ名の列挙: 載っているジョブだけ担当する。載っていないジョブは何もせず成功で終わる
 */
export const WORKER_JOBS_ENV = "AIDE_WORKER_JOBS";

export type Assignment =
  | { kind: "all" }
  | { kind: "some"; jobs: ReadonlySet<string> };

/** 設定値を解釈する。ジョブ名の打ち間違いは黙って無効にせず例外にする（担当が消えて気づけなくなるため）。 */
export function parseAssignment(raw: string | undefined): Assignment {
  const value = (raw ?? "").trim();
  if (value === "" || value === "all" || value === "*") return { kind: "all" };
  if (value === "none") return { kind: "some", jobs: new Set() };

  const known = new Set<string>(JOB_CATALOG.map((job) => job.name));
  const jobs = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const unknown = jobs.filter((job) => !known.has(job));
  if (unknown.length > 0) {
    throw new Error(
      `${WORKER_JOBS_ENV} に未知のジョブ名があります: ${unknown.join(", ")}（有効: ${[...known].join(", ")}）`,
    );
  }
  return { kind: "some", jobs: new Set(jobs) };
}

export function isAssigned(assignment: Assignment, job: JobName): boolean {
  return assignment.kind === "all" || assignment.jobs.has(job);
}
