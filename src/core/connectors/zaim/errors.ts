/**
 * Zaim巡回の失敗理由のうち、機械的に判別したいものだけを置く。
 *
 * セッション失効は「次回実行で勝手に直る失敗」ではなく、手動ログインをやり直さない限り
 * 直らない失敗にあたる。通知側（`src/worker/notify.ts`）が他の失敗と区別して扱うため、
 * マーカー文字列と判定を1か所へ集めている。
 *
 * 巡回スクリプト本体（`scripts/*.mjs`）は型を持たないためマーカーを直接書いており、
 * ここと同じ文字列である必要がある。
 */

/** 巡回・セッション延長スクリプトがセッション失効時に投げるエラーのマーカー。 */
export const ZAIM_SESSION_EXPIRED = "ZAIM_SESSION_EXPIRED";

/** エラーメッセージがセッション失効によるものか。 */
export function isZaimSessionExpired(message: string): boolean {
  return message.includes(ZAIM_SESSION_EXPIRED);
}
