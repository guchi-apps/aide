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
 * リクエスト元の識別子。
 * Apache や cloudflared の背後では socket のアドレスがプロキシのものになるため、
 * 転送ヘッダの先頭を優先する。
 */
export function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0]! : forwarded).split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** ロック中なら解除までの秒数、そうでなければ null。 */
export function lockedFor(key: string): number | null {
  const bucket = buckets.get(key);
  if (!bucket) return null;
  const remaining = bucket.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : null;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  // 前回の失敗から時間が経っていれば数え直す。
  // 累積し続けると、正規利用者がたまに打ち間違えるだけでロックされる。
  if (!bucket || now - bucket.firstFailureAt > WINDOW_MS) {
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

export function allowRegistration(key: string): boolean {
  const now = Date.now();
  const recent = (registrations.get(key) ?? []).filter((at) => now - at < REGISTRATION_WINDOW_MS);
  if (recent.length >= MAX_REGISTRATIONS) {
    console.warn(`[auth] クライアント登録の回数超過: ${key}`);
    return false;
  }
  recent.push(now);
  registrations.set(key, recent);
  return true;
}

/** テスト用。 */
export function resetRateLimits(): void {
  buckets.clear();
  registrations.clear();
}
