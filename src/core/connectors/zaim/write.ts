import { abandonPayment, beginPayment, completePayment } from "./idempotency.ts";
import { ZAIM_TIMEOUT_MS, zaimRequest, type ZaimOAuthCredentials } from "./oauth.ts";

/**
 * Zaimへの書き込み。**手入力レコード（支出）の新規登録だけ**を持つ（aide#37）。
 *
 * README「書き込みをどこまで持つか」の3条件に沿っている。
 *
 * 1. 他のどこからも塞がっている経路。Zaimへ書ける口は既存アプリ・公式MCP・Claude Code のどれにも無い
 * 2. 取得（Playwrightのstorage state）とは別の資格情報（OAuth 1.0a）を使う
 * 3. **作成だけ。** `PUT /v2/home/money/:id`・`DELETE /v2/home/money/:id` は持たない
 *
 * 3つ目は制約でもある。銀行・カード・スマートレシート由来の**自動連携レコードはAPIから
 * 見えず、編集もできない**（Zaim APIの仕様）。既存レコードの口座付け替え・集計対象外化が
 * 要る場合はここではなくブラウザ操作の検討になる（asset-manager#153 Phase 5）。
 *
 * カテゴリ・ジャンルの対応（「ガソリン代 → 自動車費/ガソリン」など）は**持たない**。
 * 呼び出し元が `categoryId` / `genreId` まで決めて渡す。AIDEにアプリ側のドメイン知識を
 * 持ち込むと、アプリが増えるたびにここが太る。IDは `fetchZaimMaster()` で引ける。
 */

/** 文字列項目の上限。Zaimは100文字を超えると受け付けない。 */
const MAX_TEXT_LENGTH = 100;

/** 冪等キーの上限。呼び出し元のレコードを指す文字列なので、これで十分足りる。 */
const MAX_REQUEST_ID_LENGTH = 200;

/** 金額の上限。桁を1つ間違えた登録を機械的に止めるための歯止め。 */
const MAX_AMOUNT = 100_000_000;

export interface ZaimPaymentInput {
  /** 呼び出し元がレコードごとに一意に決める冪等キー（例: `car-care:fuel-log:1234`）。 */
  requestId: string;
  amount: number;
  /** `YYYY-MM-DD`。 */
  date: string;
  categoryId: number;
  genreId: number;
  fromAccountId?: number | undefined;
  place?: string | undefined;
  name?: string | undefined;
  comment?: string | undefined;
}

export type CreatePaymentOutcome =
  | { ok: true; moneyId: number; duplicated: boolean }
  | {
      ok: false;
      /**
       * - `invalid` … 入力が不正。直して送り直せばよい
       * - `conflict` … 前回の結果が不明。**勝手に再送しない**（人がZaimを確認する）
       * - `rejected` … Zaimが内容を拒んだ。登録はされていない
       * - `failed` … Zaimへ届かない・打ち切り。登録されたかは不明
       */
      kind: "invalid" | "conflict" | "rejected" | "failed";
      reason: string;
    };

/** 文字列項目を整える。空文字は「指定なし」として落とす。 */
function normalizeText(value: unknown, label: string): { value?: string } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: `${label} は文字列で指定してください` };
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { error: `${label} が長すぎます（${MAX_TEXT_LENGTH}文字まで）` };
  }
  return { value: trimmed };
}

function normalizeId(value: unknown, label: string, required: boolean): { value?: number } | { error: string } {
  if (value === undefined || value === null) {
    return required ? { error: `${label} が必要です` } : {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { error: `${label} は正の整数で指定してください` };
  }
  return { value };
}

/**
 * 日付を検査する。
 *
 * 形だけでなく実在する日かまで見る。`2026-02-31` を素通しするとZaim側で丸められ、
 * 呼び出し元のレコードと違う日付で登録される。
 */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * 受け取ったJSONを検査して入力へ変換する。
 *
 * **ここを通ったものだけがZaimへ届く。** 金額や日付は後から直せない
 * （このコネクタは編集を持たない）ので、疑わしいものはZaimへ送る前に断る。
 */
export function normalizePaymentInput(raw: unknown): { input: ZaimPaymentInput } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSONオブジェクトを送ってください" };
  }
  const body = raw as Record<string, unknown>;

  const requestId = typeof body["requestId"] === "string" ? body["requestId"].trim() : "";
  if (!requestId) return { error: "requestId が必要です（呼び出し元のレコードごとに一意な文字列）" };
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { error: `requestId が長すぎます（${MAX_REQUEST_ID_LENGTH}文字まで）` };
  }
  // 制御文字はログにも記録にも入るため落とす。
  if (/[\u0000-\u001f\u007f]/.test(requestId)) return { error: "requestId に制御文字は使えません" };

  const amount = body["amount"];
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    return { error: "amount は1以上の整数で指定してください" };
  }
  if (amount > MAX_AMOUNT) return { error: `amount が大きすぎます（${MAX_AMOUNT}まで）` };

  const date = body["date"];
  if (typeof date !== "string" || !isValidDate(date)) {
    return { error: "date は YYYY-MM-DD 形式の実在する日付で指定してください" };
  }

  const categoryId = normalizeId(body["categoryId"], "categoryId", true);
  if ("error" in categoryId) return { error: categoryId.error };
  const genreId = normalizeId(body["genreId"], "genreId", true);
  if ("error" in genreId) return { error: genreId.error };
  const fromAccountId = normalizeId(body["fromAccountId"], "fromAccountId", false);
  if ("error" in fromAccountId) return { error: fromAccountId.error };

  const place = normalizeText(body["place"], "place");
  if ("error" in place) return { error: place.error };
  const name = normalizeText(body["name"], "name");
  if ("error" in name) return { error: name.error };
  const comment = normalizeText(body["comment"], "comment");
  if ("error" in comment) return { error: comment.error };

  return {
    input: {
      requestId,
      amount,
      date,
      categoryId: categoryId.value!,
      genreId: genreId.value!,
      ...(fromAccountId.value === undefined ? {} : { fromAccountId: fromAccountId.value }),
      ...(place.value === undefined ? {} : { place: place.value }),
      ...(name.value === undefined ? {} : { name: name.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    },
  };
}

/**
 * Zaimへ送るフォームパラメータ。
 *
 * `mapping=1` は「カテゴリ・ジャンルをIDで指定する」という意味で、Zaimが必須としている。
 * 省くと登録そのものが通らない。
 */
export function buildPaymentParams(input: ZaimPaymentInput): Record<string, string> {
  return {
    mapping: "1",
    category_id: String(input.categoryId),
    genre_id: String(input.genreId),
    amount: String(input.amount),
    date: input.date,
    ...(input.fromAccountId === undefined ? {} : { from_account_id: String(input.fromAccountId) }),
    ...(input.place === undefined ? {} : { place: input.place }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
}

/**
 * 失敗を「登録されていないと言い切れるか」で分ける。
 *
 * ここの判断が二重登録の分かれ目になる。Zaimが内容を拒んだ（4xx）なら登録されていないので
 * 記録を消して再送を許す。打ち切り・5xx は**登録された可能性が残る**ため記録を残し、
 * 次の再送を `conflict` で止める。
 */
export function classifyFailure(cause: unknown): { kind: "rejected" | "failed"; reason: string } {
  if (cause instanceof Response) {
    if (cause.status === 401 || cause.status === 403) {
      return { kind: "rejected", reason: `HTTP ${cause.status}（Zaimの認証情報が無効か、権限がありません）` };
    }
    if (cause.status === 429) return { kind: "failed", reason: "HTTP 429（Zaim側のレート制限）" };
    if (cause.status >= 400 && cause.status < 500) {
      return { kind: "rejected", reason: `HTTP ${cause.status}（Zaimが内容を受け付けませんでした）` };
    }
    return { kind: "failed", reason: `HTTP ${cause.status}（Zaim側の障害）` };
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") {
      return { kind: "failed", reason: `${ZAIM_TIMEOUT_MS}ms 以内に応答しませんでした` };
    }
    if (cause.name === "SyntaxError") return { kind: "failed", reason: "JSONとして読めない応答が返りました" };
    return { kind: "failed", reason: "Zaimへ接続できませんでした" };
  }
  return { kind: "failed", reason: "登録に失敗しました" };
}

/** 応答から `money_id` を取り出す。Zaimは `money.id` に入れて返す。 */
export function extractMoneyId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as { money?: { id?: unknown }; money_id?: unknown };
  const id = body.money?.id ?? body.money_id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

/**
 * 支出を1件登録する。
 *
 * 送る前に記録を置き、確定したら `money_id` を書き込む（`idempotency.ts`）。
 * 同じ `requestId` が再送されたときはZaimへ送らず、前回の `money_id` を返す。
 */
export async function createZaimPayment(
  credentials: ZaimOAuthCredentials,
  input: ZaimPaymentInput,
): Promise<CreatePaymentOutcome> {
  const begun = await beginPayment(input.requestId);
  if (begun.status === "done") {
    console.log(`[zaim] 登録済み: requestId=${input.requestId} moneyId=${begun.moneyId}`);
    return { ok: true, moneyId: begun.moneyId, duplicated: true };
  }
  if (begun.status === "unresolved") {
    return {
      ok: false,
      kind: "conflict",
      reason:
        `同じ requestId の登録を ${begun.at} に試みており、結果が確定していません。` +
        "Zaimを確認し、登録されていなければ別の requestId で送り直してください。",
    };
  }

  let payload: unknown;
  try {
    payload = await zaimRequest(credentials, "POST", "/home/money/payment", buildPaymentParams(input));
  } catch (cause) {
    const failure = classifyFailure(cause);
    // 拒まれた場合だけ記録を消す。打ち切り・障害では残し、次の再送を止める。
    if (failure.kind === "rejected") await abandonPayment(input.requestId);
    console.warn(`[zaim] 登録失敗: requestId=${input.requestId} ${failure.reason}`);
    return { ok: false, ...failure };
  }

  const moneyId = extractMoneyId(payload);
  if (moneyId === null) {
    // 200が返っている以上、登録されている可能性が高い。記録は消さない。
    console.warn(`[zaim] 登録は通ったが money_id を読めませんでした: requestId=${input.requestId}`);
    return { ok: false, kind: "failed", reason: "Zaimの応答から money_id を読めませんでした" };
  }

  await completePayment(input.requestId, moneyId);
  console.log(`[zaim] 登録: requestId=${input.requestId} moneyId=${moneyId}`);
  return { ok: true, moneyId, duplicated: false };
}

export interface ZaimMasterItem {
  id: number;
  name: string;
}

export interface ZaimMasterGenre extends ZaimMasterItem {
  categoryId: number;
}

export interface ZaimMaster {
  accounts: ZaimMasterItem[];
  categories: ZaimMasterItem[];
  genres: ZaimMasterGenre[];
}

/** `active: -1` は削除済み。呼び出し元が選べないものを渡しても混乱するだけなので落とす。 */
function isActive(row: Record<string, unknown>): boolean {
  return row["active"] !== -1;
}

function toItems(rows: unknown): Record<string, unknown>[] {
  return Array.isArray(rows) ? (rows.filter((row) => typeof row === "object" && row !== null) as Record<string, unknown>[]) : [];
}

/**
 * 口座・カテゴリ・ジャンルのIDを引く。
 *
 * 呼び出し元は `categoryId` / `genreId` / `fromAccountId` をIDで指定するため、
 * その対応表を引く口が要る。**キャッシュしない**——呼ぶのは連携先の設定時だけで、
 * 古い対応表を返すと存在しないIDで登録しようとして失敗するため。
 */
export async function fetchZaimMaster(credentials: ZaimOAuthCredentials): Promise<
  { ok: true; master: ZaimMaster } | { ok: false; reason: string }
> {
  try {
    const [accounts, categories, genres] = await Promise.all([
      zaimRequest(credentials, "GET", "/home/account"),
      zaimRequest(credentials, "GET", "/home/category"),
      zaimRequest(credentials, "GET", "/home/genre"),
    ]);

    return {
      ok: true,
      master: {
        accounts: toItems((accounts as { accounts?: unknown }).accounts)
          .filter(isActive)
          .map((row) => ({ id: Number(row["id"]), name: String(row["name"] ?? "") })),
        categories: toItems((categories as { categories?: unknown }).categories)
          .filter(isActive)
          .map((row) => ({ id: Number(row["id"]), name: String(row["name"] ?? "") })),
        genres: toItems((genres as { genres?: unknown }).genres)
          .filter(isActive)
          .map((row) => ({
            id: Number(row["id"]),
            name: String(row["name"] ?? ""),
            categoryId: Number(row["category_id"] ?? 0),
          })),
      },
    };
  } catch (cause) {
    return { ok: false, reason: classifyFailure(cause).reason };
  }
}
