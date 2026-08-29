/**
 * Zaim巡回の失敗理由のうち、機械的に判別したいものだけを置く。
 *
 * セッション失効は「次回実行で勝手に直る失敗」ではなく、自動再ログイン（#63）か手動ログインを
 * やり直さない限り直らない失敗にあたる。通知側（`src/worker/notify.ts`）が他の失敗と区別して
 * 扱うため、マーカー文字列と判定を1か所へ集めている。
 *
 * **失効には「自動で直る見込みがあるもの」と「無いもの」の2種類がある。** 資格情報が設定されて
 * いれば `session.ts` が自動再ログインを試み、30分ごとの `zaim-keep-alive` でも直る。一方、自動
 * 再ログインまで失敗した場合は手動ログインしか残らない。前者に「手動でログインし直すまで失敗し
 * 続けます」と通知していたため、受け取った側が対応の要否を判断できなかった（#191）。
 * 両者を分けるため、失効のマーカーとは別に `ZAIM_AUTO_RELOGIN_FAILED` を用意している。
 *
 * 巡回スクリプト本体（`scripts/*.mjs`）は型を持たないためマーカーを直接書いており、
 * ここと同じ文字列である必要がある。
 */

/** 巡回・セッション延長スクリプトがセッション失効時に投げるエラーのマーカー。 */
export const ZAIM_SESSION_EXPIRED = "ZAIM_SESSION_EXPIRED";

/**
 * 失効を検知して自動再ログインを試みたが、それも失敗したことを表すマーカー。
 * 付けるのは `session.ts` だけ。付いている失敗は手動ログインでしか直らない。
 */
export const ZAIM_AUTO_RELOGIN_FAILED = "ZAIM_AUTO_RELOGIN_FAILED";

/** エラーメッセージがセッション失効によるものか。 */
export function isZaimSessionExpired(message: string): boolean {
  return message.includes(ZAIM_SESSION_EXPIRED);
}

/** その失効が「自動再ログインも失敗した」ものか。 */
export function isZaimAutoReloginFailed(message: string): boolean {
  return message.includes(ZAIM_AUTO_RELOGIN_FAILED);
}

/**
 * 失効エラーを日本語へ言い換える。**マーカーは必ず残す。**
 *
 * `scrape.ts` / `refresh.ts` はスクリプトの英語のエラーをここで言い換えているが、そのときに
 * マーカーを落とすと通知側が失効だと判別できなくなる。同じ文面を2か所に持たないため関数にした。
 */
export function zaimSessionExpiredMessage(autoReloginFailed: boolean): string {
  const markers = autoReloginFailed
    ? `${ZAIM_SESSION_EXPIRED}／${ZAIM_AUTO_RELOGIN_FAILED}`
    : ZAIM_SESSION_EXPIRED;
  return (
    `Zaimのログインセッションが失効しています（${markers}）。` +
    (autoReloginFailed
      ? "自動再ログインも失敗したため、scripts/login.mjs を実行し直してください。"
      : "scripts/login.mjs を実行し直してください。")
  );
}
