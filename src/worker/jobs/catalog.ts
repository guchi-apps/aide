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
    name: "zaim-sync",
    description: "Zaimを巡回して残高・保有銘柄を取得し、キャッシュを更新する。Playwrightを使うため重い。",
    interval: "日次",
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
