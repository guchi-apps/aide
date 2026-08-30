# ChatGPTのスケジュールからAIDE Botへ登録する

ChatGPTのスケジュールが接続済みアプリから情報を集め、AIDEのMCPツール経由でAIDE Botへ登録する。
AIDEはGmail・カレンダーの取得を担当せず、選別・要約済みの内容を受け取る。

## AIDE側の設定

サーバーの `.env` に次の3つを設定する。値はIssue、ログ、MCPの引数や応答へ記録しない。

| 設定 | 内容 |
| --- | --- |
| `AIDE_BOT_URL` | aide-botの公開URL（例: `https://aide-bot.gucchii.com`） |
| `AIDE_BOT_TOKEN` | aide-botの `NOTICE_INGEST_TOKEN` と同じサーバー間Bearerシークレット |
| `AIDE_BOT_EMAIL` | 登録先利用者のメールアドレス。ChatGPTからは渡さない |

未設定または不正なURLの場合、ツールは外部へ送信せず未設定結果を返す。

## 利用できるツール

- `aide_create_notification`: 利用者に知らせる情報。内部種別は `schedule`
- `aide_create_task_candidate`: 対応が必要なタスク候補。内部種別は `task`
- `aide_save_daily_brief`: 日次ブリーフ。内部種別は `daily-brief`

3ツール共通の引数は `title`、`summary`、`source`、`dedupeKey`、`priority`、`url`、
`recommendedAction`、`showAt`、`expiresAt`。`priority` は `LOW`、`NORMAL`、`URGENT` のいずれかで、
省略時は `NORMAL`。日時はISO 8601形式で指定する。同じ用件には毎回同じ `dedupeKey` を使うことで、
aide-bot側の既存の重複排除・上書き動作を利用できる。

## ChatGPTスケジュールの指示例

「接続済みアプリから、返信や確認が必要なメール、今後の予定、対応が必要なタスクを調べる。知らせる価値が
あるものだけを選び、元URL・情報源・安定した `dedupeKey`・優先度・推奨アクションを付けて、適切なAIDEの
登録ツールを呼ぶ。該当がなければ何も登録しない。」

## 手動確認

1. 通常のChatGPTチャットからテスト通知を1件登録し、AIDE Botの「話す」画面で確認する。
2. 短時間のテストスケジュールから同じツールを呼び、承認なしで登録されるか確認する。
3. Gmailまたはカレンダーの情報を1件だけ選び、同じ `dedupeKey` で再実行して重複せず上書きされることを確認する。

ChatGPT側のMCP接続には既存AIDEの公開URL末尾 `/mcp` を指定する。設定変更後はメタデータ更新または再接続が
必要になる場合がある。スケジュール実行時の承認有無はChatGPT側の仕様に依存するため、実測結果を記録する。
