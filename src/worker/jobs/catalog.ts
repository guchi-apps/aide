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
  /**
   * 最後の成功からこれ以上経っていたら「動いていない」とみなす分数。
   *
   * 実行間隔の文字列（`interval`）は人向けの表示で、機械が読める形になっていない。
   * 動作状況ページ（`/status`）が鮮度を判定するために、間隔そのものではなく
   * **見逃してよい遅れを含めた猶予**をここに持たせている。
   */
  staleAfterMinutes: number;
}

export const JOB_CATALOG = [
  {
    name: "zaim-refresh",
    description:
      "Zaimの連携口座を一括更新する（「データを更新する」を押す）。押すまで各金融機関から" +
      "再取得されないため、これを先に走らせないと巡回しても古い残高が記録される。" +
      "反映まで5〜15分かかるので、巡回より前に置く。",
    interval: "日次（23:15 JST）",
    // 日次なので24時間＋実行のずれと再試行のぶんを見て36時間。
    staleAfterMinutes: 36 * 60,
  },
  {
    name: "zaim-sync",
    description:
      "Zaimを巡回して残高・保有銘柄を取得し、キャッシュを更新する。Playwrightを使うため重い。" +
      "その日の最終データを確定させるため、zaim-refresh の完了を見込んだ時刻に置く。",
    interval: "日次（23:35 JST）",
    staleAfterMinutes: 36 * 60,
  },
  {
    name: "zaim-keep-alive",
    description:
      "Zaimのセッションを延長するだけの軽量ジョブ。認証Cookieは約2時間で失効し、" +
      "アクセスのたびにその時点から延長されるため、間隔を失効時間より短く保つ。" +
      "一時的な失敗は再試行し、失効を検知したときは資格情報があれば自動で再ログインする。",
    interval: "30分ごと",
    // 30分間隔なので、2回ぶん飛んだら気づけるように90分。
    staleAfterMinutes: 90,
  },
  {
    name: "weather-sync",
    description:
      "Open-Meteo から今日・明日の天気・最高／最低気温・降水確率を取得し、キャッシュを更新する。" +
      "取得自体は軽いが、無料枠に利用回数の条件があるため呼ばれるたびに外部へ出さず、" +
      "毎時ここで取っておく。朝のブリーフィングが読む。",
    interval: "1時間ごと",
    // 毎時なので、3回ぶん飛んだら気づけるように180分。
    staleAfterMinutes: 180,
  },
  {
    name: "claude-sessions-sync",
    description:
      "サブPCで動いている Claude Code のセッションを集めてキャッシュを更新する。" +
      "台帳（~/.claude/sessions）はサブPCのファイルにしか無く、VPSのMCPサーバーからは" +
      "呼ばれたときに読めないため、ここで定期的に送っておく。" +
      "リモートコントロールのURLを返すツール（aide_claude_sessions）が読む。",
    interval: "2分ごと",
    // 2分間隔なので、5回ぶん飛んだら気づけるように10分。
    // セッションの一覧は数分古いだけで「いま動いているもの」として使えなくなるため、
    // 他のジョブより猶予を短く取っている。
    staleAfterMinutes: 10,
  },
] as const satisfies readonly JobInfo[];

export type JobName = (typeof JOB_CATALOG)[number]["name"];
