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

---

# ChatGPTのスケジュールからResearch Deskへ週報を登録する

宅配事業・ロッカー事業の業界情報は、ChatGPTの定期タスクが**毎日20:00（Asia/Tokyo）**に直近7日分を
検索・選定・要約し、AIDE経由でResearch Deskへ登録する（#211 / #226 / guchi-apps/research-desk#31 /
guchi-apps/research-desk#43）。**週へ集約するのはResearch Desk側**（日曜始まり）で、AIDEは1回の
呼び出しを中継するだけ。

**Research Deskの独立MCPへ直接繋がない。** 静的Bearer認証の独立MCPはChatGPT側の認証運用と合わず、
アプリごとに接続を増やすより、既に接続・認証済みのAIDEを共通窓口にするほうが既存のAsset Manager連携と
揃う。ChatGPTはAIDEの接続認証だけを使い、Research Desk側の認証情報には触れない。

```
ChatGPT定期タスク → AIDE（aide_research_desk_import_weekly_report）
                  → Research Desk（POST /api/internal/weekly-report）→ DB
```

## AIDE側の設定

サーバーの `.env` に次の2つを設定する。値はIssue、ログ、MCPの引数や応答へ記録しない。

| 設定 | 内容 |
| --- | --- |
| `AIDE_RESEARCH_DESK_URL` | Research Deskの公開URL（例: `https://research.gucchii.com`） |
| `AIDE_RESEARCH_DESK_TOKEN` | Research Desk側の `INTERNAL_API_KEY` と同じサーバー間Bearerシークレット |

どちらかが未設定、またはURLが `http` / `https` でない場合、ツールは外部へ送信せず未設定結果を返す。

## 入力と制限

`aide_research_desk_import_weekly_report` の引数は `executedAt`、`targetFrom`、`targetTo`、`articles`。
日時はISO 8601形式で指定する。記事は**1回あたり全体で1〜10件、1事業あたり5件まで**（#226。
それ以前は全体6件・1事業3件で、**当時の呼び出しはそのまま通る**）。

記事の必須項目は `business`（`DELIVERY` = 宅配事業 / `LOCKER` = ロッカー事業）、`informationType`、
`title`、`url`、`sourceName`。任意で `publisher`、`isPrimarySource`、`publishedAt`、`occurredAt`、
`summary`、`content`、`implications`（商品企画・全体設計への示唆）、`importance`、`targetCompany`、
`targetProduct`、`extractedMetrics`、`keywords`、`tags`、`periodScope`（`IN_SCOPE` /
`PAST_30_DAYS_SUPPLEMENT`）を渡せる。

**件数の上限はAIDEとResearch Deskの両方に、それぞれ独立した定数として書かれている**
（AIDE側は `src/core/connectors/research-desk/index.ts` の `MAX_ARTICLES` /
`MAX_ARTICLES_PER_BUSINESS`、Research Desk側は `src/app/api/internal/weekly-report/route.ts` の
`ARTICLE_LIMIT` / `ARTICLE_LIMIT_PER_BUSINESS`）。**片方だけ広げると、AIDEの検証は通るのに
Research Deskが400で弾く**という形で失敗する。上限を動かすときは必ず両方を揃える。

`extractedMetrics` は主要数値を項目名と値で持つオブジェクト（例: `{"設置駅数": 12, "ボックス数": 480}`）。
**30項目・JSONにして2000文字まで**で、AIDEが見るのは入れ物の形と大きさだけ。要約や本文の置き場に
しない（`summary` / `content` がある）。

**重複判定・同一イベントの統合更新・実行履歴・冪等性はResearch Desk側が持つ。** AIDEは入力の形だけを
検証し、応答をそのまま返す（件数や `status` を読み替えない）。URLが違っても発表主体
（`publisher` / `targetCompany`）・対象製品（`targetProduct`）・発表日（`occurredAt` / `publishedAt`）・
`informationType`・`extractedMetrics` から同一の発表と判定されたものは、新規作成されず既存記事へ
統合・上書き更新される。**統合させたい記事ほどこれらを埋める。**

応答で1件ごとの結末が分かる。

| 項目 | 意味 |
| --- | --- |
| `insertedCount` | 新規に追加された |
| `mergedCount` | 別URLの同一発表として既存記事へ統合・上書きされた（記事は増えない） |
| `duplicateCount` | 同一URL、または内容に変化が無く何もしなかった |
| `excludedCount` | 週あたりの保持上限を超え、取り込まれなかった・既存記事と入れ替えられた |

このほか `status`・`runId`・`failedCount`・`businessCounts`（新規＋統合更新の事業別内訳）・
`duplicateBusinessCounts`・`errors` が返る。**AIDEが必須として見るのは `runId` と `status` だけ**なので、
Research Desk側で項目が増えてもそのまま届く。

登録できなかった場合は `ok: false` と日本語の `reason` を返す。入力の誤りは `INVALID_REQUEST`、
接続・認証・Research Desk側のエラーは `FAILED`。**HTTPの応答本文は理由文へ混ぜない**（認証情報や
取得データが漏れる経路になるため）。

## ChatGPT定期タスクの指示例

「宅配事業とロッカー事業の業界情報を直近7日から探し、事業ごとに5件まで（合計10件まで）選ぶ。7日で
足りなければ30日まで広げ、その記事の `periodScope` を `PAST_30_DAYS_SUPPLEMENT` にする。各記事に
タイトル・URL・情報源・発表元（`publisher`）・対象製品（`targetProduct`）・発表日（`occurredAt`）・
要約・商品企画への示唆・重要度・キーワードを付け、設置台数や金額などの数字が分かるものは
`extractedMetrics` に入れる。`aide_research_desk_import_weekly_report` を1回だけ呼ぶ。」

## 手動確認

1. 通常のChatGPTチャットから記事1件を登録し、Research Deskの週間画面に出ることを確認する。
2. 同じ内容をもう一度送り、`insertedCount` が増えず `duplicateCount` が増えることを確認する。
3. 同じ発表を**別のURL**で、`publisher` と `targetProduct` を揃えて送り、`mergedCount` が増えて
   画面の記事が増えないことを確認する。
4. 宅配事業とロッカー事業を混ぜて送り、`businessCounts` が分かれて返り、画面でも分かれて見えることを確認する。
