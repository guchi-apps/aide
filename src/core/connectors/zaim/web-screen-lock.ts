/**
 * Zaim Web版の画面操作（新規登録・既存明細の編集）を1件ずつに絞る排他ロック。
 *
 * ログイン状態（storage state）はファイル1つで、2つのChromiumが同時に開くと更新が競合し、
 * 巡回まで巻き込んでセッションを失う（#215）。新規登録（`web-payment.ts`）と既存明細の
 * カテゴリ変更（`web-genre-edit.ts`）・メモの書き換え（`web-memo-edit.ts`）はいずれもこの画面を操作するため、**同じロックを
 * 取り合う**——別々に持つと、片方が画面を開いている間にもう片方が同時に開けてしまう。
 *
 * 待たせずに断るのは、待たせると呼び出し元のタイムアウトに掛かって「登録・変更されたか
 * 分からない」状態を自分で作ることになるため。**画面を開く前に断れば `rejected` と言い切れる。**
 *
 * プロセス内でしか見ないので、呼び出し元は1プロセス（受け口）に限る。
 */
let inFlight = false;

/** 取得できたら true。既に誰かが画面を触っていれば false（待たせない）。 */
export function acquireZaimWebScreenLock(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

export function releaseZaimWebScreenLock(): void {
  inFlight = false;
}
