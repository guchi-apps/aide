# MCP公開ツールの棚卸し（#489）

`src/mcp/catalog.ts` の登録簿を、利用者・問い・読み書き・代替経路・大きさで整理した記録。
**登録簿を変えたら、ここへも足す**（ツールの実在は `catalog.test.ts` / `map.test.ts` が止めるが、
判断の根拠はここにしか残らない）。

## 稼働中MCPとの照合（2026-09-27）

- 稼働中のMCPが返すツール名33本と、登録簿33本は**過不足なく一致**した。名前・説明文に差は見つからず、
  この時点でリリースや接続の更新が要る差は無い。
- この棚卸しで `asset_manager_subscriptions` に引数 `includeHistory` を足し、`aide_balances` の応答項目を
  変えた。**本番へ出すにはリリースが要り、ChatGPT・Claudeのコネクタは再接続（メタデータ更新）が要る**
  （`docs/chatgpt-mcp.md`）。リリース前は稼働中と登録簿に差がある。

## 測り方と限界

- **定義のサイズ**: 登録簿の `tools/list` 相当（`name`・`description`・`inputSchema`）をJSON化したUTF-8バイト数。
  33本の合計は約60KB。
- **応答のサイズ**: 稼働中MCPの読み取りツールを実際に呼んだ応答（整形JSON）の概数。呼んでいないものは「未実測」と書く。
- **未測定**: ChatGPT内部の入力トークン量（ツール定義が毎回入るか、必要時だけ読まれるかを含む）。
  バイト数とトークン数は一致しないので、トークン削減率は推定でしかない。
- **利用実績は未確認**: 本番のMCPアクセス記録（`data/mcp-access.json`。ops-dashboardの「AIDE」タブ）は手元から読めない。
  「利用者」は `src/web/map.ts` の `CALLERS`、aide-bot の接続実装（`presets.ts`・`write-tools.ts`）、
  `docs/chatgpt-mcp.md` に書かれた用途からの整理で、**実際に呼ばれた回数ではない**。

## 一覧

利用者: **C** = Claudeアプリ・Claude Code / **G** = ChatGPT（会話・スケジュール） / **B** = AIDE-bot（Claude API経由。
接続先のツールを丸ごと `mcp_toolset` で渡し、書き込みは後述の名指し2本だけ止める）。
読み書きの列の「書」は状態を変える。定義は説明文＋入力スキーマの合計バイト。

| ツール | 問い | 利用者 | 読/書 | 代替経路 | 取得元 | 定義 | 応答 | 判断 |
|---|---|---|---|---|---|---|---|---|
| `aide_ping` | 疎通 | C G B | 読 | `/health` | 自身 | 0.3KB | 極小 | 維持。接続確認に使う |
| `aide_balances` | いくら持っているか | C B | 読 | `/api/money/summary` | Zaimキャッシュ | 1.0KB | 約11KB→約8KB | **改善**（下記） |
| `aide_fixed_costs` | 毎月の固定費 | C B | 読 | `/api/money/summary` | Asset Manager | 1.4KB | 約7KB | 維持。契約の要約に絞ってあり、明細は22件×7項目 |
| `aide_utility_bills` | 電気・ガス代 | C B | 読 | なし | Zaim公式API | 1.0KB | 未実測 | 維持（種類と期間を引数に取る） |
| `aide_host_status` | サーバーの状態 | C B | 読 | ops-dashboard | ops-dashboard | 1.2KB | 約2KB | 維持 |
| `aide_uptime_monitors` | 外形監視 | C B | 読 | ops-dashboard | ops-dashboard | 0.8KB | 未実測 | 維持 |
| `aide_service_quotas` | AI等の残枠 | C B | 読 | ops-dashboard | ops-dashboard | 0.9KB | 未実測 | 維持 |
| `aide_room_sensors` | 部屋の実測値 | C B | 読 | myroom | myroom | 1.3KB | 約2KB | 維持 |
| `aide_aircon_status` | エアコンの状態 | C B | 読 | myroom | myroom | 1.1KB | 未実測 | 維持（操作 `aide_aircon_control` と分離済み） |
| `aide_printer_status` | 3Dプリンター | C B | 読 | myroom | myroom経由 | 2.0KB | 未実測 | 維持（鮮度切れの区別を返す） |
| `aide_room_buttons` | 押せる機器の一覧 | C B | 読 | myroom | myroom | 0.8KB | 未実測 | 維持（`aide_room_press` の候補） |
| `aide_room_press` | 照明等を押す | C B | **書** | myroom | myroom | 2.4KB | 極小 | 維持。dryRun・突き合わせを保つ |
| `aide_aircon_control` | エアコン操作 | C B | **書** | myroom | myroom | 3.5KB | 小 | 維持。dryRun・突き合わせを保つ |
| `aide_weather` | 今日・明日の天気 | C B | 読 | Open-Meteo | キャッシュ | 1.2KB | 未実測 | 維持 |
| `aide_schedule` | 予定・空き時間 | C B | 読 | DaySpan API | DaySpan | 3.9KB | 1日約2.5KB（予定6件） | 維持。定義は大きいが選び分けの記述で、`days` 上限14で応答は有界。予定ごとの `url` は長い（約170B/件）が、開くための実用情報 |
| `aide_tasks` / `aide_get_task` | 正式タスクの一覧・指定取得 | C | 読 | YoteiFlow API | YoteiFlow | 未測定 | 未測定 | `tasks:read`が必要。予定・移動を取得しない。ページングは`hasMore`と`nextCursor`で明示 |
| `aide_create_task` / `aide_update_task` / 状態変更4本 | 正式タスクの作成・更新・状態変更 | C | **書** | YoteiFlow API | YoteiFlow | 未測定 | 未測定 | `tasks:write`が必要。冪等性キー・version・競合結果をYoteiFlow契約のまま中継 |
| `aide_garbage_collection` | ゴミ収集日 | C B | 読 | myroom/DaySpan | DaySpan | 1.6KB | 未実測 | 維持 |
| `aide_create_event` | 予定を作る | C B | **書** | DaySpan | DaySpan | 2.0KB | 小 | 維持 |
| `aide_update_event` | 予定を変える | C B | **書** | DaySpan | DaySpan | 未実測 | 小 | 新設（#493）。dryRun・復唱確認を保つ |
| `aide_delete_event` | 予定を消す | C B | **書** | DaySpan | DaySpan | 未実測 | 小 | 新設（#493）。dryRun・タイトル一致を保つ |
| `aide_dev_status` | 開発の俯瞰 | C B | 読 | GitHub | GitHub | 1.3KB | 約9KB（20リポジトリ） | 維持。1リポジトリ約0.45KB。`aide_repo_status` と問いを分けてあり、絞り込みは呼び出し側の選択で足りる |
| `aide_repo_status` | 1リポジトリの詳細 | C B | 読 | GitHub | GitHub | 1.1KB | 約1.8KB | 維持 |
| `aide_repo_labels` | 起票用ラベル | C B | 読 | GitHub | GitHub | 0.8KB | 未実測 | 維持（`aide_create_issue` の候補） |
| `aide_create_issue` | Issue起票 | C B | **書** | `gh` | GitHub | 2.9KB | 小 | 維持。aide-bot は名指しで止める |
| `issue_deck_upload_image` | 画像の置き場へ | C B | **書** | IssueDeck API | IssueDeck | 1.4KB | 小 | 維持 |
| `aide_claude_sessions` | サブPCのセッション | C B | 読 | ops-dashboard | サブPCのキャッシュ | 2.0KB | 約1.3KB（2件） | 維持 |
| `aide_zaim_master` | 登録に渡すID候補 | C B | 読 | なし | Zaim（24hキャッシュ） | 0.9KB | 約9KB | 維持。ジャンル約115件はカテゴリと組で選ぶ必要があり、削ると登録が壊れる |
| `aide_zaim_payment` | 支出を登録 | C B | **書** | Zaim | Zaim | 3.4KB | 小 | 維持。取り消せないので分離・aide-bot名指しを保つ |
| `asset_manager_import_payment` | 請求メール取り込み | G | **書** | Asset Manager API | Asset Manager | 4.3KB | 小 | 維持（G専用。定期タスクの入口） |
| `asset_manager_subscriptions` | サブスク明細 | C B | 読 | Asset Manager API | Asset Manager | 2.3KB | **約40KB超→約16〜18KB** | **改善**（下記） |
| `asset_manager_create_subscription` | サブスク登録 | C G B | **書** | Asset Manager API | Asset Manager | 2.4KB | 小 | 維持 |
| `asset_manager_add_subscription_price` | 料金改定を追加 | C G B | **書** | Asset Manager API | Asset Manager | 1.4KB | 小 | 維持 |
| `aide_research_desk_import_weekly_report` | 業界情報の登録 | G | **書** | Research Desk内部API | Research Desk | 5.1KB | 小 | 維持（G専用の定期タスク。ChatGPTが繋げるのはAIDEだけ） |
| `aide_create_notification` | aide-botへ通知登録 | G | **書** | aide-bot API | aide-bot | 1.3KB | 小 | 維持（G専用） |
| `aide_create_task_candidate` | aide-botへタスク候補 | G | **書** | aide-bot API | aide-bot | 1.3KB | 小 | 維持（G専用） |
| `aide_save_daily_brief` | aide-botへ日次ブリーフ | G | **書** | aide-bot API | aide-bot | 1.3KB | 小 | 維持（G専用） |

**未使用・重複と確認できたツールは無く、廃止・改名はしない。** 似た名前の組
（`aide_balances`/`aide_fixed_costs`、`aide_room_sensors`/`aide_aircon_status`、`aide_dev_status`/`aide_repo_status`、
`aide_fixed_costs`/`asset_manager_subscriptions`）は、説明文が互いに「それは◯◯」と名指しで振り分けており、
#373 の分割の意図どおり。固定の定期処理（Zaim巡回・天気の同期など）はworkerのままで、MCPの同期呼び出しへ移していない。

## 改善した3点

| 対象 | 実測で確認したこと | 変更 |
|---|---|---|
| `asset_manager_subscriptions` | 22契約で約40KB超。契約ごとに料金履歴と支払方法履歴が付き、支払方法履歴は現在値（`paymentMethod`・`zaimLink`…）の重複がほとんど | 既定で両履歴を省く。**今後適用される料金改定（Asset Manager が付けた `isCurrent` の行より後ろ）は `scheduledPriceChanges` に残す**（「次にいくら請求されるか」に効くため）。`includeHistory: true` で従来どおり |
| `aide_balances` | `staleAccounts` が `onlineAccounts` と同じ口座を二重に返す（当日でない口座が28件のとき28件×2） | MCPのみ `staleAccountNames`（名前の配列）へ。最終更新は `onlineAccounts` に残る。HTTPの `/api/money/summary` は不変 |
| 全ツール共通 | どのツールも `JSON.stringify(_, null, 2)` の整形で返しており、インデントと改行だけで応答が約3分の1大きい（サブスク一覧の同等データで 40.5KB→27.1KB） | `transport.ts` の出口でJSONとして読める text だけ整形なしに直す。値は変えない |

合わせると、サブスク一覧の同等データは 40.5KB → 16.1KB（約6割減）。トークン数での削減は未測定。

失敗・未設定・古い値の区別は変えていない。`asset_manager_subscriptions` は `status: "error"`（未設定・タイムアウト）や
2xx以外（`isError: true`）を加工せず返し、`aide_balances` は `empty`・`stale`・`ageMinutes`・`note` をそのまま返す。

## 見送ったもの（根拠つき）

- **定義（説明文・入力スキーマ）の短縮**: 大きいのは書き込みツールの入力スキーマで、検証と選び分けに要る。
  ChatGPT側でツール定義が必要時に読まれるなら公開本数は毎回の入力に直結せず、未測定のまま削ると
  選択の精度だけを落とすおそれがある。
- **`aide_zaim_master` の圧縮**: 登録には全IDの対応が必須。
- **`aide_dev_status` の絞り込み**: 20リポジトリで約9KB。1リポジトリだけなら `aide_repo_status` で足りる。

## 別Issueで扱うもの

- **aide-bot の書き込み名指しの漏れ**（guchi-apps/aide-bot#367）: `presets.ts` の `writeTools` は
  `aide_zaim_payment`・`aide_create_issue` の2本だけで、`aide_create_event`・`aide_update_event`・`aide_delete_event`・`aide_room_press`・`aide_aircon_control`・
  `asset_manager_create_subscription`・`asset_manager_add_subscription_price`・`issue_deck_upload_image` は
  「書き込みツールを渡さない」設定でも素通しになる。AIDE側の書き込みツールの一覧はこの表の「書」の行。
  ここでは変更しない。
