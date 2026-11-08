/**
 * 予定作成（`aide_create_event`）の冪等化（#823）。
 *
 * DaySpan の `/api/internal/events` は `Idempotency-Key` に対応していない（tasks・travels だけが対応）ため、
 * 同じキーの再送を **AIDE 側で** 受け止める。キーと入力の指紋から、成功した結果（予定のIDとURL）を
 * メモリに一定時間だけ覚え、同じキー・同じ内容の再送には作り直さず同じ結果を返す。
 *
 * - **メモリのみ**（`data/` へは書かない）。AIDE の再起動を挟むと忘れる。想定は「タイムアウトで呼び直す」
 *   再送（保持は最長24時間）で、再起動をまたぐ保証は持たない。
 * - 実行中に同じキーが来たら、同じ呼び出しの完了を待って同じ結果を返す（二重送信しない）。
 * - 失敗は原則覚えない（先方が拒否した失敗は「作られていない」と確定するので、直して再送できてよい）。
 *   ただし **結果不明の失敗（`outcomeUnknown`。タイムアウト・通信断など）は覚えて保留する**（#833）。
 *   先方では作成済みかもしれず、同じキーの再送でPOSTし直すと予定が重複するため。同じキー・同じ内容の再送は
 *   POSTせず、保留した失敗をそのまま返す。呼び出し側は予定を照会して、作られていなければ新しいキーで作り直す。
 */

const KEY_PATTERN = /^[\x21-\x7e]{8,191}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

export function readEventIdempotencyKey(raw: unknown): { key?: string } | { error: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string" || !KEY_PATTERN.test(raw)) {
    return { error: "idempotencyKey は印字可能ASCIIの8〜191文字で指定してください（再送でも同じ値を使う）" };
  }
  return { key: raw };
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<unknown>;
  settled: boolean;
  /** 結果不明の失敗として保留しているか。 */
  unknown: boolean;
}

export type IdempotentResult<T> =
  | { replay: boolean; outcome: T }
  | { conflict: true };

export class EventIdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** `run` の結果が `ok: true` か、結果不明の失敗（`outcomeUnknown`）のときだけ覚える。 */
  async run<T extends { ok: boolean; outcomeUnknown?: boolean }>(
    key: string,
    fingerprint: string,
    run: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    this.#prune();
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { conflict: true };
      return { replay: true, outcome: (await existing.promise) as T };
    }

    const entry: Entry = {
      fingerprint,
      expiresAt: this.#now() + TTL_MS,
      promise: Promise.resolve(),
      settled: false,
      unknown: false,
    };
    entry.promise = run().then(
      (outcome) => {
        entry.settled = true;
        entry.unknown = !outcome.ok && outcome.outcomeUnknown === true;
        if (!outcome.ok && outcome.outcomeUnknown !== true) this.#entries.delete(key);
        return outcome;
      },
      (cause: unknown) => {
        this.#entries.delete(key);
        throw cause;
      },
    );
    this.#entries.set(key, entry);
    return { replay: false, outcome: (await entry.promise) as T };
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.settled && entry.expiresAt <= now) this.#entries.delete(key);
    }
    // 上限を超えたら、実行中のものは落とさず（同時再送が二重POSTになる）、結果不明の保留も後回しにして古い順に落とす。
    for (const keepUnknown of [false, true]) {
      for (const [key, entry] of this.#entries) {
        if (this.#entries.size < MAX_ENTRIES) return;
        if (!entry.settled || (!keepUnknown && entry.unknown)) continue;
        this.#entries.delete(key);
      }
    }
  }
}

export const createEventIdempotency = new EventIdempotencyStore();
