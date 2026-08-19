import { createHmac, randomBytes } from "node:crypto";

/**
 * Zaim APIの OAuth 1.0a 署名。
 *
 * **巡回（`scrape.ts`）とはまったく別の経路。** 巡回はブラウザのログイン状態（storage state）で
 * 画面を読むが、こちらは公式APIを叩く。資格情報も別で、書き込み用のOAuthトークンは
 * 取得側の storage state とは共有しない（README「書き込みをどこまで持つか」の2番目の条件）。
 *
 * OAuth 1.0a は署名のためだけに使う。Zaimは OAuth 2.0 を提供しておらず、これ以外の選択肢が無い。
 * 署名は HMAC-SHA1 で、`node:crypto` だけで書けるため**依存関係は増やさない**。
 *
 * 3-legged のトークン取得（request token → 認可 → access token）はブラウザでの認可が要るため
 * ここには持たず、`scripts/oauth-token.mjs` が1回だけ行う。実行時はアクセストークンを
 * 環境変数から読むだけにしている。
 */

const SIGNATURE_METHOD = "HMAC-SHA1";
const OAUTH_VERSION = "1.0";

/** Zaim APIの基点。 */
export const ZAIM_API_ROOT = "https://api.zaim.net/v2";

/**
 * 制限時間。
 *
 * 登録は同期リクエストの中で叩くため、Zaimが遅いときに呼び出し元（car-care等）の画面が
 * 固まらないよう切る。**ただし切ったからといって登録されなかったとは限らない**ため、
 * 打ち切りは「結果不明」として扱う（`idempotency.ts`）。
 */
export const ZAIM_TIMEOUT_MS = 10_000;

export interface ZaimOAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** 署名の再現性が要るテストのために、乱数と時刻を差し替えられるようにしている。 */
export interface OAuthNonceOptions {
  nonce?: string | undefined;
  /** UNIX時刻（秒）。 */
  timestamp?: number | undefined;
}

/**
 * RFC 3986 のパーセントエンコード。
 *
 * `encodeURIComponent` は `!`・`'`・`(`・`)`・`*` を素通しするが、OAuth 1.0a は
 * 非予約文字（英数字と `-._~`）以外をすべてエンコードすることを求める。
 * ここがずれると署名だけが合わず、Zaim側は 401 を返すだけなので原因を追いにくい。
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 署名対象のパラメータを1本の文字列へ畳む。
 *
 * エンコードしてからキー・値の順で並べ替える（エンコード前で並べ替えると、
 * `%` を含む値の順序がZaim側の解釈とずれる）。
 */
export function normalizeParams(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) => (keyA === keyB ? (valueA < valueB ? -1 : 1) : keyA < keyB ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * 署名対象の文字列。
 *
 * `url` にクエリを含めてはいけない。クエリのパラメータも署名の対象なので、
 * 呼び出し側が `params` へ入れて渡す。
 */
export function signatureBaseString(
  method: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  return [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(normalizeParams(params)),
  ].join("&");
}

/** 署名鍵は「consumer secret & token secret」。トークンが無い段階でも `&` は省けない。 */
export function signingKey(consumerSecret: string, tokenSecret: string): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

export function sign(baseString: string, consumerSecret: string, tokenSecret: string): string {
  return createHmac("sha1", signingKey(consumerSecret, tokenSecret)).update(baseString).digest("base64");
}

/**
 * `Authorization: OAuth ...` ヘッダーを組み立てる。
 *
 * 署名にはリクエストのパラメータ（クエリ・フォーム本文）も含めるが、
 * **ヘッダーへ載せるのは `oauth_*` だけ**。両方載せるとZaim側で二重に数えられて署名が合わない。
 */
export function authorizationHeader(
  credentials: ZaimOAuthCredentials,
  method: string,
  url: string,
  params: Readonly<Record<string, string>>,
  options: OAuthNonceOptions = {},
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: OAUTH_VERSION,
  };

  const signature = sign(
    signatureBaseString(method, url, { ...params, ...oauthParams }),
    credentials.consumerSecret,
    credentials.accessTokenSecret,
  );

  return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

/**
 * 署名付きでZaim APIを叩く。`res.ok` でなければ Response 自体を投げる
 * （`write.ts` の失敗分類が status を見て判断する。GitHubコネクタと同じ作法）。
 *
 * GETはパラメータをクエリに、POSTはフォーム本文に載せる。どちらも署名の対象に含める。
 */
export async function zaimRequest(
  credentials: ZaimOAuthCredentials,
  method: "GET" | "POST",
  path: string,
  params: Readonly<Record<string, string>> = {},
  options: OAuthNonceOptions = {},
): Promise<unknown> {
  const url = `${ZAIM_API_ROOT}${path}`;
  const header = authorizationHeader(credentials, method, url, params, options);
  const query = normalizeParams(params);

  const res = await fetch(method === "GET" && query ? `${url}?${query}` : url, {
    method,
    headers: {
      authorization: header,
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { body: query } : {}),
    signal: AbortSignal.timeout(ZAIM_TIMEOUT_MS),
  });
  if (!res.ok) throw res;
  return await res.json();
}

/**
 * 環境変数から資格情報を読む。**4つそろって初めて有効**にする。
 *
 * 半端に設定された状態で叩くと、Zaimは 401 を返すだけで何が欠けているのか分からない。
 * 1つでも欠けていれば「未設定」として扱い、口そのものを開けない（`src/api/zaim.ts` が503を返す）。
 */
export function loadZaimOAuthCredentials(): ZaimOAuthCredentials | null {
  const consumerKey = process.env["AIDE_ZAIM_CONSUMER_KEY"] || "";
  const consumerSecret = process.env["AIDE_ZAIM_CONSUMER_SECRET"] || "";
  const accessToken = process.env["AIDE_ZAIM_ACCESS_TOKEN"] || "";
  const accessTokenSecret = process.env["AIDE_ZAIM_ACCESS_TOKEN_SECRET"] || "";
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) return null;
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}
