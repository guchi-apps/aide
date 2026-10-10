import { LIMITS, WORK_STATUSES, type WorkReportInput, type WorkStatus, isTerminal } from "./types.ts";

/**
 * 作業報告の入力検証。**許可した項目だけを受け付け**、それ以外はエラーにする（黙って捨てない）。
 * 会話・メールの原文や認証情報を保存しないため、文字列は短い1行に限り、秘密らしい値も弾く。
 */

export type Validation = { ok: true; input: WorkReportInput } | { ok: false; reason: string };

const ALLOWED_KEYS = new Set([
  "workId",
  "eventId",
  "version",
  "status",
  "occurredAt",
  "title",
  "progress",
  "waitReason",
  "resultSummary",
  "links",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** タイムゾーン付きのISO 8601のみ。曖昧な時刻（ローカル時刻）は順序の判断を狂わせる。 */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** 未来の発生時刻はこの範囲まで許す（時計のずれ）。 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** 認証情報らしい文字列。見つけたら保存せずに拒否する。 */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S{4,}/i,
  /\b[A-Fa-f0-9]{40,}\b/,
];

function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(
  value: unknown,
  name: string,
  max: number,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, reason: `${name} は文字列で指定してください` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (CONTROL.test(trimmed)) return { ok: false, reason: `${name} に改行・制御文字は使えません（短い1行で書く）` };
  if ([...trimmed].length > max) return { ok: false, reason: `${name} は${max}文字以内で指定してください` };
  if (looksSecret(trimmed)) return { ok: false, reason: `${name} に認証情報らしい文字列が含まれています。保存できません` };
  return { ok: true, value: trimmed };
}

function id(value: unknown, name: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || !value) return { ok: false, reason: `${name} は必須です` };
  if (value.length > LIMITS.idLength) return { ok: false, reason: `${name} は${LIMITS.idLength}文字以内で指定してください` };
  if (!ID_PATTERN.test(value)) return { ok: false, reason: `${name} は英数字と . _ : - だけで指定してください` };
  return { ok: true, value };
}

/**
 * リンクとして保存してよいURLか。**https のみ**で、ユーザー情報・クエリ・フラグメントは持てない
 * （署名付きURL・トークン入りURLを丸ごと対象外にする最も単純な線引き）。
 * localhost・IPアドレス直指定・内部向けのホスト名も受け付けない。
 */
export function checkLink(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "links の要素は空でない文字列にしてください" };
  const value = raw.trim();
  if (value.length > LIMITS.linkLength) return { ok: false, reason: `links のURLは${LIMITS.linkLength}文字以内にしてください` };
  if (CONTROL.test(value) || /\s/.test(value)) return { ok: false, reason: "links のURLに空白・制御文字は使えません" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "links のURLが不正です" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "links は https のURLだけ受け付けます" };
  if (url.username || url.password) return { ok: false, reason: "links にユーザー情報入りのURLは使えません" };
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    return { ok: false, reason: "links にクエリ・フラグメント付きのURLは使えません（秘密情報が載りうるため）" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || !host.includes(".") || /^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) {
    return { ok: false, reason: "links に内部向け・IP直指定のホストは使えません" };
  }
  if (/\.(local|internal|lan|home|localdomain)$/.test(host)) {
    return { ok: false, reason: "links に内部向けのホストは使えません" };
  }
  if (looksSecret(decodeURIComponent(url.pathname))) {
    return { ok: false, reason: "links に認証情報らしい文字列が含まれています" };
  }
  return { ok: true, value: url.toString() };
}

export function parseWorkReport(args: Record<string, unknown>, now: Date): Validation {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `許可されていない項目です: ${key}` };
  }

  const workId = id(args["workId"], "workId");
  if (!workId.ok) return workId;
  const eventId = id(args["eventId"], "eventId");
  if (!eventId.ok) return eventId;

  const version = args["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > LIMITS.maxVersion) {
    return { ok: false, reason: `version は1以上${LIMITS.maxVersion}以下の整数で指定してください` };
  }

  const status = args["status"];
  if (typeof status !== "string" || !(WORK_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: `status は ${WORK_STATUSES.join(" / ")} のいずれかで指定してください` };
  }

  const occurred = args["occurredAt"];
  if (typeof occurred !== "string" || !ISO_PATTERN.test(occurred) || Number.isNaN(Date.parse(occurred))) {
    return { ok: false, reason: "occurredAt はタイムゾーン付きのISO 8601（例 2026-10-10T09:00:00+09:00）で指定してください" };
  }
  const occurredMs = Date.parse(occurred);
  if (occurredMs > now.getTime() + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: "occurredAt が未来の時刻です" };
  }

  const title = text(args["title"], "title", LIMITS.title);
  if (!title.ok) return title;
  const progress = text(args["progress"], "progress", LIMITS.progress);
  if (!progress.ok) return progress;
  const waitReason = text(args["waitReason"], "waitReason", LIMITS.waitReason);
  if (!waitReason.ok) return waitReason;
  const resultSummary = text(args["resultSummary"], "resultSummary", LIMITS.resultSummary);
  if (!resultSummary.ok) return resultSummary;

  const typedStatus = status as WorkStatus;
  if (waitReason.value && typedStatus !== "waiting") {
    return { ok: false, reason: "waitReason は status が waiting のときだけ指定できます" };
  }
  if (resultSummary.value && !isTerminal(typedStatus)) {
    return { ok: false, reason: "resultSummary は完了・失敗・取消のときだけ指定できます" };
  }

  const rawLinks = args["links"];
  const links: string[] = [];
  if (rawLinks !== undefined && rawLinks !== null) {
    if (!Array.isArray(rawLinks)) return { ok: false, reason: "links は文字列の配列で指定してください" };
    if (rawLinks.length > LIMITS.links) return { ok: false, reason: `links は${LIMITS.links}件までです` };
    for (const raw of rawLinks) {
      const link = checkLink(raw);
      if (!link.ok) return link;
      if (!links.includes(link.value)) links.push(link.value);
    }
  }

  return {
    ok: true,
    input: {
      workId: workId.value,
      eventId: eventId.value,
      version,
      status: typedStatus,
      occurredAt: new Date(occurredMs).toISOString(),
      ...(title.value !== undefined ? { title: title.value } : {}),
      ...(progress.value !== undefined ? { progress: progress.value } : {}),
      ...(waitReason.value !== undefined ? { waitReason: waitReason.value } : {}),
      ...(resultSummary.value !== undefined ? { resultSummary: resultSummary.value } : {}),
      links,
    },
  };
}
