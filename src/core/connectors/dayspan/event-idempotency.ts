/**
 * 予定作成（`aide_create_event`）の冪等化（#823）。
 *
 * DaySpan の `/api/internal/events` は `Idempotency-Key` に対応していない（tasks・travels だけが対応）ため、
 * 同じキーの再送を **AIDE 側で** 受け止める。キーと入力の指紋から、成功した結果（予定のIDとURL）を
 * メモリに一定時間だけ覚え、同じキー・同じ内容の再送には作り直さず同じ結果を返す。
 *
 * - **メモリのみ**（`data/` へは書かない）。AIDE の再起動を挟むと忘れる。想定は「タイムアウトで呼び直す」
 *   数分以内の再送で、再起動をまたぐ保証は持たない。
 * - 実行中に同じキーが来たら、同じ呼び出しの完了を待って同じ結果を返す（二重送信しない）。
 * - 失敗（`ok: false`）は覚えない。DaySpan が予定を作ったか不明な失敗でも、再送で作り直せるようにするため。
 *   これは「作られたか不明」のときに重複しうるという残りの穴で、確実に防ぐには DaySpan 側の対応が要る。
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

  /** `run` の結果が `ok: true` のときだけ覚える。 */
  async run<T extends { ok: boolean }>(
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
    };
    entry.promise = run().then(
      (outcome) => {
        entry.settled = true;
        if (!outcome.ok) this.#entries.delete(key);
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
    while (this.#entries.size >= MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

export const createEventIdempotency = new EventIdempotencyStore();
