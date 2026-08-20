/**
 * Claude Code が自分で書いているセッション台帳のうち、AIDEが使うフィールドだけを再宣言したもの。
 *
 * 正本は Claude Code 本体（`~/.claude/sessions/<pid>.json`）で、こちらから形を決められない。
 * **バージョンが上がればフィールドは黙って増減する**ため、必須として扱うのは
 * 「これが無いとセッションを特定できない」ものだけに絞り、残りは常に「無いかもしれない」
 * 前提で読む。ここに書いていないフィールドは読まない。
 *
 * **同じディレクトリにある `<pid>.<hash>.key` は認証情報にあたる。**
 * 拡張子が `.json` のものだけを読み、`.key` は開かない。
 */

/** `~/.claude/sessions/<pid>.json` の中身（使う範囲だけ）。 */
export interface ClaudeSessionFile {
  pid?: number;
  cwd?: string;
  /** 起動時刻（epoch ミリ秒）。 */
  startedAt?: number;
  /**
   * `/proc/<pid>/stat` の 22 番目のフィールド（starttime）。
   * **PIDの使い回しを見分けるために持たれている。** 同じPIDの別プロセスと区別できる唯一の手掛かり。
   */
  procStart?: string;
  version?: string;
  /** `interactive` など。 */
  kind?: string;
  /** `cli` など。 */
  entrypoint?: string;
  /** `<セッション名>:@<window>.<pane>` の形。先頭がtmuxのセッション名。 */
  tmux?: string;
  /** Claude Code が付けた表示名（例: `aide #123`）。 */
  name?: string;
  updatedAt?: number;
  /** `busy` / `idle` など。 */
  status?: string;
  statusUpdatedAt?: number;
  /**
   * リモートコントロールの接続先ID（`session_...`）。
   * **これが無いセッションはリモートコントロールが確立していない**（URLを作れない）。
   */
  bridgeSessionId?: string;
}

/** 1セッション分。MCPの応答へそのまま載る粒度。 */
export interface ClaudeCodeSession {
  /** Claude Code が付けた表示名。無ければ null。 */
  name: string | null;
  /** プロジェクト名（作業ディレクトリから導いたもの）。導けなければ null。 */
  project: string | null;
  /** 作業ディレクトリ。ホームディレクトリは `~` に置き換える。 */
  cwd: string | null;
  /** tmux のセッション名。`tmux attach -t <名前>` で開ける。 */
  tmuxSession: string | null;
  /** 起動時刻（ISO8601）。 */
  startedAt: string | null;
  /** `busy`（応答中）/ `idle`（待機中）など、Claude Code が書いた値そのまま。 */
  status: string | null;
  /** その状態になった時刻（ISO8601）。 */
  statusUpdatedAt: string | null;
  /**
   * リモートコントロールのURL。
   * リモートコントロールが確立していないセッションでは null になる。
   */
  remoteControlUrl: string | null;
  version: string | null;
}

/** 収集の結果。キャッシュへ入り、`POST /api/cache/:key` でVPSへ渡る形。 */
export interface ClaudeCodeSessionsSnapshot {
  /** 収集したホスト名（本番ではサブPC）。 */
  hostname: string;
  /** 収集時刻（ISO8601）。鮮度の判定に使う。 */
  collectedAt: string;
  /** 生きているセッションだけ。終了済みの残骸は除いてある。 */
  sessions: ClaudeCodeSession[];
  /**
   * 読めなかった台帳の件数。
   * 壊れたJSONや競合による読み落としは普通に起きるので、0件と混同しないよう別に持つ。
   */
  unreadable: number;
}
