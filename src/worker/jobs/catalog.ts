/**
 * worker ジョブのメタデータ。
 *
 * 実行本体（runner）を import していないのが要点。ジョブ名と説明だけを知りたい側
 * （機能一覧ページ）がここを読んでも、Zaim巡回まわりのモジュールを一切読み込まない。
 * runner との対応付けは `src/worker/run.ts` が持ち、網羅性は `JobName` の型で担保する。
 */
export interface JobInfo {
  name: string;
  /** 何をするジョブか。 */
  description: string;
  /** 想定する実行間隔。スケジューリング自体は外（cron / systemd timer / PM2）に任せている。 */
  interval: string;
}

export const JOB_CATALOG = [
  {
    name: "zaim-refresh",
    description:
      "Zaimの連携口座を一括更新する（「データを更新する」を押す）。押すまで各金融機関から" +
      "再取得されないため、これを先に走らせないと巡回しても古い残高が記録される。" +
      "反映まで5〜15分かかるので、巡回より前に置く。",
    interval: "日次（23:15 JST）",
  },
  {
    name: "zaim-sync",
    description:
      "Zaimを巡回して残高・保有銘柄を取得し、キャッシュを更新する。Playwrightを使うため重い。" +
      "その日の最終データを確定させるため、zaim-refresh の完了を見込んだ時刻に置く。",
    interval: "日次（23:35 JST）",
  },
  {
    name: "zaim-keep-alive",
    description:
      "Zaimのセッションを延長するだけの軽量ジョブ。認証Cookieは約2時間で失効し、" +
      "アクセスのたびにその時点から延長されるため、間隔を失効時間より短く保つ。" +
      "一時的な失敗は再試行し、失効を検知したときは資格情報があれば自動で再ログインする。",
    interval: "30分ごと",
  },
] as const satisfies readonly JobInfo[];

export type JobName = (typeof JOB_CATALOG)[number]["name"];
