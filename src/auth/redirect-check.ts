import { callbackUrl, type SupabaseAuthConfig } from "./supabase.ts";

/**
 * `redirect_to` がSupabaseの Redirect URLs に登録済みかを確かめる（#114）。
 *
 * **なぜ要るか。** 登録が無い・一致しないとき、GoTrue はエラーを返さずプロジェクトの
 * Site URL へ静かにフォールバックする（#93）。ログインは「成功したのに別のアプリの画面が
 * 開く」という形で壊れ、devtoolsで302先を1文字ずつ見比べるまで原因が分からなかった。
 * 認証基盤は他アプリ（dayspan・shopping-list）と共用のため、AIDEが何も変えていなくても
 * 他アプリ側の変更で許可リストが書き換われば同じことが起きる。
 *
 * **どう確かめるか。** `GET /auth/v1/verify` に**成立しないトークン**を渡す。GoTrue は
 * `/auth/v1/authorize` とまったく同じ判定関数（`utilities.GetReferrer`）で戻り先を決めてから
 * エラーのリダイレクトを返すため、`Location` に「実際に採用された戻り先」がそのまま出る。
 * 許可されていれば渡したURL、されていなければ Site URL が返る＝#93 の症状を直接観測できる。
 *
 * **新しい資格情報を要求しない。** 許可リストの中身そのものは Supabase Management API でしか
 * 読めず、それにはアカウント全体に及ぶ Personal Access Token が要る。ここで欲しいのは
 * 「一覧の中身」ではなく「AIDEの戻り先が通るか」なので、既に持っている公開鍵だけで足りる
 * この経路を採った。
 *
 * **副作用は無い。** トークンが成立しないため、セッションもメール送信も発生しない。
 */

/** 外部への問い合わせが返らないまま起動ログや画面が固まらないようにする。 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 検証に使う `state`。実際のログインは乱数を載せるが、値そのものは照合に関係しない
 * （許可リストはURL文字列に対する glob 照合で、`state` の中身は見ていない）。
 * ログに出たときに「検証用のリクエストだ」と分かる固定値にしておく。
 */
const PROBE_STATE = "redirect-check";

/** 成立しないトークン。`pkce_` で始めないこと（PKCEフローだとクエリが書き換えられる）。 */
const PROBE_TOKEN = "aide-redirect-check-not-a-real-token";

export type RedirectCheckStatus =
  /** 渡した戻り先がそのまま返ってきた＝許可リストに載っている。 */
  | "ok"
  /** 別の戻り先（Site URL）へ倒された＝載っていない。**#93 の状態。** */
  | "mismatch"
  /** Supabaseへ届かなかった等で判定できなかった。**異常とは限らない。** */
  | "unknown";

export interface RedirectCheckResult {
  status: RedirectCheckStatus;
  /** 検証に使った戻り先。実際のログインが渡すものと同じ形（`?state=` 付き）。 */
  expected: string;
  /** Supabaseが実際に採用した戻り先。判定できなかったときは null。 */
  actual: string | null;
  /**
   * 画面へ出してよい粒度の説明。**共有プロジェクトの Site URL は載せない**
   * （AIDEとは無関係の別アプリのURLで、この画面から出す理由が無い）。正常なら空文字。
   */
  detail: string;
}

/** フラグメントを落として比較する。GoTrue はエラーを `#error=...` として付けて返す。 */
function withoutFragment(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`;
}

/**
 * 実際にSupabaseへ問い合わせて確かめる。**例外は投げない。**
 * 呼び出し側（起動時のログ・画面の疎通確認）はどちらも「確かめられなかった」で続行してよい。
 */
export async function checkRedirectAllowed(
  config: SupabaseAuthConfig,
  baseUrl: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<RedirectCheckResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const expected = callbackUrl(baseUrl, PROBE_STATE);

  const endpoint = new URL("/auth/v1/verify", config.url);
  endpoint.searchParams.set("type", "magiclink");
  endpoint.searchParams.set("token", PROBE_TOKEN);
  endpoint.searchParams.set("redirect_to", expected);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "GET",
      // 追いかけてしまうと Location を読めないうえ、戻り先（＝AIDE自身か他アプリ）へ
      // 実際にリクエストが飛ぶ。判定に要るのはヘッダだけなので、ここで止める。
      redirect: "manual",
      headers: { apikey: config.publishableKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // 例外の message にはURLが載ることがある。種別だけに落とす。
    const kind = cause instanceof Error ? cause.name : "不明";
    return {
      status: "unknown",
      expected,
      actual: null,
      detail: `Supabaseへ問い合わせできなかった（${kind}）`,
    };
  }

  const location = response.headers.get("location");
  if (!location) {
    return {
      status: "unknown",
      expected,
      actual: null,
      detail: `Supabaseが戻り先を返さなかった (HTTP ${response.status})`,
    };
  }

  let actual: URL;
  try {
    actual = new URL(location, config.url);
  } catch {
    return { status: "unknown", expected, actual: null, detail: "戻り先がURLとして読めなかった" };
  }

  if (withoutFragment(actual) === withoutFragment(new URL(expected))) {
    return { status: "ok", expected, actual: withoutFragment(actual), detail: "" };
  }

  return {
    status: "mismatch",
    expected,
    actual: withoutFragment(actual),
    detail: "Redirect URLs に未登録（Supabaseが別の戻り先へ倒している）",
  };
}

/**
 * 起動時に一度だけ確かめ、結果をログへ出す。**起動は止めない。**
 *
 * Supabaseを設定している間、画面は許可メールのGoogleログインだけで開く
 * （パスワードでのログインは塞がる）。壊れていると `/status` に入れず、画面側の疎通確認
 * （`POST /status/checks`）にも辿り着けないため、**入れなくても気づける場所はログしかない。**
 */
export async function logRedirectCheck(
  config: SupabaseAuthConfig,
  baseUrl: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<RedirectCheckResult> {
  const result = await checkRedirectAllowed(config, baseUrl, options);

  if (result.status === "ok") {
    console.log(`[status] Googleログインの戻り先は登録済み: ${result.expected}`);
    return result;
  }

  if (result.status === "unknown") {
    console.warn(`[status] Googleログインの戻り先を確認できませんでした: ${result.detail}`);
    return result;
  }

  console.warn(
    "[status] 警告: Googleログインの戻り先がSupabaseに登録されていません。\n" +
      `[status]   渡した戻り先: ${result.expected}\n` +
      `[status]   実際の戻り先: ${result.actual}\n` +
      "[status]   ログインは成功したように見えて、上の「実際の戻り先」（プロジェクトの Site URL）へ\n" +
      "[status]   飛ばされます。Supabaseダッシュボードの Authentication > URL Configuration >\n" +
      "[status]   Redirect URLs へ、クエリを含めて一致する登録を追加してください\n" +
      `[status]   （例: ${new URL(result.expected).origin}${new URL(result.expected).pathname}?**）。`,
  );
  return result;
}
