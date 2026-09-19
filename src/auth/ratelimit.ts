import type { IncomingMessage } from "node:http";

/**
 * 総当たり対策。
 *
 * 認可は単一のパスワードで、公開URL上のフォームとして晒される。
 * 回数制限が無いと、既知のエンドポイントに対して機械的に試行できてしまう。
 *
 * 状態はプロセス内メモリに置く。再起動で消えるが、
 * ディスクI/Oを試行のたびに発生させる方が攻撃者に有利な材料を与える
 * （書き込み負荷でサービスを劣化させられる）。
 */

interface Bucket {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** 失敗時の固定待ち。スクリプトによる高速試行の速度を落とす。 */
export const FAILURE_DELAY_MS = 700;

const buckets = new Map<string, Bucket>();

/**
 * 記録しておく送信元の上限。
 *
 * 失敗した送信元ごとに1件ずつ増えるため、上限が無いと大量の送信元から失敗を送るだけで
 * ヒープ（本番は `--max-old-space-size=96`）を食い潰せる。上限に達したら、まず期限切れを掃除し、
 * それでも空かなければ古いものから捨てる。
 */
const MAX_TRACKED_KEYS = 10_000;

/** 接続元がこのアドレスなら、手前のリバースプロキシ（Apache・cloudflared）経由とみなす。 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * リクエスト元の識別子。
 *
 * Apache や cloudflared の背後では socket のアドレスがプロキシのものになるため、
 * 転送ヘッダを使う。ただし採るのは**末尾**だけ。プロキシはクライアントが付けてきた
 * `X-Forwarded-For` を消さずに末尾へ実際の接続元を足すため、先頭はクライアントが自由に
 * 決められる。先頭を採ると、リクエストごとに値を変えるだけで回数制限を外せてしまう（#300）。
 *
 * 末尾が実際の接続元になるのは「プロキシが1段だけ」の構成に限る。前段にCDN等を足すと
 * 末尾がそのCDNのアドレスになり、全員が同じ送信元に数えられる。
 *
 * 接続元がループバックでない（プロキシを通らず直接届いた）ときはヘッダを信用しない。
 */
export function clientKey(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress;
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && remote && LOOPBACK_ADDRESSES.has(remote)) {
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded).split(",").at(-1)?.trim();
    if (last) return last;
  }
  return remote ?? "unknown";
}

/** ロック中なら解除までの秒数、そうでなければ null。 */
export function lockedFor(key: string): number | null {
  const bucket = buckets.get(key);
  if (!bucket) return null;
  const remaining = bucket.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : null;
}

/** 数え直しの期限もロックも過ぎた記録を消す。 */
function sweepBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.firstFailureAt > WINDOW_MS && bucket.lockedUntil <= now) buckets.delete(key);
  }
}

/** 新しい送信元を記録する前に、上限を超えないよう空きを作る。 */
function makeRoomFor<V>(map: Map<string, V>, sweep: (now: number) => void, now: number): void {
  if (map.size < MAX_TRACKED_KEYS) return;
  sweep(now);
  // Map は挿入順に列挙されるため、先頭が最も古い。
  for (const key of map.keys()) {
    if (map.size < MAX_TRACKED_KEYS) break;
    map.delete(key);
  }
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  // 前回の失敗から時間が経っていれば数え直す。
  // 累積し続けると、正規利用者がたまに打ち間違えるだけでロックされる。
  if (!bucket || now - bucket.firstFailureAt > WINDOW_MS) {
    if (!bucket) makeRoomFor(buckets, sweepBuckets, now);
    buckets.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }

  bucket.failures += 1;
  if (bucket.failures >= MAX_FAILURES) {
    bucket.lockedUntil = now + LOCKOUT_MS;
    bucket.failures = 0;
    bucket.firstFailureAt = now;
    console.warn(`[auth] 試行回数超過によりロックしました: ${key}`);
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/**
 * 動的クライアント登録の回数制限。
 *
 * RFC 7591 の登録エンドポイントは仕様上そもそも未認証で、公開すると誰でも叩ける。
 * 保存件数が無制限に増えると状態ファイルが膨らむため、送信元ごとに上限を設ける。
 */
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS = 20;
const registrations = new Map<string, number[]>();

function sweepRegistrations(now: number): void {
  for (const [key, times] of registrations) {
    if (times.every((at) => now - at >= REGISTRATION_WINDOW_MS)) registrations.delete(key);
  }
}

export function allowRegistration(key: string): boolean {
  const now = Date.now();
  const recent = (registrations.get(key) ?? []).filter((at) => now - at < REGISTRATION_WINDOW_MS);
  if (recent.length >= MAX_REGISTRATIONS) {
    console.warn(`[auth] クライアント登録の回数超過: ${key}`);
    return false;
  }
  recent.push(now);
  if (!registrations.has(key)) makeRoomFor(registrations, sweepRegistrations, now);
  registrations.set(key, recent);
  return true;
}

/** テスト用。記録している送信元の件数。 */
export function trackedKeyCount(): { failures: number; registrations: number } {
  return { failures: buckets.size, registrations: registrations.size };
}

/** テスト用。 */
export function resetRateLimits(): void {
  buckets.clear();
  registrations.clear();
}
