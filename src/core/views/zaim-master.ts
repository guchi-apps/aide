import { readCache, writeCache } from "../cache/store.ts";
import type { ZaimOAuthCredentials } from "../connectors/zaim/oauth.ts";
import { fetchZaimMaster, type ZaimMaster } from "../connectors/zaim/write.ts";

/**
 * Zaimの口座・カテゴリ・ジャンルの対応表を、キャッシュを挟んで読む（aide#135）。
 *
 * `fetchZaimMaster()` は「連携先の設定時に一度だけ引く」前提で**キャッシュを持たない**。
 * 呼び出し元がアプリならそれで足りるが、**Claudeは状態を持たないので登録のたびに引く**ことになり、
 * 1回の登録でZaimのAPIを3本叩く。ここで挟んで、その分を落とす。
 *
 * **worker のジョブにはしない。** README「どこまでを『重い取得』とみなすか」でいうと、
 * これはPlaywright巡回ではなくOAuthのHTTP GET 3本で、「都度叩く」側に近い。ジョブにすると
 * 口座を新設した直後に次の同期まで候補へ出てこないが、read-through なら `refresh` で
 * その場で引き直せる。
 *
 * **キャッシュのキーは `POST /api/cache/:key` の許可キー（`src/api/ingest.ts` の `ALLOWED_KEYS`）へ
 * 足さない。** 書くのはこのサーバー自身だけで、受け口から上書きさせる理由が無い。ここを開けると、
 * 受け口のシークレットを持つ相手が「どのIDがどの口座か」を差し替えられることになる。
 */

export const ZAIM_MASTER_CACHE_KEY = "zaim-master";

/**
 * これを超えたら引き直す。**`src/core/views/money.ts` と同じ値**（Zaim由来のデータに対する
 * 既存の基準に揃えている）。口座の新設・カテゴリのカスタマイズは人が意識してやる操作で、
 * 月に1回あるかどうかなので、24時間で十分短い。
 */
export const STALE_AFTER_MINUTES = 60 * 24;

export interface ZaimMasterView extends ZaimMaster {
  /** 取得時刻（ISO8601）。 */
  fetchedAt: string;
  /** 取得からの経過分数。 */
  ageMinutes: number;
  /** 鮮度の基準（24時間）を超えているか。 */
  stale: boolean;
}

export type ReadZaimMasterOutcome =
  | { ok: true; master: ZaimMasterView }
  /**
   * Zaimから引けなかった。**キャッシュがあれば `master` に入れて返す**
   * （古くても候補が無いより役に立つ。古いことは `stale` で分かる）。
   */
  | { ok: false; reason: string; master: ZaimMasterView | null };

function toView(master: ZaimMaster, fetchedAt: string, ageMinutes: number): ZaimMasterView {
  return { ...master, fetchedAt, ageMinutes, stale: ageMinutes > STALE_AFTER_MINUTES };
}

export interface ReadZaimMasterOptions {
  /** キャッシュの鮮度によらずZaimへ引きに行く。指定したIDがマスタに無かったときの逃げ道。 */
  refresh?: boolean | undefined;
  /** テスト用の差し替え。既定では本物のZaimを叩く。 */
  fetch?: typeof fetchZaimMaster | undefined;
}

/**
 * キャッシュが新しければそれを返し、古い（または `refresh`）ならZaimへ引きに行く。
 *
 * 引き直しに失敗しても、掴んでいるキャッシュは捨てずに返す。ここで空にすると、
 * Zaimが一時的に落ちているだけで登録先の候補が何も出せなくなる。
 */
export async function readZaimMaster(
  credentials: ZaimOAuthCredentials,
  options: ReadZaimMasterOptions = {},
): Promise<ReadZaimMasterOutcome> {
  const fetcher = options.fetch ?? fetchZaimMaster;

  let cached: Awaited<ReturnType<typeof readCache<ZaimMaster>>> = null;
  try {
    cached = await readCache<ZaimMaster>(ZAIM_MASTER_CACHE_KEY);
  } catch {
    // 壊れたキャッシュは無いものとして扱う。ここで例外にすると登録そのものが通らなくなる。
    console.warn("[zaim] マスタのキャッシュが読めないため、取得し直します");
  }

  if (cached && !options.refresh && cached.ageMinutes <= STALE_AFTER_MINUTES) {
    return { ok: true, master: toView(cached.data, cached.fetchedAt, cached.ageMinutes) };
  }

  const fetched = await fetcher(credentials);
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      master: cached ? toView(cached.data, cached.fetchedAt, cached.ageMinutes) : null,
    };
  }

  const fetchedAt = new Date().toISOString();
  try {
    await writeCache(ZAIM_MASTER_CACHE_KEY, "zaim", fetched.master);
  } catch (cause) {
    // 書けなくても取得はできている。次回また引き直すだけなので、登録は止めない。
    console.warn("[zaim] マスタのキャッシュを書けませんでした", cause);
  }
  return { ok: true, master: toView(fetched.master, fetchedAt, 0) };
}
