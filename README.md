# aide

AIDE（エイド）— 生活情報まわりの共通バックエンド／ハブ。

Claudeアプリ等のLLMクライアントに対しては **MCPサーバー** として、既存の個人アプリに対しては **REST API** として、同じデータを提供する。

設計の背景・意思決定は Notion「[AIDE アーキテクチャ構想](https://app.notion.com/p/3ba506de73c381d58c03e0e7676d30b9)」を正本とする。ここにはコードを読むうえで必要な範囲だけ書く。

## 責務

AIDEがやること:

- 外部サービスからの**データ取得**（Zaim、GitHub、Google系、Notion 等）
- 必要な範囲への**フィルタリング**
- サービスごとに異なる形式の**共通フォーマットへの整形**
- 生のAPIではなく、問いの単位に畳んだ**ビュー**の提供
- **他のどこからも塞がっている経路に限った書き込み**（後述。持っているものは下の表が正で、ここには数を書かない）

AIDEがやらないこと:

- **高コストなAI推論**。意味の解釈・優先順位付け・要約・文章生成は呼び出し側のLLMに渡す。AIDEは取得・選別・整形に徹する
- **公式MCPと重複する単機能ツールをMCP層に出すこと**（後述）
- **他のアプリが既に持っている書き込み経路の置き換え**（後述）

### 書き込みをどこまで持つか

AIDEは元々**取得専用**として作った。書き込みを足すかは Issue ごとに判断せず、次の3条件を
**すべて**満たすものに限る（aide#50 で確定。aide#37 以降の判断もこれに従う）。

1. **他のどこからも塞がっている経路であること。** 既存のアプリ・公式MCP・Claude Code から
   できることは、AIDEに口を作らない（往復が増えるだけになる）
2. **読み取りとは別の資格情報を使うこと。** 取得用のトークンに書き込み権限を足さない
   （**逆の向きは可**。書き込み用の資格情報に読み取りの用途が加わっても、読み取り側へ書き込みの
   力は増えない。Asset Manager がその例で、下の「ChatGPTのスケジュールからの取り込みは条件1・2を満たす」を参照）
3. **作成だけを持つこと。** 編集・削除・状態の変更は持たない。取り返しのつく操作に限る

現在入れている書き込みと、3条件それぞれの判断は次のとおり。**書き込みを足すときは、ここに行を足して
3条件の判断を書く**（表に無い書き込みは、判断の記録が無いのと同じになる）。MCPツールとしての一覧は
[MCPツール](#mcpツール)。

| | 経路 | 条件1 | 条件2（資格情報） | 条件3 |
|---|---|---|---|---|
| `aide_create_issue`（aide#50） | ClaudeアプリからのGitHub Issue起票 | 満たす | `AIDE_GITHUB_ISSUE_TOKEN`（取得用とは別のPAT） | 作成のみ |
| `POST /map/issue`（#355） | アプリ連携画面の「機能を同期」で見つけた差から、図を直すGitHub Issueを起票 | **例外**（下記） | `AIDE_GITHUB_ISSUE_TOKEN`（`aide_create_issue` と共用。取得用とは別のPAT） | 作成のみ |
| `POST /api/zaim/payment`（aide#37） | 個人アプリからZaimへの支出登録 | **例外**（下記） | Zaim APIの OAuth 1.0a（巡回の storage state とは別） | 作成のみ |
| `aide_zaim_payment`（aide#135） | 外部のClaude CodeからZaimへの支出登録 | 満たす（下記） | 同上（OAuth 1.0a） | 作成のみ |
| `POST /api/zaim/payment/web`（aide#214） | 個人アプリからZaim **Web版の入力画面**への品目明細の登録 | **満たす**（下記） | ログイン状態（storage state） | 作成のみ |
| `POST /api/zaim/payment/web/genre`（aide#273） | 個人アプリからZaim **Web版の編集画面**を通じた、既存明細のカテゴリ・内訳の変更 | **満たす**（下記） | ログイン状態（storage state。新規登録と共用） | **例外**（下記。カテゴリ・内訳の変更のみ） |
| `POST /api/zaim/payment/web/memo`（aide#354） | 個人アプリからZaim **Web版の編集画面**を通じた、既存明細のメモの書き換え | **満たす**（下記） | ログイン状態（storage state。新規登録・カテゴリ変更と共用） | **例外**（下記。メモの書き換えのみ） |
| `POST /api/image-mail/send`（aide#230） | Research Desk経由での画像メール送信 | **例外**（下記） | Gmail OAuth（新規。読み取り用の資格情報も無い） | 作成のみ |
| `POST /api/news-mail/send`（aide#257） | Research Desk経由での業界ニュース週報メール送信 | **例外**（下記） | Gmail OAuth（画像メールと共用）＋別トークン | 作成のみ |
| `aide_create_event`（aide#243） | DaySpan経由での予定の新規作成 | 満たす | `AIDE_DAYSPAN_WRITE_TOKEN`（読み取り用の `AIDE_DAYSPAN_TOKEN` とは別のトークン） | 作成のみ |
| `aide_room_press`（aide#317） | myroom経由での照明などの操作（Nature Remo のボタンを押す） | 満たす | `AIDE_MYROOM_CONTROL_TOKEN`（読み取り用の `AIDE_MYROOM_TOKEN` とは別のトークン） | **例外**（下記。機器の状態を変える） |
| `aide_aircon_control`（aide#316） | myroom経由でのエアコンの電源・運転モード・設定温度・風量の変更（白くまくんへ運転指示を送る） | 満たす | `AIDE_MYROOM_CONTROL_TOKEN`（照明の操作と共用。読み取り用の `AIDE_MYROOM_TOKEN` とは別のトークン） | **例外**（下記。機器の状態を変える） |
| `asset_manager_import_payment`（#199） | ChatGPTのスケジュールからAsset Managerへの請求情報（Gmailの請求メール1件）の取り込み | 満たす（下記） | `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET`（サブスクの読み取り〔#345〕にも同じ値を使う。下記） | 作成のみ（下記） |
| `asset_manager_create_subscription` / `asset_manager_add_subscription_price`（#346） | Asset Managerへのサブスク・初回料金の登録と、料金改定履歴の追加 | 満たす | `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET`（取り込み・サブスクの読み取りと共用。下記） | 作成のみ（下記） |
| `aide_create_notification` / `aide_create_task_candidate` / `aide_save_daily_brief`（aide#205） | ChatGPTのスケジュールからaide-botへの通知・タスク候補・日次ブリーフの登録 | 満たす（下記） | `AIDE_BOT_TOKEN`（aide-botの `NOTICE_INGEST_TOKEN`。登録専用で、読み取り用は無い） | **例外**（下記。同じ `dedupeKey` は上書き） |
| `aide_research_desk_import_weekly_report`（aide#211） | ChatGPTのスケジュールからResearch Deskへの業界情報の登録 | 満たす（下記） | `AIDE_RESEARCH_DESK_TOKEN`（Research Deskの `INTERNAL_API_KEY`。AIDEは読み取らないため、登録専用） | **例外**（下記。同一の発表は統合更新） |

#### アプリ連携画面からのIssue起案は条件1の例外（#355）

`POST /map/issue` は `aide_create_issue` と同じGitHub Issueの起票で、**条件1は文言どおりには満たさない**
（Issueを作る手段は、ClaudeアプリからもGitHubの画面からも他にある）。それでも画面に置いたのは、
**起票する内容が「図の宣言（`src/web/map.ts`）と、いま動いている機能の差」で、それを持っているのは
AIDEだけ**だから。差を見つけた画面から、そのまま図を直すIssueへ進める。**この判断は他の起票の前例に
しない**（別の内容を画面から起票したくなったら、Issueで改めて決める）。

条件2は `aide_create_issue` と同じ書き込み専用のトークン（`AIDE_GITHUB_ISSUE_TOKEN`）を共用する
（取得用のトークンには書き込み権限を足していない）。条件3（作成のみ）は満たし、既定の
`70.needs-decision` が付くため実装フローへ自動では乗らない。**本文は同期し直した差からサーバーが組み立て、
画面からの入力は一切使わない**ので、利用者が起票の内容を書き換える口は無い。

詳細は[機能の同期](#機能の同期アプリ連携ページ)。

#### Zaimへの登録は条件1の例外（aide#37）

Zaim の `POST /v2/home/money/payment` は**公開APIで、car-care / asset-manager から直接叩ける**。
「他のどこからも塞がっている経路」ではないため、条件1は文言どおりには満たしていない。
それでもAIDEへ寄せたのは、塞がっているからではなく **Zaimの資格情報を1か所に閉じ込めるため**。
各アプリがそれぞれZaimクライアントと認証情報を持つと、読み取り側で起きた重複（asset-manager#191）を
書き込み側でも作ることになる。条件2・3は文言どおり満たしている。

**この例外を前例として使わない。** 「経路は開いているが資格情報を分散させたくない」という形の要望は
他のサービスでも出うるので、次に持ち込むときはこの節を根拠にせず、Issueで改めて決める。

#### 画像メール送信は条件1の例外だが、Zaimの例外を前例にしていない（aide#230）

Research DeskのブラウザからGmail APIを直接叩くことも技術的には可能で、その場合「他のどこからも
塞がっている経路」ではなくなる。それでもAIDEへ寄せたのは、Zaimの例外（aide#37）と同じく
**Gmailの資格情報を1か所に閉じ込めるため**——Research Deskがメール送信権限を持つと、送信元の
資格情報を持つアプリがまた1つ増える。**この判断はZaimの例外を前例として使わず、Issue #230で
改めて行った。** 条件2（別の資格情報）・条件3（作成のみ）は文言どおり満たす。

詳細は[個人アプリ向けのZaim登録API](#個人アプリ向けのzaim登録api)。

#### 業界ニュース週報メール送信も画像メールと同じ理由で条件1の例外（aide#257）

`POST /api/news-mail/send` は画像メール（aide#230）と同じくGmail送信で、**画像メールの例外を
前例として使わず**、この判断も同じ理由（Gmailの資格情報を1か所に閉じ込める）で行っている。
認証は画像メールとは別の共有シークレット（`AIDE_NEWS_MAIL_TOKEN`）を使い、Gmail資格情報
（`AIDE_GMAIL_*`）だけを共用する。条件2・3は画像メールと同じ理由で満たす。

詳細は[個人アプリ向けの業界ニュース週報メール送信API](#個人アプリ向けの業界ニュース週報メール送信api)。

#### MCP経由のZaim登録は条件1を満たす（aide#135）

`aide_zaim_payment` は同じZaimへの登録だが、**上の例外を根拠にしていない**（「前例として使わない」と
書いてあるとおり、aide#135 で改めて判断した）。

条件1が見ているのは「**その呼び出し元から**届く経路が他にあるか」で、外部のClaude Codeから
Zaimへ書く手段は現状ゼロ。唯一の口である `POST /api/zaim/payment` はVPS内の `127.0.0.1` から
叩く前提で、公開URLからは[遮断される](#公開urlからの遮断)。Zaimの公開APIを直接叩けるのは
資格情報を持つ側だけで、Claudeはそれを持たない。条件2・3は aide#37 と同じ理由で満たす。

詳細は[外部のClaude CodeからのZaim登録](#外部のclaude-codeからのzaim登録mcp)。

#### Web版の入力画面からの登録は条件1を満たす（aide#214）

`POST /api/zaim/payment/web` は同じZaimへの登録だが、**aide#37 の例外を根拠にしていない**。

条件1が問うのは「その経路が他から届くか」で、**Zaim Web版の入力画面を操作する経路は他に無い**。
公式APIは公開されているが、そのAPIで作った明細はZaimの「レシート置き換え」の候補にならない
（品目・出金元・日付・金額がまったく同じでも、分かれ目は作成経路にある。
guchi-apps/asset-manager#300 で実測）。ログイン状態（storage state）とPlaywrightの実行基盤は
このリポジトリにしか無く、asset-manager 側にはどちらも無い。

条件2は取得と同じ storage state を使うため文言どおりには満たさない——が、**これは
「読み取り用のトークンに書き込み権限を足した」のではない**。Zaimのログイン状態は元から
読み書きの区別を持たないCookieで、権限を広げる操作は発生していない。条件3（作成のみ）は満たす。

詳細は[Web版の入力画面からの登録](#web版の入力画面からの登録置き換えに載せるため)。

#### 既存明細のカテゴリ変更は条件3の例外（aide#273）

`POST /api/zaim/payment/web/genre` は条件3（作成だけ・編集は持たない）の例外にあたる。**編集を
一般には許さない方針は変えていない**——許すのは「カテゴリ・内訳を選び直す」ことだけで、金額・
日付・口座・品目・お店・集計対象外はこの経路では変えられない（受け取ったJSONの検査
`normalizeWebGenreEditInput()` がそもそもこれらの項目を受け取らない）。

例外にした理由は、公式APIには**自動連携明細（カード・スマートレシート等）を編集する手段が
そもそも無い**こと（Zaim APIの仕様。`write.ts` 冒頭のコメント）。asset-manager の「内訳の提案」
（asset-manager#420）が算出した内訳を書き戻す先が無いと、提案機能そのものが「反映」を持てない。
条件1（他に無い経路）・条件2（ログイン状態は新規登録と同じで、権限を広げていない）は #214 と
同じ理由で満たす。

**この例外を前例として使わない。** 金額・日付・口座などの他の項目や、削除・集計対象外の切り替えを
持ち込むときは、この節を根拠にせず改めて判断する。

開いた明細の日付・金額が本文と一致しない場合は、カテゴリを選ぶ前に検知して422で止める
（別の明細を取り違えて変更してしまう事故を防ぐ）。

詳細は[既存明細のカテゴリ・内訳の変更](#既存明細のカテゴリ内訳の変更aide273)。

**メモの書き換え（`POST /api/zaim/payment/web/memo`・aide#354）も、同じ理由の別の例外として個別に決めた**
（上の「前例として使わない」の運用どおり、この節を根拠にせず #354 で判断した）。銀行口座・
デビットカードの連携明細はZaimの「置き換え」の対象外で、asset-manager の家計簿連携
（asset-manager#514）が買った物を書き込む先が、その連携明細のメモしか無いため。**許すのは
メモ（`input[name="comment"]`）を書き換える（空文字なら消す）ことだけ**で、カテゴリ・金額・日付・
口座・品目・お店・集計対象外は変えない（`normalizeWebMemoEditInput()` がメモ以外を受け取らない）。
条件1・2はカテゴリ変更と同じ理由で満たす。詳細は[既存明細のメモの書き換え](#既存明細のメモの書き換えaide354)。

#### 予定の作成は3条件を文言どおり満たす（aide#243）

`aide_create_event` はDaySpan経由での予定（Googleカレンダー）の新規作成で、他の書き込みと違い
**例外を根拠にしていない**——3条件を文言どおり満たす。

1. **他のどこからも塞がっている経路。** aide-botが繋げるのは公開のリモートMCPサーバーのURLが
   あるものだけで、Googleカレンダーには無い（[基準は「Claudeアプリにコネクタがあるか」ではない](#基準はclaudeアプリにコネクタがあるかではないaide173)）。`aide_schedule` と同じ理由
2. **読み取りとは別の資格情報。** 読み取り用の `AIDE_DAYSPAN_TOKEN` とは別に
   `AIDE_DAYSPAN_WRITE_TOKEN` を持つ。DaySpan側も読み取り用の `INTERNAL_API_KEY` とは別の
   `INTERNAL_EVENTS_API_KEY` で守っており、片方が漏れてももう片方の経路は塞がったまま
3. **作成だけ。** 編集・削除は持たない。動かす・消すにはDaySpanの画面から行う

詳細は `src/core/connectors/dayspan/write.ts`。

#### 照明などの操作は条件3の例外（aide#317）

`aide_room_press` は myroom に登録済みの Nature Remo のボタン（照明のON/OFFなど）を押す。
**部屋の機器の状態を変える操作で、「作成だけ」ではない。** それでも持つのは、押したボタンは逆のボタン
（「消す」に対する「点ける」）を押せば戻せる、取り返しのつく操作だから（Issueでユーザーが決定）。

1. **他のどこからも塞がっている経路。** myroom の操作APIはログインしたブラウザ専用で、
   Claude / ChatGPT から部屋の機器へ届く経路は他に無い
2. **読み取りとは別の資格情報。** 読み取り用の `AIDE_MYROOM_TOKEN` とは別に
   `AIDE_MYROOM_CONTROL_TOKEN` を持つ。myroom側も読み取り用の `INTERNAL_API_KEY` とは別の
   `INTERNAL_CONTROL_API_KEY` で守る（[myroom#419](https://github.com/guchi-apps/myroom/issues/419)）
3. **例外。** 押せるのは myroom の画面で登録済みのボタンだけで、Nature Remo の signal を直接送る口は
   持たない。エアコン（白くまくん）の運転指示はこのツールでは送らない（[別のツール](#エアコンの操作は条件3の例外aide316)）

誤操作の防ぎ方は[照明などの操作](#照明などの操作aide317)。**この例外を前例として使わない。**
状態を変える書き込みを次に持ち込むときは、この節を根拠にせずIssueで改めて決める。

#### エアコンの操作は条件3の例外（aide#316）

`aide_aircon_control` は myroom 経由で白くまくん（AirCloud Home）へ運転指示を送り、エアコンの電源・
運転モード・設定温度・風量を変える。**部屋の機器の状態を変える操作で、「作成だけ」ではない。**
**照明の操作（aide#317）の例外を前例にせず、Issue #316 で改めて判断した。** 持つのは、変更前の状態を
応答に返すので、その値を指定し直せば元に戻せる取り返しのつく操作だから（Issueでユーザーが決定）。

1. **他のどこからも塞がっている経路。** myroom のエアコン操作（#213）はログインしたブラウザ専用で、
   Claude / ChatGPT から届く経路は他に無い
2. **読み取りとは別の資格情報。** 照明の操作と同じ `AIDE_MYROOM_CONTROL_TOKEN`（読み取り用の
   `AIDE_MYROOM_TOKEN` とは別）。**白くまくんのログイン情報はAIDEに持たない**（myroom が持つ）
3. **例外。** 変えられるのは電源・運転モード・設定温度・風量の4項目だけ。風向・湿度など他の設定や、
   タイマー・スケジュールの登録は持たない

誤操作の防ぎ方は[エアコンの操作](#エアコンの操作aide316)。**この例外を前例として使わない。**
状態を変える書き込みを次に持ち込むときは、この節を根拠にせずIssueで改めて決める。

#### ChatGPTのスケジュールからの取り込みは条件1・2を満たす（#199・aide#205・aide#211）

`asset_manager_import_payment`・aide-bot向けの3ツール・`aide_research_desk_import_weekly_report` は、
どれも**呼び出し元がChatGPTのスケジュール**で、宛先の受け口はそれぞれ別のアプリにある。
**例外を根拠にしていない**（Zaimの例外〔aide#37〕も前例にしていない）。

1. **他のどこからも塞がっている経路。** ChatGPTが繋げるのはAIDEの `/mcp` だけで、宛先アプリの
   サーバー間シークレットをChatGPTへ渡す経路は無い。Asset Manager・aide-bot の受け口はBearer
   シークレットで守られたサーバー間APIで、ChatGPTから繋げるMCPサーバーではない。Research Desk は
   独立MCPを持っていたが、ChatGPT側のMCP認証運用と合わず、接続先を増やさないためにAIDEを共通窓口へ
   寄せた（`docs/chatgpt-mcp.md`）。今は他に届く経路が無い
2. **読み取りとは別の資格情報。** aide-bot・Research Desk は、AIDEが**そこから何も読み取っていない**
   （`AIDE_BOT_*`・`AIDE_RESEARCH_DESK_*` は取り込みのコネクタからしか参照しない）。「取得用のトークンに
   書き込み権限を足した」形にはならず、各シークレットはこの登録専用。サーバー側の値はAIDEの環境変数に
   だけあり、MCPの引数・応答・ログへは出さない。
   **Asset Manager は取り込み・サブスクの読み取り・作成を持つ**（月額固定費の `aide_fixed_costs` も同じ読み取り口を使う。`asset_manager_subscriptions`、`asset_manager_create_subscription`、`asset_manager_add_subscription_price`。#345、#346）。
   `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET` は Asset Manager 側で `POST /api/zaim/sync`・
   `POST /api/receipts/import`・`GET /api/subscriptions` のどれも同じ `ZAIM_SYNC_SECRET` で照合される。
   AIDE側は取り込みと同じ値で読む（新しい設定を持たない）。**条件2が避けたいのは「取得用の
   トークンに書き込み権限を足す」こと**で、ここは向きが逆——書き込み用の資格情報へ読みの用途が
   加わっただけで、読み取りツール（GETのみ）から書き込みの口は増えない。だから満たしたままと
   判断する。読み取り専用のトークンを分ける案は、Asset Manager 側の変更が要るため採っていない

条件3は宛先ごとに違うので、次に分ける。

- **Asset Managerへの取り込みは「作成のみ」を満たす。** 編集・削除の口は持たない。同じ
  `gmailMessageId` の再送は `duplicate` になり、何も増えない。ただし**信頼度が十分で分類履歴にも一致すると、
  Asset Manager が反映待ちを経ずにZaimへの登録まで進める**（`imported`・`zaimMoneyId`）。その明細は
  この経路から取り消せない——`aide_zaim_payment` と同じ扱いで、間違いはZaimの画面から人が消す。
  曖昧な抽出結果は `confidence` を低くするよう、ツールの説明で指示している（反映待ち
  〔`pendingReview`〕にするかの判定はAsset Manager側）
- **Asset Managerのサブスク登録・料金追加も「作成のみ」を満たす。** サブスクは初回料金と一緒に新規作成するだけで、既存契約の編集・削除は持たない。料金改定は既存料金を上書きせず、適用開始日付きの `SubscriptionPrice` を履歴として1件追加する。重複する適用開始日は Asset Manager 側が拒否する
- **aide-bot向け3ツールとResearch Deskへの登録は条件3の例外**（下記）

#### 同じキーの再送は上書きになる（aide-bot・Research Desk。条件3の例外）

aide-bot向けの3ツールと `aide_research_desk_import_weekly_report` は、**厳密には「作成だけ」ではない。**
どちらも既存の登録を上書きする。

- aide-bot: `(source, kind, dedupeKey)` が同じお知らせは、新しく積まず**上書きされる**
- Research Desk: 同じURL、または発表主体・対象製品・発表日・種別・主要数値から同一と判定された記事は、
  新規作成されず**既存記事へ統合・上書きされる**（`mergedCount`。判定はResearch Desk側）

例外にした理由は、ChatGPTのスケジュールが**同じ用件を何度も再送する**前提だから。日次実行で毎回
新規作成にすると通知や記事が積み上がるため、宛先側の冪等性（重複させない・続報で更新する）に
任せている。3条件が避けたいのは**取り返しのつかない変更**で、その懸念は次の範囲に収まっている。

- 上書きされるのは**同じ識別キーで登録済みの内容だけ**。他のお知らせ・他の記事は変えられない
- **削除・既読化・状態の変更は持たない。** 入れられるのは内容そのもので、送り直せば差し替えられる
- 上書きの判定（重複・統合）はAIDEではなく宛先側が持つ。AIDEは入力の形を検証して渡すだけ

**この例外を前例として使わない。** 上書きを許しているのは「同一キーの再送を吸収するため」で、
任意の既存データの編集・削除を持ち込むときは、この節を根拠にせず改めて判断する。

詳細は[ChatGPTからAsset Managerへ請求情報を取り込む](#chatgptからasset-managerへ請求情報を取り込むmcp)・
[MCPツール](#mcpツール)・`docs/chatgpt-mcp.md`。

## Core と MCP層の境界

ここが設計上いちばん間違えやすい。**2つのレイヤーを分けて考える。**

| レイヤー | 対象 | 方針 |
|---|---|---|
| Core（`src/core/`） | Notion・Google系・Zaim・GitHub **すべて** | 公式APIを直接叩く。ビューとワーカーに必要なので**フルスコープ** |
| MCP層（`src/mcp/`） | **公開のリモートMCPが無いもの** **のみ**。ツールは**1つの問い**ごとに立てる | 同じ機能のツールが2セット並ぶと、ツール選択が曖昧になりコンテキストも食う。呼び出し側が公式のリモートMCP（Notion等）へ直接繋げるものは、AIDEに口を作らない |

Core をフルスコープで作っておけば、MCP層で「出す／出さない」は後からいくらでも変えられる。判断を先送りできるので、**Core は広く**始める。

### ツールは「1つの問い」ごとに立てる（#373）

以前ここには「MCP層は**横断ビュー**のみ。単機能ツールは増やさない」と書いていた。往復とトークンを
減らすために、複数のソースを1本のツールへ畳む方針だった。**畳みすぎると別の形で高くつく。**

- 「いくら持っているか」に答えるだけで、サブスク契約の全明細まで返っていた（`aide_money_summary`）
- 「残枠はどれくらい」に答えるだけで、全ホストのCPU・メモリ・ディスク・systemd まで返っていた
  （`aide_ops_status`）
- 起票に使うラベルの候補が欲しいだけで、コミット・Issue・Pull Request の一覧まで返っていた
  （`aide_dev_status` の `repo` 付き）

**基準を「情報源が同じか」から「問いが同じか」へ移した。** 1本のツールが答えるのは1つの問いまでで、
別の問いは別のツールにする。同じ上流APIを2本以上のツールが叩くことになってもよい
（ops・room は実際にそうしている。localhost へのHTTP GETなので許容できる）。

**畳んだままにしているもの**もある。`aide_host_status` は6本のうちホスト指標の部分を、
`aide_schedule` はGoogleカレンダーとNotionを統合済みで受け取ったものを返す——どちらも
**利用者から見て問いが1つ**（「サーバーに異常はないか」「いつ空いているか」）だから。

**分けたら、分けた相手を description で名指しする。** 「◯◯は返さない（それは△△）」を両側に書く。
書かないと、似た問いでどちらを呼べばよいかをClaudeが決められない。
`src/mcp/catalog.test.ts` がこの名指しを機械的に確かめている。

### 読み取りと書き込みは必ず分ける

`aide_zaim_master` / `aide_zaim_payment`（aide#135）、`aide_room_buttons` / `aide_room_press`（#317）、
`aide_aircon_status` / `aide_aircon_control`（#316）、`aide_schedule` / `aide_create_event`（#243）、`asset_manager_subscriptions` /
`asset_manager_create_subscription`（#345・#346）はいずれもこの理由で2本になっている。
**1本に畳むと、クライアント側で「常に許可」にしたときに書き込みまで素通しになる。**

**書き込みツールは `dryRun` を持つ**（#373）。どれもこの経路から取り消せないため、送る前に
「何が登録・操作されるか」だけを返せるようにしてある。検査・突き合わせ・二重登録の判定は
本番と同じものを通し、**外部サービスへ出る直前で止める**。副作用の記録（Zaimの冪等キー、
ボタンの連打ガード）にも触れない——下見のつもりの呼び出しが本番の判定を狂わせるため。

**Asset Manager のサブスク一覧**（`asset_manager_subscriptions`。#345）を `aide_fixed_costs` へ
畳まないのは、Zaim等と合成する情報が無く、相手が計算済みで返す内容（月額換算・次回請求日・契約状況・
円換算）をそのまま渡すだけだから。取得は取り込みと同じ通信ヘルパー（`src/mcp/tools/asset-manager.ts` の
`callAssetManager`）を共有するため `src/core/connectors/` へは切り出していない。

### 基準は「Claudeアプリにコネクタがあるか」ではない（aide#173）

以前ここには「Claudeアプリには既に公式MCPがあるので、Googleカレンダー等の単機能ツールは出さない」と
書いていた。**この基準は呼び出し元をClaudeアプリだけに見立てていて、実態に合っていなかった。**

Claude Code や claude.ai で使えるGoogle系・Notionのコネクタは**Anthropic製品側の機能**で、
Messages APIを直接叩く自前のクライアント（[aide-bot](https://github.com/guchi-apps/aide-bot)）からは
利用できない。aide-bot が繋げるのは**公開のリモートMCPサーバーのURLがあるもの**だけで、
Notion にはそれがあり、**Googleカレンダー・Gmailには無い**（aide-bot#61）。

したがって見るのは「Anthropicの製品に同じ機能があるか」ではなく、**呼び出し元から届く公開の
リモートMCPがあるか**になる。

| | 公開のリモートMCP | AIDEのMCP層 |
|---|---|---|
| Notion | ある | **出さない**（aide-bot から直接繋げる） |
| Googleカレンダーの予定 | 無い | **出す**（`aide_schedule`。[コネクタ: DaySpan](#コネクタ-dayspan予定タスク日付リマインド移動)） |
| Gmail | 無い | 出していない（下記の理由で見送り） |

#### Gmailを載せていない理由（aide#173）

同じ「公開のリモートMCPが無いもの」だが、**Gmailの読み取りだけは見送った。** 技術的な不可能さでは
なく、認可の運用が重いため。

- `gmail.readonly` はGoogleの**restricted スコープ**にあたり、同意画面の公開ステータスが「テスト」の
  ままだと**リフレッシュトークンが7日で失効する**（共有知識 `knowledge/common-gotchas.md`）。
  実質「本番」への切り替えが要り、未審査のままだと警告画面を挟むことになる
- 予定と違い、代わりに読める既存のアプリが無いため、AIDEが**メール本文に届く資格情報を持つ**ことになる

必要になった時点で、この節を根拠にせず改めてIssueで判断する。

**送信専用の `gmail.send`（[個人アプリ向けの画像メール送信API](#個人アプリ向けの画像メール送信api)。
aide#230）はこの節と別判断。** メール本文を読む権限を持たない別のスコープであり、見送ったのは
読み取りだけなので、この節の判断はそのまま当てはまらない——改めてIssue #230で判断した。ただし
`gmail.send` も sensitive scope にあたり、**同意画面が「テスト」のままだと7日で失効する制約は
同じ**なので、そちらも「本番」への切り替えが要る。

## 取得と提供の分離

Playwright を使うZaim取得のような重い処理は **worker が定期実行してキャッシュに書き**、MCPサーバー／APIは**キャッシュを読むだけ**にする。

同期リクエスト中にヘッドレスChromiumを起動すると、応答に数十秒かかりメモリも跳ねる。VPSは2GBしかないため、この分離は必須。

- **VPS**: MCPサーバー / REST API / DB（軽量・常時・公開）
- **サブPC**: Playwright等の重いワーカー（16GB・断続・非公開）→ 結果をHTTPSでVPSへ送る

### どこまでを「重い取得」とみなすか

分離が要るのは**重い取得**であって、あらゆる取得ではない。キャッシュを挟むと必ずジョブ間隔ぶん
古くなるため、鮮度そのものが価値であるデータに機械的に適用すると答えが悪くなる。

| | 分離する | 都度叩く |
|---|---|---|
| 例 | Zaim巡回（Playwright・十数秒・メモリが跳ねる） | ops-dashboard（localhostへのHTTP GET・数ミリ秒）・Asset Manager（同じVPS上のHTTP GET・数十ミリ秒） |
| 判断 | 同期リクエストに載せるとVPSが持たない | 載せても問題なく、キャッシュのほうが害になる |

都度叩く場合は**短いタイムアウトを必ず掛ける**（相手が落ちてもMCPツールが固まらないように）。
到達できなかったことは握りつぶさず、状態として返す。

**タイムアウトの長さは相手の作りで決める。** localhost へのHTTP GETでも、相手がそのリクエストの
中で外部APIを叩いていれば数ミリ秒では返らない。DaySpan（Google Calendar と Notion を叩く）だけ
8秒にしてあり、他の3秒と揃えるとその外部APIの遅さがそのままタイムアウトになる
（[コネクタ: DaySpan](#コネクタ-dayspan予定タスク日付リマインド移動)）。

**軽くても分離せざるを得ないものが1つある。** Claude Code のセッション台帳は取得自体が
数ミリ秒だが、**サブPCのファイルシステムにしか無い**ためVPSのサーバーからは読めない
（[コネクタ: Claude Code](#コネクタ-claude-codeサブpcのセッション)）。重さではなく置き場所が
理由なので、鮮度が落ちる代償を承知のうえで収集時刻を併せて返している。

## 構成

```
src/
  server.ts            エントリポイント。/mcp と /api を1プロセスで提供
  mcp/
    transport.ts       Streamable HTTP transport
    registry.ts        ツール登録簿
    catalog.ts         登録簿の組み立て（MCPに出すツールはここへ足す）
    tools/             MCPツール
  api/
    ingest.ts          worker からの取得結果の受け口（POST /api/cache/:key）
    read.ts            個人アプリ向けの読み取りAPI（GET /api/money/summary, GET /api/money/transactions）
    status.ts          ops-dashboard向けの動作状況API（GET /api/status, POST /api/status/checks。#276）
    zaim.ts            個人アプリ向けのZaim登録API（POST /api/zaim/payment）
    image-mail.ts      画像メール送信API（POST /api/image-mail/send。#230）
    news-mail.ts       業界ニュース週報メール送信API（POST /api/news-mail/send。#257）
    multipart.ts       multipart/form-data の最小パーサー
    secret.ts          /api 配下の共有シークレット認証
  core/
    connectors/        外部サービスからの取得
      image-mail/       Gmail送信（画像メール・業界ニュース週報メール共通）・画像メールの冪等記録・履歴（#230）
      news-mail/         業界ニュース週報メールの冪等記録・履歴（#257）
    models/            共通データモデル
    views/             読み取りのビュー
  web/                 人間向けのHTMLページ（アプリ連携・機能一覧・ログイン）と共通レイアウト
  worker/              サブPC側で動くもの
    run.ts             定期実行ジョブのエントリポイント
    zaim-web-server.ts Zaim Web版登録の受け口（VPSからの中継先。常駐）
```

プロセスを1本に絞っているのはメモリ制約のため。パッケージ分割（monorepo化）は規模が育ってから検討する。

## 開発

Node 24 以降が必要（`.ts` を型ストリッピングで直接実行するため、トランスパイル不要）。

```bash
npm run dev     # node --watch --env-file-if-exists=.env src/server.ts
npm start
npm run typecheck
```

デフォルトで `127.0.0.1:4747` を listen する。`PORT` / `HOST` で変更可。

**`.env` は Node 標準の `--env-file-if-exists` で読ませている。** `AIDE_AUTH_PASSWORD` が未設定だと
サーバーは起動を拒否するため、読ませないと `.env` に書いてあっても起動しない（本番のPM2も
`node_args` で同じ指定をしている）。

### Claudeアプリから使う

ローカルの4747を、既存の `dev-tunnel`（Cloudflare Tunnel）経由で公開している。

| | |
|---|---|
| 開発用URL | `https://aide-dev.minagu.work/mcp` |
| tunnel設定 | `~/.cloudflared/config.yml` の ingress。**catch-all より前**に置くこと |
| 起動 | `cloudflared tunnel run dev-tunnel` |

ClaudeアプリのカスタムコネクタにこのURLを登録する。**末尾の `/mcp` が要る。**

接続元はAnthropicのサーバーであり利用者の端末ではないため、**公開到達性が必要**。Tailscaleのみのホストには置けない。

トラブル時:

- **エッジが404を返す** — cloudflaredが `~/.cloudflared/config.yml` を自動で読むため、`--url` を渡してもingressが優先され catch-all に落ちている。一時的なトンネルなら `--config` に空のconfigを渡す
- **登録は成功するのに配送されない** — QUIC（UDP 7844）が塞がれている。`--protocol http2` で回避

## MCPツール

| ツール | 内容 |
|---|---|
| `aide_ping` | 疎通確認。サーバー時刻とセッションIDを返す |
| `aide_balances` | いま持っているお金。銀行・電子マネー等の残高一覧、証券口座ごとの保有銘柄、連携口座のZaim側の最終更新。**キャッシュを読むだけ**（取得時刻と経過分数を併せて返す） |
| `aide_fixed_costs` | 毎月出ていく固定費（サブスク・保険・税金・分割払いなど）。通貨別・支払方法別の月額合計、契約ごとの明細、31日以内の支払予定。Asset Manager を都度叩く |
| `aide_utility_bills` | 電気代・ガス代の直近の請求・月ごとの推移（金額・使用量）・前月比・前年同月比。Zaim公式APIを都度叩く（詳細は[電気代・ガス代を読む](#電気代ガス代を読むmcp)） |
| `aide_host_status` | VPS・サブPCのホストごとの稼働状況。死活とCPU・メモリ・Swap・ディスク・温度、落ちている systemd サービス、再起動待ち |
| `aide_uptime_monitors` | 外形監視（Uptime Kuma / UptimeRobot）の停止・確認中 |
| `aide_service_quotas` | AI・GitHub Actions・1Password の残枠とリセット時刻 |
| `aide_room_sensors` | いまの部屋の測定値。センサーごとの室温・湿度・気圧・CO2・照度、屋外との気温差 |
| `aide_aircon_status` | エアコンの運転状態（電源・運転モード・設定温度・風量・online）。**読み取りだけ** |
| `aide_printer_status` | 3Dプリンター（Bambu Lab A1 mini）の状態。印刷状態・進捗率・残り時間・レイヤー・温度・AMS Lite・エラー・最終更新。**鮮度を必ず返し、切れているときは現在の状態を返さない**（詳細は[コネクタ: 3Dプリンター](#コネクタ-3dプリンターmyroom経由378)）。**読み取りだけ** |
| `aide_room_buttons` | 照明など、AIDEから押せる機器のボタンの一覧（myroom に登録済みの Nature Remo のボタン）。読み取りだけ |
| `aide_room_press` | 照明などのボタンを1つ押す。**部屋の機器を操作するツール**（IDと名前を myroom の今の登録と突き合わせてから押す。結果は「送信を依頼できたか」まで。`dryRun` で押さずに確認できる） |
| `aide_aircon_control` | エアコンの電源・運転モード・設定温度・風量を変更する。**部屋の機器を操作するツール**（`acId` と名前を myroom のいまの状態と突き合わせてから送る。オフラインには送らない。結果は変更前の状態と送信後の読み戻しまで返す。`dryRun` で送らずに確認できる。詳細は[エアコンの操作](#エアコンの操作aide316)） |
| `aide_weather` | 今日・明日の天気（天気・最高／最低気温・降水確率）。**キャッシュを読むだけ**（詳細は[天気](#天気)） |
| `aide_schedule` | 指定した日から数日ぶんの予定・移動・タスク・日付リマインドと**空いている時間帯**。DaySpan から取得する。「今日の予定」「今週の予定」「何時なら空いているか」に答える（明日・昨日などの相対的な日は `offsetDays` で指定する。#325）。予定には中止・不参加の記録（`outcome`）と本文（300文字まで）が付く（#388） |
| `aide_create_event` | 予定を1件、Googleカレンダー（DaySpan経由）へ新規作成する。**書き込みツール**（作成のみ。この経路から取り消し・修正はできない。`dryRun` で登録せず確認できる） |
| `aide_dev_status` | 各リポジトリの開発状況を**俯瞰で**返す。最新リリース・未リリースの差分・Issue/PRの件数・確認待ち・直近コミット・CIの成否。引数は取らない |
| `aide_repo_status` | リポジトリ1件の詳細。俯瞰の項目に加えて、直近コミットの一覧・確認待ちのIssue・open な Pull Request |
| `aide_repo_labels` | リポジトリ1件に定義されているラベル（名前・色・説明）。`aide_create_issue` に渡す候補 |
| `aide_create_issue` | GitHubのIssueを新規作成する。**書き込みツール**（作成のみ。編集・close・コメントは持たない。`dryRun` で起票せず確認できる） |
| `aide_claude_sessions` | サブPCで動作中の Claude Code セッションの一覧。リモートコントロールのURL・プロジェクト・状態（`busy` / `waiting` / `idle`）・待っている理由・経過時間を返す。**キャッシュを読むだけ**（台帳はサブPCにしか無い） |
| `aide_zaim_master` | Zaimへ登録するときに渡すID（口座・カテゴリ・ジャンル）の候補。24時間キャッシュし、一覧に無いものを使いたいときだけ `refresh: true` で引き直す |
| `aide_zaim_payment` | Zaimへ支出を1件登録する。**書き込みツール**（作成のみ。この経路から取り消し・修正はできない。`dryRun` で登録せず確認できる） |
| `aide_create_notification` | aide-botへ利用者に知らせる情報を登録する。**ChatGPTスケジュール向けの書き込みツール** |
| `aide_create_task_candidate` | aide-botへ対応が必要なタスク候補を登録する。**ChatGPTスケジュール向けの書き込みツール** |
| `aide_save_daily_brief` | aide-botへ日次ブリーフを登録する。**ChatGPTスケジュール向けの書き込みツール** |
| `asset_manager_import_payment` | Gmailの請求メール1件をAsset Managerへ取り込む。**ChatGPTスケジュール向けの書き込みツール**（信頼度が十分だとAsset ManagerがZaimへの登録まで進める。この経路から取り消せない。詳細は[ChatGPTからAsset Managerへ請求情報を取り込む](#chatgptからasset-managerへ請求情報を取り込むmcp)） |
| `asset_manager_subscriptions` | Asset Manager（サブスク管理の移管先）のサブスク一覧。合計（月額・年額・件数）・次の請求・契約ごとの明細（1回あたりの請求額と月あたりの金額の両方）。**読み取り専用**（`includeEnded` で解約済みも含める。詳細は[サブスクを読む](#asset-managerのサブスクを読むmcp)） |
| `asset_manager_create_subscription` | Asset Managerへサブスクと初回料金を新規登録する。**書き込みツール**（作成のみ。既存の契約・料金を編集・削除しない） |
| `asset_manager_add_subscription_price` | Asset Managerの既存サブスクへ料金改定を履歴として追加する。**書き込みツール**（作成のみ。既存料金を上書き・削除しない） |
| `aide_research_desk_import_weekly_report` | Research Deskへ宅配事業・ロッカー事業の業界情報を登録する。**ChatGPTスケジュール向けの書き込みツール**（1回あたり全体10件・1事業5件まで。重複判定・同一イベントの統合更新・冪等性はResearch Desk側が持つ） |

ChatGPTスケジュール向け3ツールは、サーバー側の `AIDE_BOT_URL`、`AIDE_BOT_TOKEN`、
`AIDE_BOT_EMAIL` を使って aide-bot の `POST /api/notices` へ登録する。メールアドレスや認証トークンは
MCPの引数・応答・ログへ出さない。詳しい設定と手動確認は [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md) を参照。

`aide_research_desk_import_weekly_report` も同じ考え方で、`AIDE_RESEARCH_DESK_URL` と
`AIDE_RESEARCH_DESK_TOKEN` を使って Research Desk の **AIDE専用内部API**
（`POST /api/internal/weekly-report`）へ中継する。ChatGPTはAIDEの接続認証だけを使い、
Research Desk側の認証情報には触れない。**重複判定・同一イベントの統合更新・実行履歴・冪等性は
Research Desk側が持つ**ため、AIDEは入力の形（事業ごとの件数上限・URL・列挙値・日時・主要数値の
大きさ）だけを検証して結果をそのまま返す。同一性判定に使う項目（発表主体・対象製品・発表日・
`extractedMetrics`）も、AIDEは形を確かめて渡すだけで判定そのものは行わない。応答の
`insertedCount`（新規）・`mergedCount`（統合更新）・`duplicateCount`（変化なし）・
`excludedCount`（上限超過で除外）で1件ごとの結末が分かる。
対象の事業は `src/core/connectors/research-desk/businesses.ts` の登録簿から作られ、事業を
増やすときにAIDE側で直すのはそこだけ。**Research Desk 側が先に `main` で受けられる状態に
なっている必要がある**（手順とリリース順は [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md)）。


## 機能一覧ページ

`GET /features` で、このサーバーで使える機能（MCPツール・HTTPエンドポイント・workerジョブ）を
一覧表示する。デプロイ済みのAIDEに何が載っているかをブラウザから確認するためのもの。

実体は `src/web/features.ts`。MCPツールは登録簿から自動生成するため、ツールを増やせば何もしなくても
載る。各MCPツール・HTTPエンドポイントを選ぶと、リクエスト方法、成功時の結果、代表的な失敗、空配列・
未取得などデータ量による結果の違いを確認できる。**HTTPエンドポイントだけは静的な宣言**なので、
`src/server.ts` にルートを足したら `ENDPOINTS` と詳細情報も更新する。

**このページはログインの内側に置く**（アプリ連携 `/map` と同じ関門。#332）。以前は認証なしで公開して
いたが、どのツール・エンドポイントを持つかの一覧は利用状況を読み取れる材料になるため。認証は
[アプリ連携ページ](#アプリ連携ページ)の表と同じで、許可したGoogleアカウント（未設定の環境では
`AIDE_AUTH_PASSWORD`）。未ログインで開くとログイン画面が出て、ログイン後は元の `/features` へ戻る。

載せてよいのは「どんな機能が存在するか」という静的なカタログだけで、キャッシュの中身・取得時刻などの
実データ、環境変数の値、シークレットの設定有無は載せない（`AIDE_AUTH_DISABLED=1` の環境で出す警告だけは
例外）。`/mcp`・`/api/*`・OAuth・`/health`・アイコン・PWAマニフェストの認証は変わらない。

`/` は404のままにしている。

## アイコンとPWAマニフェスト

`src/web/icons/` に置いたPNGを `GET /icons/<名前>` で返し、`GET /manifest.webmanifest` で
ホーム画面へ追加したときの名前・アイコン・起動先（`/map`）を返す（どちらも認証は不要）。ブラウザが `<link>` の
有無によらず取りにくる `/favicon.ico` にも、同じ32px版のPNGを返している。

**アイコンの正は `src/web/icons/icon.svg` の1枚。** 配信しているPNGはそこから
`scripts/build-icons.sh` で書き出した写しなので、**絵を直すときはSVGだけを直してスクリプトを
流し、生成物ごとコミットする**（PNGを直接編集しても、次にスクリプトを流した時点で戻る）。
書き出しには `rsvg-convert`（`librsvg2-bin`）を使うが、**生成物をコミットするためCI・本番では
実行しない**。したがって依存ゼロの方針には触れない。

**実行時に画像を加工しない。** 依存ゼロを保つため画像処理ライブラリを入れておらず、必要な
サイズ（512 / 192 / 180 / 32）をあらかじめ書き出してコミットしてある。サイズを増やすときは
`scripts/build-icons.sh` と `src/web/assets.ts` の `ICONS` の両方へ足す（`ICONS` に載って
いるものがマニフェストにもそのまま出る）。片方だけだとテストが落ちる。

サイズが宣言とずれていないかは `src/web/assets.test.ts` がPNGのIHDRを直接読んで確かめている。

**ブランド表記は `AIde`（`src/web/brand.ts`）。** 「A＋開いたコンパスリング＋針」の字形とワードマークは
`brand.ts` の1か所だけが持ち、画面左上・アプリ連携の図の中央・ログイン画面はどれもそこから描く
（別のデザインを増やさない）。アイコンの `icon.svg` は同じパスを写したもので、食い違うと
`src/web/brand.test.ts` が落ちる。字形を直すときは `brand.ts` を直し、`icon.svg` へ写して
`scripts/build-icons.sh` を流す。ロゴの色はCSS変数（`--logo-*`）でダークモードに追従する。
ロボットの絵は含めない（ロボットの見た目が変わってもブランドが動かないようにするため）。

**アイコンを差し替えたら `ASSET_VERSION`（`src/web/assets.ts`）を上げる。** Service Worker は
使っておらず、旧アイコンが残る原因はHTTPキャッシュ（アイコン24時間・マニフェスト1時間）だけ。
`<head>` とマニフェストとMCPが名乗るアイコンのURLには `?v=<版>` を付けてあり、版を上げれば
参照先が変わって期限を待たずに取り直される（サーバーはクエリを見ずパスだけで返す）。
**ホーム画面へ追加済みのiPhoneのアイコンは追加時点のコピー**で、この仕組みでは変わらない
（削除して追加し直す）。

**絵は中心から半径204.8px以内に収める。** 512pxの版を `maskable` としても名乗っており、
Androidのアダプティブアイコンはそれより外を切り落としてよいことになっている。同じ理由で
背景は角を丸めず512x512いっぱいに塗る（角を透明にすると切り抜き形によっては地が透ける）。

**同じ画像をMCPサーバーとしても名乗る。** `initialize` の応答の `serverInfo.icons`（MCP仕様
2025-11-25 の `Implementation.icons`）に載せており、対応するクライアントではコネクタの一覧などに
このアイコンが出る。名乗るURLは**同一オリジンの絶対URL**にする必要がある（クライアントは資格情報を
付けずに取りに行き、サーバーと別オリジンのアイコンは拒否してよいことになっている）ため、
`resolveBaseUrl()` が返す公開URLから組み立てている（`src/web/assets.ts` の `mcpIcons()`）。
差し替えるときに触るのは `ICONS` だけで、Web側とMCP側の両方がそこから生成される。

表示するかどうかはクライアント側の実装次第で、**載せたからといって必ず出るとは限らない。**
反映にはコネクタの再接続が要ることがある。また `initialize` は相手が要求した版へ下げてネゴシエートするため、
**クライアントが 2025-11-25 より前の版で繋いでいれば、名乗っても読まれない。** アクセスの記録には
プロトコル版を持たせていないので、切り分け用にネゴシエート結果だけをサーバーのログへ1行残している
（`[mcp] initialize: protocol=... client=...`）。


## アプリ連携ページ

`GET /map` で、AIDEを中心にどのアプリとどう繋がっているかを1枚の図で示す（#328）。左に
「AIDEを使うアプリ」（Claude・ChatGPTのスケジュール・個人アプリ）、右に「AIDEが繋ぐ先」を
領域別に並べ、矢印の向きで読む（→AIDE）と書く・送る（AIDE→）を分ける。図の下には、つながり
ごとに「できること」1行と、使うMCPツール・APIを添える。スマホでは縦長の図に組み替える。

| | |
|---|---|
| 載せるもの | アプリの名前・繋がり方（読む／書く）・使うMCPツールとAPIのパス |
| 載せないもの | 実データ・設定値・シークレットの有無 |
| 認証 | 許可したGoogleアカウント（`AIDE_STATUS_ALLOWED_EMAILS`）。Supabase未設定の環境では `AIDE_AUTH_PASSWORD`。`AIDE_AUTH_DISABLED=1` なら素通しし、画面上で警告を出す |

**中身は `src/web/map.ts` の静的な宣言**（`CALLERS` / `GROUPS`）。繋がりはMCPツール・
HTTPエンドポイント・コネクタ・workerに散っていて、機械的に集めても「どのアプリか」までは
分からない。代わりに、宣言したツール名が登録簿に実在すること・パスが機能一覧に載っていること・
登録したツールがどれかの使う側に載っていることを `src/web/map.test.ts` が確かめる。
**MCPツールやコネクタを足したら、ここへも足す**（ツールの登録は `src/mcp/catalog.ts`）。足し忘れは「機能を同期」で見つけられる（[下](#機能の同期アプリ連携ページ)）。

図はHTML/CSSの枠（Grid）で組み、矢印だけを小さなJavaScriptが枠の実位置を測って引く
（描画ライブラリは使わない。JavaScriptが動かなくても枠と一覧は読める）。図のアプリは
下の一覧へのページ内リンクになっている。

### 機能の同期（アプリ連携ページ）

図は手書きの宣言なので、機能を足す・消すたびに実態とずれる。ヘッダーの「機能を同期」を押すと
（`GET /map?sync=1`。読み取りだけなので素のフォームで送る）、**今動いているAIDEの機能を集めて図の宣言と
突き合わせ**、差を画面に出す（#355。突き合わせは `src/web/map-sync.ts` の `collectSync`）。

| | |
|---|---|
| 集める範囲 | MCPの登録簿にあるツールと、機能一覧の `ENDPOINTS` のうち `/api/` のもの（`/api/cache/:key` のようなworkerの受け口は除く）。`/health`・OAuth・アイコン・workerジョブ・コネクタは、図と紐づける情報が宣言に無いため対象外 |
| 追加 | 図のどこにも載っていない機能。「未掲載の機能」のカードに名前・種別・説明を出す |
| 削除 | 図に載っているが実在しない機能。該当する行に取り消し線つきの「実在しない」印を出す |
| 変更なし | 図に載っていて実在する機能の数 |

**表示するだけで、図の宣言（`map.ts`）は書き換えない。** 本番のサーバーはソースを書き換えられず、
書き換えるにはコードの修正（PR）が要るため。代わりに、差があるときだけ「Issueを起案…」を出す。押すと
起票内容（タイトルと本文）を確認でき、「起票する」（`POST /map/issue`）で `aide` に `70.needs-decision` 付きの
Issueを作る。結果は303で `/map` へ戻して番号とリンクを出す（再読み込みしても二重には起票されない）。
書き込みの位置づけは[書き込みをどこまで持つか](#書き込みをどこまで持つか)の表にある。

- **起票の設定（`AIDE_GITHUB_ISSUE_TOKEN`）が無い環境では「Issueを起案…」を出さない。** 設定の有無を
  文言では書かない（このページは設定値・シークレットの有無を載せない方針）。失敗の理由も画面には出さず、
  ログ（`[map-sync]`）にだけ残す
- 脚注はClaudeアプリ経由の起票（`aide_create_issue`）とは別に、この画面からの起票だと名乗る
  （`buildBody` へ脚注を渡せる。`src/core/connectors/github/write.ts`）。重複の防止は既存の
  「直前と同じタイトルは断る」ガード（プロセス内）だけ
- MCPツールの実在と、登録したツールが使う側に載っていることは、`map.test.ts` がCIで止める。
  したがって同期で差が出るのは、主に `/api/` のエンドポイントや、デプロイ後に宣言が古くなった場合

以前あった**動作状況（`/status`）と共通知識（`/knowledge`）の画面は外した**（#328）。
動作状況は ops-dashboard の「AIDE」タブ（[下](#動作状況ops-dashboard向け)）、共通知識は
IssueDeck で見られる。古いブックマークから来た人は `/map` へ送る。

### ログインの受け口は `/status/...` のまま

ログインの受け口（`/status/auth/start`・`/status/auth/callback`・`/status/login`・
`/status/logout`）と Cookie名（`aide_status`）は、動作状況の画面を外した後も名前を変えていない。
**戻り先 `/status/auth/callback` がSupabaseの許可リストに登録されており**、変えると
ダッシュボードでの登録し直しが要るため。判定は `currentSession()`（`src/web/login.ts`）
1か所だけが持ち、ログインの内側に画面を足すときも必ずここを通す。

**開こうとした画面は戻り先として持ち回り、受け取り側で必ず検証する**（`safeLanding()`）。
ナビに載っている画面（`src/web/layout.ts` の `NAV`）以外は既定（`/map`）へ落とす。外部URLを
そのまま `Location` に載せると、ログイン直後に別サイトへ送り出す踏み台になる。

### iOSアプリ向けの室温API（aide#454）

iOSアプリ（`guchi-apps/aide-ios`）のApp Intent（ショートカット・Siri）が、現在の室温をHTTPSで読む
ための口。**アプリからmyroomへは直接繋がず、AIDEが窓口になる。読み取り専用で、操作系は置かない。**

| 口 | 内容 |
|---|---|
| `GET /api/mobile/room-temperature` | `{sensorName, temperature(℃), measuredAt, stale}`。認証なし・不正は401、myroom未設定・取得失敗は503、室温にできるセンサーが無ければ502。`stale: true` は現在値ではない |
| `POST /api/mobile/token` | ログイン引き継ぎコードをトークンへ交換（form: `code`・`code_verifier`） |
| `DELETE /api/mobile/token` | 自分のトークンを失効（`Authorization: Bearer`）。存在しないトークンでも204 |
| `PUT /api/mobile/push/devices` | APNsデバイストークンの登録（JSON: `{deviceToken(hex), environment: development\|production, preferences?: {<種別>: bool}}`）。同じトークンの再登録は更新。成功204・不正400・認証失敗401 |
| `DELETE /api/mobile/push/devices` | 登録の失効（JSON: `{deviceToken}`）。未登録でも204 |

### プッシュ通知（APNs。#463）

登録された端末へ `src/core/push/send.ts` の `sendPush(kind, path)` で送る。認証は `.p8` のトークン認証
（`node:http2`＋ES256のJWT。実行時依存なし）。ペイロードは
`{"aps":{"alert":{"title":"AIDE","body":"<種別ごとの固定文>"},"sound":"default"},"kind":"<種別>","path":"/map"}`。
**本文は固定文だけで、金額・個人情報・トークンを入れない**（詳細はアプリからAIDEの画面を開いて確認する）。
`path` は `/` 始まりの相対パスだけ受け付ける。`environment` が `development` ならAPNsのsandbox、
`production` なら本番のエンドポイントへ送る。`preferences` が `false` の種別は、その端末へ送らない。

APNsが `410`・`400 BadDeviceToken` を返したトークンは、送信のたびに登録簿（`data/push-devices.json`）から自動で消す。
テスト通知は認証情報のある環境（VPS）で `npm run push-test [-- <path>]`（既定 `/map`）。

| 環境変数 | 内容 |
|---|---|
| `AIDE_APNS_KEY` | `.p8` の中身（改行は `\n` の2文字にした1行でもよい） |
| `AIDE_APNS_KEY_ID` / `AIDE_APNS_TEAM_ID` | Key ID・Team ID |
| `AIDE_APNS_BUNDLE_ID` | 任意。既定 `com.gucchii.AIDEios` |

値の正は1Password（`op://apps/aide/apns-auth-key` `apns-key-id` `apns-team-id`）。3つ未設定なら送信せず「未設定」になる。

**認証は専用のBearerトークン**（`src/auth/mobile-token.ts`）。MCPのOAuthトークンとは別系統で、
`/api/mobile/*` にしか通らない（`/mcp`・他の `/api/*` は通らない）ため、Keychainから漏れても
読めるのは室温だけ。保存するのはSHA-256ハッシュだけ（`data/auth/mobile-tokens.json`・600）、有効期間は180日、
使うたびに許可メール（`AIDE_STATUS_ALLOWED_EMAILS`）を照合する。

**iOS側がトークンを取る手順:**

1. `code_verifier` を作り、そのS256を `code_challenge` にする
2. ASWebAuthenticationSessionで `/status/auth/app/start?scope=mobile&code_challenge=<challenge>` を開く（Googleログイン）
3. `com.gucchii.aide:/auth/callback?code=<code>` で戻る。コードは2分・一回限り、**`scope=mobile` で発行したコードだけがトークンに交換できる**（画面用コードとは交換できない）
4. `POST /api/mobile/token` に `code` と `code_verifier` を送り、`token` をKeychainへ保存する（この応答でしか平文は得られない）
5. 以後 `Authorization: Bearer <token>` で室温を読む。401ならステップ1からやり直す

「室温」にするセンサーは `AIDE_MOBILE_ROOM_SENSOR`（センサー名かdeviceId。任意）で選ぶ。未設定なら
受信が止まっていない最初のセンサー、全部止まっていれば最初の温度ありセンサーを `stale: true` で返す。
指定したセンサーが見つからないときは、別の部屋の温度を黙って返さず502にする。

### ログインは許可したGoogleアカウントだけ

ログインには他アプリ（dayspan・shopping-list）と同じ共有SupabaseプロジェクトのGoogleログインを使い、
`AIDE_STATUS_ALLOWED_EMAILS` に挙げたメールアドレスの人だけを通す（`src/auth/supabase.ts`）。
画面をパスワード1本の内側に置くと、漏れても気づけず、誰が開いたかも残らない。

`@supabase/supabase-js` は入れず、Auth の REST（`/auth/v1/authorize` と
`/auth/v1/token?grant_type=pkce`）を fetch で直接叩いている。**実行時依存ゼロの方針**（後述）と、
必要なのが認可URLの組み立てとコードの交換だけであるため。**Supabase側のセッションは保持しない。**
身元が分かった時点で失効させ、以降は自前のCookieだけで通す。

| 環境変数 | 内容 |
|---|---|
| `AIDE_SUPABASE_URL` | 共有SupabaseプロジェクトのURL |
| `AIDE_SUPABASE_PUBLISHABLE_KEY` | 同プロジェクトの公開鍵（旧 anon key） |
| `AIDE_STATUS_ALLOWED_EMAILS` | 画面を開いてよいメールアドレス（カンマ区切り） |

**3つとも設定するか、3つとも空にするかのどちらかで、半端な状態は起動時に落とす。** 許可メールだけが
空だと「Googleアカウントがあれば誰でも開ける」状態になるため。3つとも空なら従来どおり
`AIDE_AUTH_PASSWORD` でのログインになり、その場合は `POST /status/login` も生きている。
**Googleログインが有効な環境では、パスワードでのログインは受け口ごと無効になる**（404）。
残すと、メールアドレスで絞った意味がパスワード1本で消える。

### 戻り先URLの登録ずれは、起動時と疎通確認で検知する

Supabaseダッシュボードの Authentication > URL Configuration > Redirect URLs に、
AIDEの戻り先を登録しておく必要がある。**ここが一致しないとき、Supabase（GoTrue）はエラーを返さず
プロジェクトの Site URL へ静かに倒す。** ログインは「成功したのに別のアプリの画面が開く」という形で
壊れ、devtoolsで302先を1文字ずつ見比べるまで原因が分からなかった（#93）。認証基盤は他アプリと
共用のため、AIDEが何も変えていなくても他アプリ側の変更で許可リストが書き換われば同じことが起きる。

照合の規則が直感に反する。**フラグメントだけを落とし、クエリは付いたまま glob で照合される**
（GoTrue の `utilities.IsRedirectURLValid`）。AIDEの戻り先は CSRF 対策の `state` を載せた
`<AIDE_BASE_URL>/status/auth/callback?state=<乱数>` なので、**パスだけを完全一致で登録しても通らない。**
末尾に `**` を付けた形で登録する。

```
https://aide.gucchii.com/status/auth/callback**
```

（Site URL と scheme・ホスト・ポートが一致する戻り先は許可リストを見ずに通るため、Site URL が
AIDEのものであるプロジェクトではこのずれは起きない。共有プロジェクトの Site URL は別アプリのもの。）

一致しているかは `src/auth/redirect-check.ts` が確かめる。`GET /auth/v1/verify` に**成立しない
トークン**を渡すと、GoTrue は `/auth/v1/authorize` とまったく同じ判定関数で戻り先を決めてから
エラーのリダイレクトを返すため、`Location` に「実際に採用された戻り先」がそのまま出る。
許可リストの中身そのものを読むには Management API とアカウント全体に及ぶ Personal Access Token が
要るが、**欲しいのは一覧ではなく「AIDEの戻り先が通るか」なので、既にある公開鍵だけで足りる**
この経路を採った。成立しないトークンなのでセッションもメール送信も起こらない。

確認は2か所で走る。

- **起動時に1回**（`AIDE_BASE_URL` があるときだけ）。結果はログに出し、**起動は止めない。**
  Googleログインが壊れていると画面に入れないため、そのときに気づける場所はログしかない
- **疎通確認**（`POST /api/status/checks` の `supabase-redirect`）。ops-dashboard から他の接続先と並べて確かめる

### セッションはOAuthとは別系統

ログインした結果はCookie1つで持つ（`src/web/session.ts`）。MCPのOAuthに載せると画面を開くたびに
認可コードの往復が要る。**Cookieには署名だけを入れ、サーバー側に状態を持たない。**
Googleログインならメールアドレスを、パスワードでのログインなら身元なしを入れ、**メールアドレスも
署名の対象に含める**（含めないと署名の合う値の宛先だけ書き換えて別人を名乗れる）。
許可リストとの照合はCookieを出すときだけでなく**開くたびに行う**ので、リストから外せば
発行済みのCookieもその場で通らなくなる。

**署名鍵はパスワードから導かない。** 導くと、Cookieを1つ手に入れた相手がオフラインで
パスワードを総当たりでき、回数制限（オンライン試行にしか効かない）を迂回されてしまう。しかも
そのパスワードはClaudeアプリの接続認可と同じ1本なので、被害がこの画面の閲覧に留まらない。
鍵は `data/auth/status-session-key` に独立した乱数を1つ持つ（600で作る）。

```bash
rm data/auth/status-session-key   # 画面のログインを全部失効させる
```

総当たり対策は認可画面と同じ仕組み（`src/auth/ratelimit.ts`）を共有する。守っている
パスワードが同じである以上、片方だけ無制限に試せると回数制限が意味を失う。

## 動作状況（ops-dashboard向け）

AIDE自身がいま正しく動いているかは、`GET /api/status` の判定を ops-dashboard の「AIDE」タブが
表示する。判定そのものは `src/core/views/health.ts` が持つ。

| | |
|---|---|
| 返すもの | 全体の判定と対応すべきこと、サーバー（稼働時間・バージョン・認証の有無）、定期ジョブの最後の実行と直近30件の履歴（`jobs[].recentRuns`。新しい順）、キャッシュの鮮度と件数、接続先の設定状況、MCPの登録クライアント数・トークン数、MCPへのアクセスの記録 |
| 返さないもの | 残高の金額、シークレットの値、Zaimのログイン状態 |

材料はすべて手元にあるもの（キャッシュ・実行記録・環境変数の有無）で済ませている。読むたびに
外部を叩くと、相手が落ちているだけで判定が返らなくなる。疎通の確認は `POST /api/status/checks`
が呼ばれたときだけ走る。**Zaim は疎通確認の対象外**（ログインは Playwright を使う重い処理で、
巡回は worker の仕事にしてある）。

**実行記録の履歴（#441）。** worker は実行のたびに1件を `POST /api/cache/job-<name>` へ送るだけで、
直近30件は受け取った側（`src/worker/job-history.ts`）が `job-<name>-history` へ足して古いものから捨てる。
`lastRun` と判定は最新1件（`job-<name>`）のまま。履歴が届く前の環境では `recentRuns` に最新1件だけが出る。

### 返し方（aide#276）

同じVPS上の ops-dashboard がサーバー間で読む（起点 guchi-apps/ops-dashboard#237）。
実装は `src/api/status.ts`。ops-dashboard はこれを「AIDE」タブに表示する。

| | |
|---|---|
| エンドポイント | `GET /api/status` |
| 返す内容 | `{ health, tools }`。`health` は `buildHealth()` の戻り値そのまま、`tools` はMCP接続カードのチップに使うツール名一覧（`registry.list()`） |
| 認証 | `Authorization: Bearer $AIDE_STATUS_SECRET` |

```bash
curl -s -H "Authorization: Bearer $AIDE_STATUS_SECRET" http://127.0.0.1:3114/api/status
```

疎通確認（`runProbes()`）も同じシークレットで叩ける。押されたときだけ
外部の接続先へ問い合わせる。

| | |
|---|---|
| エンドポイント | `POST /api/status/checks` |
| 返す内容 | `{ results }`（`runProbes()` の戻り値） |
| 認証 | `Authorization: Bearer $AIDE_STATUS_SECRET`（`/api/status` と同じ値） |

**`AIDE_READ_SECRET` とは別の値にする。** 読み取りAPIのシークレットを流用すると、動作状況を
見たいだけの ops-dashboard に残高（`/api/money/*`）を読む権限まで渡すことになる。値の正は
ops-dashboard側にあり、`AIDE_OPS_DASHBOARD_TOKEN` と同じ扱いで複製せずそちらの `op://` を
そのまま参照する（`.github/secrets-manifest.tsv`）。未設定なら503、シークレット不一致なら401
（`src/api/read.ts` の `authorize()` と同じ分け方）。

**`health.server.baseUrl` / `mcpUrl` はリクエストのHostからではなく `AIDE_BASE_URL` だけから
組み立てる。** ops-dashboard は `http://127.0.0.1:3114` で直接叩くため、リクエストのHostを使うと
MCP接続先が内部アドレスのまま表示されてしまう。


### MCPへのアクセスの記録

Claudeアプリからの呼び出しは、これまでどこにも残らなかった。ジョブの失敗は Signaly へ飛び
（`src/worker/notify.ts`）、実行の記録はキャッシュに残る（`src/worker/record.ts`）のに、
**MCPだけは「いつ・どのツールが呼ばれたか」を後から確かめる手段が無かった**（#116）。
`/mcp` のやり取り1件につき1行を残し、`/api/status` の `health.mcpAccess` として新しい順で出す
（ops-dashboard の「AIDE」タブが表示する）。

| | |
|---|---|
| 残すもの | 時刻・メソッド（認証で弾いた場合は `auth`）・ツール名・名乗ったクライアント名とバージョン・成否・失敗理由1行・所要ミリ秒 |
| 残さないもの | **ツールの引数と応答の中身**、アクセス元IP、アクセストークン、セッションID |
| 置き場 | `data/mcp-access.json`（直近200件。書き込みは2秒ぶんまとめて行う） |

**未実装のメソッドへの問い合わせ（#438）。** `server/discover` のようにAIDEが実装していない
JSON-RPCメソッドは、応答は `MethodNotFound` のまま変えず、記録に `unsupported` の印を付ける。
集計では失敗・「注意」の判定から外し（`unsupportedCalls` に件数だけ出す）、表示も畳む。
ツールの呼び出しには影響しないのに、ops-dashboard の「注意」が点き続けるのを防ぐため。

**残高や部屋の状態を記録に含めない。** 含めると、MCPが返すデータの置き場をもう1つ増やすのと
変わらなくなる。外へ出せるのも「いつ・誰が・どのツールを・成功したか」までで、中身が要るときは
Claudeに聞くことになる。

置き場をキャッシュ（`src/core/cache/store.ts`）にしていないのは、あちらが worker からHTTPで届く
取得結果の置き場で、受け口（`POST /api/cache/:key`）から上書きできるため。記録を書くのはサーバー
自身なので、経路を共有する理由が無い。メモリ上だけに持つ案は、デプロイのたびに空になり
「最後にClaudeが繋いだのはいつか」に答えられなくなるため採らなかった。

**認証で弾いたアクセスも1行残す。** `/mcp` はトークンが無ければ `requireBearer()` が401を返して
そこで終わり、`src/mcp/transport.ts` までは届かない（`src/server.ts`）。ここを記録しないと、
**Claudeのトークンが切れて呼び出しが全部落ちている状態**と、誰も繋いでいない状態が
区別できない。ただし `/mcp` は公開されている口なので、叩かれ続けたぶんは1分に1件へ落とす。

**上限を超えた分は「接続確認・一覧の取得 → 認証で弾いたもの → 残り」の順に捨てる。** 単純に古い順で
捨てると、Claudeが定期的に投げてくるぶんや外から叩かれた認証失敗が並んだだけで、いちばん見たい
ツールの呼び出しが押し出される。枠を分けずに優先順位だけで守るのは、片方が空でももう片方に
使えるようにするため。

記録に失敗してもMCPの応答は変えない（`src/mcp/access-log.ts`）。実行記録と同じ方針で、記録の
失敗だけで成功した呼び出しが失敗扱いになるのを避ける。

### worker 側の設定は「未設定」と断定しない

本番では worker がサブPC、サーバーがVPSで動き、**`.env` が別**（`deploy.yml` がVPSへ書くのは
`AIDE_*` の一部だけで、`ZAIM_*` と `AIDE_SIGNALY_WEBHOOK_URL` は含まれない）。サーバー側の
環境変数を見て判定すると、正しく動いていても常に「未設定」と出る。

そのため接続先には `side`（`server` / `worker`）を持たせ、**worker 側は判定せず「worker側」と表示する。**
実際に動いているかは、定期ジョブの実行記録（`health.jobs`）で分かる。

## コネクタ: Zaim

Zaimは残高取得の公式APIが無いため、Playwrightで画面を巡回して取得する。**AIDEが存在する理由そのもの**にあたるコネクタ（公式MCPも公式APIも無い領域）。

```
src/core/connectors/zaim/
  parse.ts       生テキスト → 数値化（純粋関数。テストはここに集中する）
  scrape.ts      子プロセスで巡回スクリプトを起動する
  refresh.ts     子プロセスで連携口座の一括更新スクリプトを起動する
  retry.ts       再試行と自動再ログインの「判断」（純粋関数。テストはここ）
  session.ts     子プロセスの起動と、失敗時の回復（再試行・自動再ログイン）
  web-payment.ts Web版の入力画面からの登録（#214）。子プロセスでスクリプトを起動する
  web-idempotency.ts / idempotency.ts  二重登録を防ぐ記録（経路ごとに別ファイル）
  scripts/       Playwright本体（子プロセスとして実行）
    login.mjs        初回の手動ログイン。storage state を保存する
    auto-login.mjs   ID・パスワードによる自動ログイン（任意機能）
    scrape.mjs       残高＋証券詳細ページの巡回
    refresh.mjs      連携口座の「データを更新する」を押し、反映を待つ
    keep-alive.mjs   セッション延長のみ（軽量）
    web-payment.mjs  入力画面（/money/new）を埋めて品目明細を1件登録する
    receipt-form.mjs 入力画面の当て方のうち、ブラウザが要らない判断（純粋関数。テストはここ）
```

### 前提

Playwrightは**AIDEの依存に含めない**。実行環境へグローバル導入する。

```bash
npm install -g playwright && playwright install chromium
```

package-lock を肥大化させず、ブラウザ実行環境をアプリ本体から分離するため。

### 初回セットアップ

GUIのある端末で一度だけ手動ログインし、storage state を保存する。

```bash
node src/core/connectors/zaim/scripts/login.mjs
```

保存先は既定で `data/zaim/storage-state.json`（**リポジトリ基準**。カレントディレクトリ相対にするとワーカーからの実行時にずれる）。中身はCookieそのものなので `data/` ごと gitignore している。

### セッション

Zaimの認証Cookieは**約2時間**で失効するが、アクセスのたびにその時点から延長される。つまり**維持できるかどうかは「2時間以内に1回でも成功したか」だけで決まる**。取得を行わない期間は `keep-alive.mjs` で延長だけする。

**この「1回でも成功したか」が曲者で、単発の失敗がそのままセッション喪失になっていた**（#63）。以前は `zaim-keep-alive` が毎時1回きり・再試行なしで、最悪間隔が1時間5分あった。2026-08-16 に瞬間的なネットワーク断（`net::ERR_ADDRESS_UNREACHABLE`）で1回落ち、次の実行が2時間1分後になった時点で失効している。いまは次の3段で守っている。

| 段 | 何をするか | どこ |
|---|---|---|
| 再試行 | 一時的な失敗（ネットワーク断・タイムアウト等）を最大3回・合計40秒の待ちでやり直す | `retry.ts` / `session.ts` |
| 間隔の余裕 | 30分ごと（揺らぎ2分）に回し、最悪間隔を32分にする。3回続けて失敗しても2時間に間に合う | `deploy/systemd/` |
| 自動再ログイン | 失効を検知したら、資格情報がある場合だけ**1度だけ**ログインし直してやり直す | `auto-login.mjs` |

**セッション失効は再試行しない。** やり直しても同じ結果になるため、`isRetriableZaimFailure()` で切り分けて即座に次の手（自動再ログイン）へ移る。

**Zaimの子プロセスを起こす経路は `runZaimScript()` に一本化する。** 巡回・セッション延長・一括更新のどれもここを通す。以前は一括更新（`refresh.ts`）だけが `execFile` を直呼びしており、失効しても自動再ログインを試さないまま落ちていた（#190）。**回復の仕組みを足しても、経路から外れているものには効かない**——実際 `zaim-refresh` が失効で落ちた直後に `zaim-keep-alive` が同じ失効を自動再ログインで直しており、直せたはずのものが直っていなかった。

#### 失効の判定は「ログイン画面へ飛ばされたか」で見る

Zaimは未ログインでもHTTPエラーを返さず、SSO（`id.kufu.jp`）のログイン画面へ飛ばす。判定は
`scripts/session-check.mjs` の1か所に集約し、**飛び先のURLとパスワード入力欄の有無**だけで見る。

**本文の文言では判定しない。** 以前は「ログイン／メールアドレス／パスワード」を含み、かつ
「残高／総残高／評価額」を含まないことを失効の条件にしていたが、**金額を載せないページでは
ログイン済みでも失効と誤判定する。** 連携口座一覧（`/online_accounts`）がまさにそれで、
`zaim-refresh` はボタンを押した30秒後の確認で必ず失敗し、「手動ログインが必要」という誤った
通知だけが届いていた（#89）。連携口座の最終更新が何日も進まない原因になる。

### 自動再ログイン（任意機能）

`ZAIM_EMAIL` と `ZAIM_PASSWORD` の**両方**が設定されている環境でだけ有効になる。片方だけの設定は設定漏れとみなし、未設定として扱う。

- 未設定なら従来どおり `ZAIM_SESSION_EXPIRED` で失敗させ、手動ログインをやり直す。**開発機・CIではこちらが既定**
- **CAPTCHAや追加認証を突破しにいかない方針は変えていない。** `auto-login.mjs` は追加認証を検知したら素直に失敗し、呼び出し側は元の `ZAIM_SESSION_EXPIRED` を投げ直す。通知は従来どおり「手動ログインが必要」として届く
- 自動再ログインは**1回きり**。ログインし直しても失効するなら（資格情報が古い等）諦める。ログインと失効を往復させないため
- 資格情報の値は `session.ts` では読まない（設定の有無だけを見る）。子プロセスへ環境変数として渡し、ログ・通知・例外メッセージには出さない

値の正は1Passwordに置くが、**実行時に1Password CLIは呼ばない**（#1）。worker が動くサブPCの `.env` へ人が転記する。VPS側には要らない（VPSはキャッシュを読むだけ）。

ログイン画面は `id.kufu.jp` のSSOで構成が変わりうるため、セレクタは `ZAIM_LOGIN_EMAIL_SELECTOR` / `ZAIM_LOGIN_PASSWORD_SELECTOR` / `ZAIM_LOGIN_SUBMIT_SELECTOR` で上書きできる。未設定なら `type` / `name` 属性から総当たりで探す。

### 呼び出し方

`scrapeZaimSnapshot()` はヘッドレスChromiumを起動するため**数十秒かかる**。MCPやAPIの同期リクエストから直接呼んではいけない。worker から定期実行してキャッシュに書き、参照側はキャッシュを読む。

### 連携口座の更新（巡回の前に押す）

**Zaimの連携口座は「データを更新する」を押すまで、各金融機関から再取得されない。** 押さないまま巡回すると、その日の資産額として古い残高が記録される。`zaim-refresh` ジョブが `https://zaim.net/online_accounts` のボタンを押し、完了を待ってから `zaim-sync` が巡回する（#62）。

**反映までの時間は口座によって大きく違う。** 多くは5〜15分で戻るが、SBI証券・楽天証券・Ponta・MUFGカードは**押してから約35分後**にしか進まない。この差を見込まずに待ちを打ち切ると、遅い口座だけ前日の残高のまま巡回され、asset-manager 側の当日の合計がそのぶんずれる（#178）。

| | 押し方・判定 |
|---|---|
| ボタン | `form[action="/online_accounts/renewal"] button[type=submit]`。**クラス名はCSS Modulesのハッシュ付きでZaimのデプロイごとに変わる**ため使わない |
| 確認ダイアログ | `data-confirm` によるネイティブダイアログが出る。**Playwrightの既定は dismiss** なので `page.on("dialog", (d) => d.accept())` が必須（無いと押しても必ずキャンセルされる） |
| 完了判定 | Zaim側に完了のシグナルは無い。口座ごとの「最終更新」が進んだかで判定する。反映まで5〜15分、遅い口座は約35分 |
| 打ち切り | 連携設定が壊れている口座は何度押しても進まないため、全口座の完了は待てない。**しばらくどの口座も進まなくなったら打ち切る**（最短40分・静穏3分・上限45分） |

**「最短40分」は遅い口座の実測に合わせた値**（#178）。早い口座が5〜8分で出揃ったあと、遅い口座が進むまで30分近くどの口座も動かない。静穏だけで打ち切ると毎回そこで抜けてしまうため、静穏の判定は40分を過ぎてから効かせている。上限（`ZAIM_REFRESH_MAX_WAIT_MS`）を縮めるときは、`refresh.ts` の `REFRESH_TIMEOUT_MS`・`aide-zaim-refresh.service` の `TimeoutStartSec`・`aide-zaim-sync.timer` との60分の間隔もあわせて見直す。

**一括更新だけは、やり直しに全体の上限（`totalTimeout`）を掛ける。** 巡回とセッション延長は1回が数十秒なので3回やり直しても次の定期実行に食い込まないが、一括更新は1回で最大45分待つ。上限が無いと、やり直した回が `TimeoutStartSec`（55分）に掛かって systemd から殺され、押下の結果すら受け取れない。残り時間が2分を切ったらやり直さず、**元のセッション失効エラーをそのまま投げる**（タイムアウトのエラーで上書きすると通知の分類が壊れる）。逆に2分あればやり直す価値がある——反映を待ち切れなくても、「データを更新する」さえ押せていれば60分後の巡回は新しい残高を読める。

**`zaim-refresh` と `zaim-keep-alive` の重なりは直していない。** 両者は同じ storage state を読み書きし、タイマーの都合で必ず重なる（keep-alive は30分ごとなので、45分走る一括更新の最中に2〜3回起動する）。失効で落ちた回だけを見ると並行アクセスが原因に見えるが、**成功した回もまったく同じように重なっている**（2026-08-28 22:30・08-29 10:30 の成功回でも、開始の1分後に keep-alive が起動している）。ロックや排他を足しても失効は防げないので、直すべきなのは落ちた側が自力で回復することのほう。

#### 「最終更新」はブラウザのタイムゾーンで描かれる

Zaimは連携口座の最終更新を**クライアント側で**描画するため、表示される日時はヘッドレス
Chromiumのタイムゾーンに従う。**subpc のシステムTZはUTCなので、指定しないと9時間ずれる。**
取り込み側（`parse.ts`）は表示文字列をJSTとして解釈し「当日（JST）に更新されたか」を見るので、
ずれると当日更新できた口座まで「更新できなかった口座」として通知される（#89）。

コンテキストの共通設定（`scripts/context.mjs`）で `timezoneId: "Asia/Tokyo"` に固定し、
`newContext` を呼ぶスクリプトが全部それを渡していることをテストで縛っている。表示の日付形式は
Zaim側が決めているため `locale` は指定しない。

画面の確認は `ZAIM_REFRESH_DRY_RUN=1` で行う。**ボタンを押さず**に、いま読めている口座と最終更新を出力するだけになる（押すとZaimが実際に各金融機関へ取得しにいくため、確認のたびに押さないで済むようにしてある）。

```bash
ZAIM_REFRESH_DRY_RUN=1 node --env-file-if-exists=.env src/core/connectors/zaim/scripts/refresh.mjs
```

### 更新できない口座の扱い

連携先のAPIキーの権限エラーや金融機関側のログイン期限切れで、**何度押しても更新できない口座が残る**（Zaim側の連携設定を直すまで解消しない）。AIDEはこれを次のように扱う。

- **古い残高を捨てたり書き換えたりしない。** 取得した事実だけを持つのがAIDEの責務で、当日値として記録するかの判断は asset-manager 側にある
- 代わりに口座ごとの最終更新を持たせる。`balances` / `holdings` の `lastUpdatedAt` と、連携口座の一覧 `onlineAccounts`（いずれもJSTオフセット付きのISO8601）
- `GET /api/money/summary` は最終更新が当日でない口座を `staleAccounts` にまとめ、`note` にも断りを入れる。**捨てるか使うかは呼び出し側が決める**
- `lastUpdatedAt` は**AIDEが巡回した時刻（`fetchedAt`）とは別物**。巡回が新しくても中身が何ヶ月も前ということがある
- 更新できない口座が出たら Signaly へ通知する（[ジョブ失敗の通知](#ジョブ失敗の通知)）。ジョブ自体は成功扱いのまま
- **判定するのは押下側（`zaim-refresh`）ではなく巡回側（`zaim-sync`）。** 押した直後には反映の遅い口座がまだ進んでおらず、押下側で見ると「更新できない口座」と「反映が遅いだけの口座」を区別できない（#178）

### asset-manager との境界

| | 置き場所 | 理由 |
|---|---|---|
| 巡回・パース | **AIDE** | 「取得」そのもの。他アプリからも再利用する |
| 連携口座の更新（ボタン押下）と最終更新の取得 | **AIDE** | Zaimへ取りに行く経路そのもの。取得結果に「いつのものか」を添えるところまで |
| 最終更新が当日でない口座の残高を記録するか | **asset-manager** | 「その日の資産額として何を採るか」は資産管理側の判断 |
| `Category.valuationAlias` との照合、評価額への反映 | **asset-manager** | 資産管理固有のドメインロジック |
| 同期を実行できるユーザーの制限 | **asset-manager** | asset-manager の認証・ユーザーモデルに紐づく |

asset-manager は巡回結果を[読み取りAPI](#個人アプリ向けの読み取りapi)（`GET /api/money/summary`）から受け取る。

### 取得は巡回、登録は2経路

同じZaimでも、**読む経路と書く経路はまったく別**にしている。混同すると、片方の資格情報で
もう片方を動かそうとして詰まる。さらに書く側も**公式APIとWeb版の画面の2本**ある（#214）。

| | 取得（残高・保有銘柄） | 登録: 公式API | 登録: Web版の入力画面 |
|---|---|---|---|
| 手段 | Playwrightでの画面巡回 | `POST /v2/home/money/payment` | Playwrightでの画面操作 |
| 資格情報 | ログイン状態（storage state） | OAuth 1.0a（`AIDE_ZAIM_*`） | ログイン状態（storage state） |
| 動く場所 | サブPCの worker | VPSのサーバー（同期リクエスト内） | **サブPC**（storage state がある側。VPSは中継する） |
| 実装 | `scrape.ts` / `parse.ts` / `session.ts` | `oauth.ts` / `write.ts` | `web-payment.ts` / `scripts/web-payment.mjs` |
| 置き換えの候補になるか | — | **ならない** | **なる** |

**Zaim APIで扱えるのは利用者が手入力したレコードだけ**という制約があり、残高も取れない。
だから取得は巡回のまま残している。

銀行・カード・スマートレシート由来の**自動連携レコードはAPIから見えず、編集もできない**。
既存レコードの口座付け替え・集計対象外化はこの経路では実現できない（asset-manager#153 Phase 5）。

### Web版の入力画面からの登録（置き換えに載せるため）

**Zaimの「レシート置き換え」の候補になるのは、Web版の入力画面で作った明細だけ。**
品目・出金元・日付・金額がまったく同じでも、公式APIで作った明細は候補にならない
（guchi-apps/asset-manager#300 で実測）。分かれ目は内容ではなく**作成経路**にある。

| 作成経路 | 置き換え候補になるか |
|---|---|
| 公式API（`POST /v2/home/money/payment`）・出金元が「反映待ち」 | ならない |
| 公式API・出金元が連携カード | ならない |
| **Web版の入力画面（`/money/new`）・出金元が連携カード** | **なる** |

そのため、置き換えに載せたい明細だけは `POST /api/zaim/payment/web` を通す。**置き換えの
操作そのものはスマートフォンアプリ限定なので、この経路が担うのは登録まで**。置き換えは人が行う。

#### 呼び出し方

登録に使う値は**呼び出し元が決めて渡す**（`write.ts` と同じ方針で、アプリ固有のドメイン知識は
AIDEへ持ち込まない）。公式API経由との違いは3つ。

- **カテゴリはIDではなく名前で渡す**（`categoryName` / `genreName`）。画面がIDを受け取る欄を
  持っていないため。名前は `GET /api/zaim/master` で引ける
- **`name`（品目名）・`place`（店舗名）・`fromAccountId`（出金元）は必須。** 置き換えの成立条件が
  「品目・出金元・日付・金額の一致」なので、欠けた明細を作っても目的を果たさない。
  `fromAccountId` には**自動連携しているクレジットカード**を指定する（どの口座が自動連携かは
  AIDEでは判断しない）
- **`moneyId` は返せない。** 履歴の行にレコードidが振られておらず、画面から読めない。
  代わりに冪等キーを**メモ欄へ `#<requestId>` として書き込む**ので、後からZaim側で引ける

```bash
curl -sS -X POST http://127.0.0.1:4747/api/zaim/payment/web \
  -H "authorization: Bearer $AIDE_ZAIM_WRITE_SECRET" \
  -H "content-type: application/json" \
  -d '{"requestId":"asset-manager:receipt-item:1","date":"2026-08-29","amount":1880,
       "name":"ピザ","place":"ドミノ・ピザ","categoryName":"食費","genreName":"外食",
       "fromAccountId":21678522}'
```

**応答まで数十秒かかる**（ヘッドレスChromiumの起動を含む）。呼び出し元はタイムアウトを長く
取ること——短く切ると「登録されたか分からない」状態を自分で作ることになる。
`"dryRun": true` を足すと**送信だけ行わず**、埋まった内容を返して終える。

#### 動くのは storage state があるマシンだけ。VPSは中継する

この口は `AIDE_ZAIM_*`（OAuth）を見ない。使うのはログイン状態だけで、**Playwrightと
`data/zaim/storage-state.json` がある実行環境——いまはサブPC——でしか成立しない**。
ところが呼び出し元（asset-manager）もAIDEのサーバーもVPSにいるため、#214 の実装だけでは
**呼び出し元から一度も届かなかった**。そこでサブPCにも受け口を常駐させ、VPSの同じパスが
そこへ同期で中継する（#215）。

```
asset-manager（VPS）
  └ POST https://aide.gucchii.com/api/zaim/payment/web   ← 呼び出し元から見えるURLは変えない
      └ AIDE サーバー（VPS・PM2）
          └ AIDE_ZAIM_WEB_UPSTREAM_URL があれば中継（src/core/connectors/zaim/web-payment-forward.ts）
              └ 受け口（サブPC・systemd。Tailscaleのアドレスで待ち受け）
                  └ Playwright で Zaim の画面を操作
```

| | VPS（中継する側） | サブPC（画面を操作する側） |
|---|---|---|
| 動かすもの | 本体サーバー（PM2） | `src/worker/zaim-web-server.ts`（`aide-zaim-web.service`） |
| 開く口 | 従来どおり全部 | **`POST /api/zaim/payment/web`・`/genre`（#273）・`/memo`（#354）と `/health` だけ** |
| 要る設定 | `AIDE_ZAIM_WEB_UPSTREAM_URL` | `AIDE_ZAIM_WRITE_SECRET`・`AIDE_ZAIM_WEB_HOST` |
| 冪等の記録 | 持たない | `data/zaim-web-payments.json` |

**呼び出し元から見えるURLは変えない。** asset-manager が知っているのは `AIDE_BASE_URL` だけで、
AIDEがどのマシンで何を動かしているかは AIDE 側の都合だから。サブPCへ直接向けさせると、
読み取りAPIまでサブPC経由になり、常駐が止まった瞬間に無関係な機能まで落ちる。

**サブPCで動かすのは本体サーバーではない。** `src/server.ts` をそのまま常駐させれば済むように
見えるが、それだとOAuth認可サーバーとログイン画面がもう1組でき、`data/auth/` が二重になる。
必要なのはこの1経路だけなので、それだけを開いた小さな受け口（`src/worker/zaim-web-routes.ts`）に
してある。認証・入力の検査・失敗の分類は本体と同じ `handleZaimWebPayment` を通す。

**受け口の `.env` に `AIDE_ZAIM_WEB_UPSTREAM_URL` を書かない。** 中継する側の設定で、
受け口はこれが設定されていると起動を拒否する。取り違えても回り続けないよう、中継には
`x-aide-zaim-web-forwarded: 1` を付けて1往復で止めている。

#### 中継が失敗したときにどちらへ倒すか

**「Zaimに何も登録されていないと言い切れるか」だけで分ける**（`web-payment.ts` の
`classifyWebFailure()` と同じ考え方）。ここを誤ると、二重登録か、登録済みの明細を
人が探す手間かのどちらかになる。

| 中継の結果 | 分類 | 呼び出し元 |
|---|---|---|
| 接続できない（`ECONNREFUSED`・`ENOTFOUND` 等） | `rejected` | そのまま送り直してよい |
| 受け口が画面を開く前に断った（401・429・503 等） | `rejected` | 設定を直して送り直す |
| 受け口が `kind` を返した | **その値のまま** | 受け口の判断に従う |
| 打ち切り・応答待ちでの切断 | `failed` | Zaimを確認するまで再送しない |

**受け口が返した `kind` は潰さない。** 特に `conflict`（前回の結果が確定していない）を
再送可能な分類へ倒すと、同じ支出が2件でき、この経路には削除が無いので人が手で消すことになる。

#### 同時に流すのは1件だけ

ログイン状態はファイル1つで、2つのChromiumが同時に開くと更新が競合し、巡回まで巻き込んで
セッションを失う。そのため `createZaimWebPayment()` は**実行中なら待たせずに `rejected` で断る**。
待たせないのは、待つと呼び出し元のタイムアウトに掛かって「登録されたか分からない」になるため。
**画面を開く前に断れば言い切れる。**

#### 画面の当て方

**クラス名はCSS Modulesのハッシュ付き**（`PaymentForm-module__total___3LWZX`）でZaimのデプロイ
ごとに変わるため使わない。当てているのは `name` 属性・`placeholder`・ラベルの文言。
実物で確かめた作り（2026-08-31）は次のとおり。

| | 実際の作り |
|---|---|
| フォーム | `form#money_new_form`（`action="/receipts"`）。**品目の行は3行で固定**。増やす操作は無い |
| 品目名・メモ | `input[name="item_name"]` / `input[name="comment"]`。素直に入力できる |
| 金額 | `input[name="amount"]` は **readonly**。クリックで開く電卓に**キーボードで打ち、Enterで確定**する。電卓のボタンは合成クリックに反応しない |
| カテゴリ | コンボボックスに名前で絞り込んで選ぶ。**絞り込みは部分一致**で、「その他」だけでは13件が並ぶため、直前のカテゴリ見出しと合わせて特定する |
| 出金元 | フォーム内で唯一の `<select>`。`option` の value が**Zaimの口座IDそのもの** |
| 日付 | ピッカーを開いて「前／次」で月を送り、日を押す。**表示形式（`2026年8月31日(月)`）を自前で組み立てない**（曜日の計算がずれると違う日付で登録される） |

**使わない品目行は消してから送る。** 空行が無視される保証が無く、0円の明細が増えると
人が手で消すことになる（この経路は削除を持たない）。

**要素が見つからなければ必ず失敗させる。** 入力欄が欠けたまま進むと、金額や出金元の無い明細が
家計簿に残る。埋め終えた後も、送信の直前に「入れたつもりの値が実際に入っているか」を読み直す。

画面の確認は送信せずに行える。

```bash
ZAIM_WEB_PAYMENT_DRY_RUN=1 \
ZAIM_WEB_PAYMENT_INPUT='{"requestId":"check:1","date":"2026-08-29","amount":1880,"name":"ピザ","place":"ドミノ・ピザ","categoryName":"食費","genreName":"外食","fromAccountId":21678522}' \
node --env-file-if-exists=.env src/core/connectors/zaim/scripts/web-payment.mjs
```

#### 二重登録を止める

記録は `data/zaim-web-payments.json`（`web-idempotency.ts`）。**公式API経由の
`data/zaim-payments.json` とは別ファイル**にしている——あちらは「`money_id` が入っていること」を
確定の印にしており、idを持てないこちらの記録を混ぜると、登録できた明細まで「結果不明」として
扱われる。

失敗したときに**Zaimへ何が残っているか**で扱いが割れる。ここが二重登録の分かれ目になる。

| 失敗の種類 | 記録 | 呼び出し元 |
|---|---|---|
| 送信の**前**に止まった（要素が見つからない・カテゴリが候補に無い・セッション失効） | 消す | `rejected`。直せば送り直してよい |
| 送信した**後**で確認できない・打ち切り・Chromiumが落ちた | 残す | `failed`。次の再送は `conflict` で止まる |

**一時的な失敗をやり直さない**（`runZaimScript` の `retryTransient: false`）。巡回は何度実行しても
結果が変わらないが、登録は変わる。セッション失効時の自動再ログインだけは従来どおり通す——
失効はページを開いた時点で分かるため、送信より前で必ず起きる。


### 既存明細のカテゴリ・内訳の変更（aide#273）

asset-manager の「内訳の提案」（asset-manager#420）は、AIDEが巡回したZaim Web版の一覧
（`money-list.ts`・#244）から自動連携明細（カード・スマートレシート等）の内訳が決まっていない
ものを提案する。しかし提案をZaimへ書き戻す口が無かった。**公式APIは自動連携明細を編集できず**
（`write.ts` 冒頭）、上の新規登録（`web-payment.ts`）も含め、既存明細を編集する経路がAIDEに
無かったため。

`POST /api/zaim/payment/web/genre` は、Web版の**編集モーダル**（一覧の鉛筆アイコンから開く
「家計簿の編集」。[開き方](#編集画面はモーダルにあるaide409)）をPlaywrightで操作し、**カテゴリ・内訳だけ**を選び直す。[条件3の例外](#既存明細のカテゴリ変更は条件3の例外aide273)であることに注意——金額・日付・口座・品目・お店・集計対象外はこの経路では変えない。

#### 呼び出し方

```bash
curl -sS -X POST http://127.0.0.1:4747/api/zaim/payment/web/genre \
  -H "authorization: Bearer $AIDE_ZAIM_WRITE_SECRET" \
  -H "content-type: application/json" \
  -d '{"requestId":"asset-manager:genre-suggestion:1","moneyId":10228209053,
       "date":"2026-09-02","amount":1238,"categoryName":"食費","genreName":"調理食品"}'
# => {"ok":true,"moneyId":10228209053,"duplicated":false,"requestId":"asset-manager:genre-suggestion:1"}
```

- `moneyId` は一覧の `id`（`GET /api/money/transactions`・#244）と同じ値。一覧の行の `data-url`（`/money/<moneyId>/edit`）に載る
- カテゴリは新規登録と同じく**名前**で渡す（画面がIDを受け取らないため）
- 冪等キーは asset-manager 側が `asset-manager:genre-suggestion:<ZaimGenreSuggestion.id>` の形で送る想定
- **応答まで数十秒かかる**（ヘッドレスChromiumの起動を含む）。呼び出し元はタイムアウトを長く取ること
- `"dryRun": true` を足すと**保存だけ行わず**、取り違えの検知とカテゴリの選択までを試す

#### 取り違えの検知

`moneyId` だけで開いた明細を信用せず、**開いた明細の `date`・`amount` が本文と一致するかを
カテゴリを触る前に確認する**。一致しなければ、何も変えずに `rejected`（HTTP 422）で止める。

これが無いと、呼び出し元が古い一覧から拾った `moneyId`（Zaim側で既に削除・統合された等）を
渡した場合に、**意図しない別の明細のカテゴリを書き換えてしまう**。この経路は変更前の値を
覚えておらず元に戻せないため、検知は保存の前に置く。

#### 新規登録との共通点・違い

| | 新規登録（`web-payment.ts`） | 既存明細の変更（`web-genre-edit.ts`） |
|---|---|---|
| 開く画面 | `/money/new` | 一覧（`/money?month=YYYYMM`）の鉛筆アイコンで開く編集モーダル |
| 触る項目 | 全項目 | **カテゴリ・内訳だけ** |
| 返せる `moneyId` | `null`（画面にIDが出ない） | **呼び出し元が渡した値をそのまま返す** |
| 同時実行のロック | `web-screen-lock.ts` を共有 | 同左（storage stateのファイルが1つのため） |
| 冪等の記録 | `data/zaim-web-payments.json` | `data/zaim-web-genre-edits.json`（`moneyId`も保持） |
| 中継（VPS→サブPC） | 同じ受け口サーバーの別パス | 同左 |

失敗の分類（`rejected`/`conflict`/`failed`の使い分け）・中継の考え方は新規登録と同じなので、
上の「[中継が失敗したときにどちらへ倒すか](#中継が失敗したときにどちらへ倒すか)」を参照。

**編集モーダルの中の入力欄は、実物では未確認。** 一覧からモーダルを開くところまでは実物の
観察（下の節）に基づくが、モーダル内の `name`（`item_name`・`amount`・`comment`・`date`）は
新規登録画面（`/money/new`）と同じだと仮定している。要素が見つからなければ必ず例外にして
「更新する」の手前で止まり、**画面の構造の要約（要素名・ボタン名。値は含めない）をエラーへ添える**
ので、外れたときはその内容で `scripts/edit-modal.mjs` の当て方を直す。


### 編集画面はモーダルにある（aide#409）

**`/money/<moneyId>/edit` を直接開いても、編集UIは出ない。** 実物で確かめた（2026-09-21・#410。
銀行口座・デビットカードの連携明細）。

- 通常のブラウザでも画面は真っ白。コンソールに `ReferenceError: $ is not defined`（インライン
  スクリプト）と `Cannot read properties of undefined (reading 'genres')`（`receipt_edit.tsx`）が出る
- ページに在る入力欄は `#edit-receipt-form`（`action="/receipts/<moneyId>"`・`_method=put`）の
  hidden 値だけ。`window.Receipt` も未定義
- **編集UIは、`/money` 一覧の行の鉛筆アイコンを押すと開く「家計簿の編集」モーダルにだけ在る。**
  鉛筆アイコンは `a[href]` ではなく、行が持つ `data-url="/money/<moneyId>/edit"` で当てる（巡回が
  `id` を読んでいるのと同じ属性）。モーダルには品目の行（品目名・カテゴリ・金額・メモ・行削除×）が
  複数行、合計金額・出金元・全体のカテゴリ・日付・お店・集計、「削除する」「更新する」がある
- **モーダルのボタンは `<form>` に属さない。** 更新は画面のJSが送っている

そのため `edit-genre.mjs`・`edit-memo.mjs`（共通部品は `edit-modal.mjs`）は、

1. 明細の日付の月の一覧（`/money?month=YYYYMM`）を開き、`moneyId` の鉛筆アイコンを押してモーダルを出す
2. 金額が入っている品目の行が**ちょうど1つ**のときだけ、その行を書き換える（空の行は無視。複数品目は止める）
3. 日付・金額が本文と一致するのを確かめてから、カテゴリ／メモだけを触る
4. `dryRun` でなければ、**文言が完全一致する**「更新する」を押す（隣の「削除する」を押さない）
5. モーダルが閉じるのを待ち、一覧を開き直して、行に表示されたカテゴリ・内訳／メモが書いた値と一致するのを確かめる

**`#edit-receipt-form` を直接送信する経路は採用しない。** `Receipt` はレシート単位で `items` を
持つため、画面の送信内容と一致する保証が無いまま送ると、レシート内の全明細を置き換えてしまう
恐れがある。


### 既存明細のメモの書き換え（aide#354）

銀行口座・デビットカードの連携明細は、Zaimの「置き換え」（カード・電子マネーの連携明細にしか
効かない。公式「対象となる履歴」）で置き換えられない。asset-manager の家計簿連携
（asset-manager#514）は代わりに、**その連携明細のメモへ買った物を直接書き込む**。自動連携明細は
公式APIから編集できず、上の `/genre` はカテゴリ・内訳しか触らないため、同じ編集モーダル
（[開き方](#編集画面はモーダルにあるaide409)）から**メモ（`input[name="comment"]`）だけ**を書き換える口を設けた。
[条件3の例外](#既存明細のカテゴリ変更は条件3の例外aide273)であることは `/genre` と同じ。

```bash
curl -sS -X POST http://127.0.0.1:4747/api/zaim/payment/web/memo \
  -H "authorization: Bearer $AIDE_ZAIM_WRITE_SECRET" \
  -H "content-type: application/json" \
  -d '{"requestId":"asset-manager:zaim-memo:5001:<本文の指紋>","moneyId":5001,
       "date":"2026-09-17","amount":1284,"comment":"おにぎり 158円／牛乳 218円"}'
# => {"ok":true,"moneyId":5001,"duplicated":false,"requestId":"asset-manager:zaim-memo:5001:<本文の指紋>"}
```

- `comment` は**必須**。**空文字ならメモを消す**。省略・`null`・文字列以外は400（項目名の取り違えで
  メモが黙って消えるのを防ぐ）
- 上限は `write.ts` の `MAX_TEXT_LENGTH`（100文字）。**超えたら切らずに400**で返す（呼び出し側も
  同じ値で切っている）。メモ欄は1行の入力なので、改行・タブ・制御文字も400
- **`requestId` はメモ本文へ混ぜない。** 新規登録の `composeComment` は二重登録を探す手掛かりとして
  混ぜているが、ここでは利用者が読むメモが汚れるだけで、冪等は記録で足りる
- 取り違えの検知（開いた明細の `date`・`amount` が本文と違えば何も触らず422）・冪等（同じ
  `requestId` は `duplicated: true`）・同時実行のロック・失敗の分類・中継・ステータス
  （400 / 401 / 409 / 422 / 503）は `/genre` と**同じ実装を通る**。冪等の記録も
  `data/zaim-web-genre-edits.json` を共用する（`requestId` の接頭辞が違うので衝突しない）
- 応答まで数十秒かかる。`"dryRun": true`（手元では `ZAIM_WEB_MEMO_EDIT_DRY_RUN=1`）を足すと
  **「更新する」だけ押さず**、取り違えの検知とメモの入力までを試す

**サブPCの受け口は、デプロイ後に再起動しないと新しい経路が開かない。** 受け口は起動時に
経路の表を読み込むため、VPSだけ更新しても中継先が404を返す（呼び出し側 asset-manager は404を
`notImplemented` として扱い、「コピーしてZaimアプリへ貼り付ける」導線に落ちる）。

**モーダル内のメモ欄の位置は、実物では未確認。** 品目行の中の `input[name="comment"]` に在る想定で、
見つからない・複数ある・書いた値が読み直せない場合は「更新する」の手前で止まり、画面の構造の
要約をエラーへ添える。**初めて実アクセスする前に `ZAIM_WEB_MEMO_EDIT_DRY_RUN=1` で当たりを確認する**
（`"submitted":false` が返れば当たっている）。外れたときは `scripts/edit-modal.mjs` の当て方を
実物に合わせて直す。

## コネクタ: ops-dashboard

VPS・サブPCの稼働状況。**AIDEは指標を集めない。** [ops-dashboard](https://github.com/guchi-apps/ops-dashboard)
が既にホスト指標・外形監視・AI/GitHub/1Password の残枠を集約しているため、その読み取りAPIを叩いて
MCPツール（`aide_host_status` / `aide_uptime_monitors` / `aide_service_quotas`）へ畳むだけにしている。

Zaimと違い「公式APIが無いから自分で取りに行く」ケースではなく、**既にある集約をビューへ畳む**
ケースにあたる。ここで指標収集を作り直すと ops-dashboard と二重になる。

```
src/core/connectors/ops-dashboard/
  types.ts   ops-dashboard のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   6本のGETを並行で叩く。1本落ちても他を巻き込まない
src/core/views/ops.ts        しきい値判定と圧縮（summarizeOps は純粋関数。テストはここ）
```

### 経路

両方とも同じVPS上で動くため **localhost で届き、ops-dashboard を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。方式はaide#27と同じ。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_OPS_DASHBOARD_URL` | `http://127.0.0.1:3110` | そのURLへ問い合わせる |
| `AIDE_OPS_DASHBOARD_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

トークンは**認証情報として扱う**。ログにもMCPのレスポンスにも出さない。取得失敗の理由は
HTTPステータスと例外の種別まで丸める（例外の `message` にはURLが載るため）。

**ops-dashboard 側の読み取りAPIは元々ログインセッション必須**で、サーバー間用のトークン認証は
[ops-dashboard#85](https://github.com/guchi-apps/ops-dashboard/issues/85) で追加済み
（`requireSessionOrApiToken`）。

#### 全ソースが 401 になるとき

**トークンは1Password上の1か所を両側から参照している**（#217）。以前はAIDE側にも同じ値を複製して
おり、ずれると6ソースすべてが 401 になっていた（#63）。

| どちら側 | 環境変数 | 1Password |
|---|---|---|
| ops-dashboard（受け） | `OPS_API_TOKEN` | `op://apps/ops-dashboard/ops-api-token` |
| AIDE（送り） | `AIDE_OPS_DASHBOARD_TOKEN` | 同上（提供側を参照する） |

`unavailable` が **1本だけ** 401 なら ops-dashboard 側のルート追加漏れ、**6本すべて** 401 なら
値の不一致か、ops-dashboard 側で `OPS_API_TOKEN` が未設定（未設定だとトークン経路は常に不可）。
1Passwordの正は1か所だが、GitHubのsecretは各リポジトリへ同期した写しなので、値を入れ替えた後に
**片方のリポジトリだけ同期していない**とずれる。

### 返す粒度

「いま異常があるか」に答えられるところまで。**24時間分の履歴・上位プロセス・tmuxセッションの名前や
作業ディレクトリ・全ディスクマウントは返さない。** 生の指標をそのまま渡してもコンテキストを食うだけで
答えは良くならない。詳細を見たいときは ops-dashboard の画面がある。

`problems` に異常が1行ずつ入り、これだけ読めば答えられるようにしている。しきい値は
`src/core/views/ops.ts` の `THRESHOLDS` にまとめてある（残枠の 15% / 35% は ops-dashboard 側の
`remainingTone()` と揃えてある）。

**オフラインのホストでは指標を評価しない。** 最後に受け取った値をそのまま判定すると、落ちる直前の
CPU 100% を「いま高負荷」として報告してしまう。

`ok`（判定できた範囲で異常なし）と `complete`（全ソースを取得できた）は別に返す。1本だけ落ちるケース
（1Password CLIが無い等）は普通に起きるため、全体を失敗にすると「他は正常だった」という情報まで失う。

### MCP層では3本に分ける（#373）

ホスト指標・外形監視・残枠は別々の問いなので、`aide_host_status` / `aide_uptime_monitors` /
`aide_service_quotas` に分けて出している。**ビュー（`summarizeOps`）は1つのまま**で、MCP層が
自分の区画だけを切り出す。3本まとめて呼ばれると ops-dashboard を3回叩くが、localhost への
HTTP GETなので許容する。

**`problems` は `source`（`hosts` / `monitors` / `quotas`）で振り分ける。** 文面で見分けようとすると、
メッセージを書き換えた瞬間に振り分けが黙って壊れる。

**`ok` は区画ごとに判定し直す。** 全体の `ok` をそのまま渡すと、残枠だけを尋ねられたときに
別ホストのディスク逼迫で `false` になり、問いと関係ない理由で「異常あり」と読まれる。


## コネクタ: Asset Manager（月額固定費）

月額固定費（サブスク・保険・税金・分割払いなど）と次の請求日。**AIDEは契約情報を持たない。**
[asset-manager](https://github.com/guchi-apps/asset-manager) が管理しているため（サブスク管理は
asset-manager#491 で旧 subscription-lists から移管。データ移行は#492）、サーバー間参照用の読み取りAPI
（`GET /api/subscriptions`）を叩いて `aide_fixed_costs` に畳むだけにしている。
ops-dashboard と同じ「既にある集約をビューへ畳む」ケース。**参照先は #347 で subscription-lists から付け替えた。**

```
src/core/connectors/asset-manager/
  types.ts   Asset Manager のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   1本のGET。設定・タイムアウト・失敗理由の丸め
src/core/views/money.ts      Zaimのキャッシュと合わせて畳む（summarizeFixedCosts は純粋関数。テストはここ）
```

### 経路

認証・宛先は MCP の `asset_manager_*` ツール（取り込み・サブスクの読み書き）と同じで、
**新しい環境変数・secret は要らない**。`fetch` しか使わないので実行時依存も増えない。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_ASSET_MANAGER_URL` | `https://asset.gucchii.com` | そのURLへ問い合わせる |
| `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

シークレットは Asset Manager 側の `ZAIM_SYNC_SECRET` と**同じ値**で、**認証情報として扱う**。
取得に失敗しても Zaim 由来の残高・保有銘柄は従来どおり返す。失敗の理由はHTTPステータスと例外の
種別まで丸める（例外の `message` にはURLが載るため）。

**Asset Manager → AIDE → Asset Manager と往復する。** Asset Manager の Zaim 連携は AIDE の
`GET /api/money/summary` を読み（残高だけが目的）、そのレスポンスに固定費が含まれるため、AIDE は
そのたびに Asset Manager の `GET /api/subscriptions` を叩く。再帰にはならないが、固定費の取得の
制限時間は Asset Manager 側の待ち時間（10秒）より短い5秒にしてある。

### 計算はしない

月額換算・次回請求日・契約状況・円換算は**相手が計算済みで返す**。月末クランプ（`billingDay=31` の2月）・
料金改定履歴の期間切り替え・請求サイクルの判定は向こうの `lib/subscription-billing.ts` にあり、こちらで
再実装すれば必ずズレる。仕様は asset-manager の `docs/subscriptions.md`。

**基準日は相手が決める**（レスポンスの `asOf`。JST）。旧 subscription-lists と違い、こちらから渡さない。

### 返す粒度と、totals へ足さない理由

通貨別の月額合計・**支払方法別の月額合計**・契約ごとの明細（区分・契約状況・支払方法つき）・
**31日以内の支払予定**まで。契約IDやラベル・料金改定の履歴は返さない（それは `asset_manager_subscriptions`）。

**固定費はサブスクだけではない。** Asset Manager の契約には区分（`SUBSCRIPTION` / `INSURANCE` /
`TAX` / `INSTALLMENT` / `OTHER_FIXED_COST`）があり、旧 subscription-lists にはなかった保険・税金・
分割払いも「毎月出ていく額」にあたるため含める。明細の `category` で区別できる。相手の
`summary.monthlyTotalJpy` はサブスク区分だけの集計なので使わず、全区分の `summary.fixedCostMonthlyTotalJpy` を
円換算の合計（`monthlyJpy`）に使う。**円換算できない契約（`summary.excludedFromTotal`）が1件でもあれば
`monthlyJpy` は null にする**（部分的な合計を返すと、実際より少ない額が固定費として読まれるため）。

通貨別の合計と支払方法別の合計は相手の集計に無いため、**AIDE側で明細から積み上げている**
（`summarizeByCurrency` / `summarizeByPaymentMethod`）。**通貨をまたいで加算せず**、支払方法別は支払方法と
通貨の組で束ねる。積み上げの都合で浮動小数の誤差が出るため小数2桁へ丸めている。

「次にいくら払うか」（`upcoming` の `amount`）は1回あたりの請求額、明細の `monthlyAmount` は月あたりの
換算額で、**別物**（年払い・3ヶ月ごとの契約があるため）。

契約状況（`contractStatus`）は既定で解約済み（`ENDED`）が取得対象から外れるため、実質
`AUTO_RENEWING` / `SCHEDULED_TO_END` の2値になる。その旨は `note` に添えている。

`MoneySummary.totals`（残高・保有銘柄）へは**足さない**。あちらは「いま持っている額」（ストック）で
固定費は「毎月出ていく額」（フロー）にあたり、同じ合計に混ぜると意味が壊れる。

**MCP層でもストックとフローで分けている**（#373）。`aide_balances` が残高・保有銘柄、
`aide_fixed_costs` が月額固定費を返す。問いが別なだけでなく、分けたことで残高だけを尋ねられた
ときに Asset Manager を叩かなくなり、固定費だけを尋ねられたときにZaimのキャッシュを
読まなくなった。**読み取りAPI（`GET /api/money/summary`）は両方を合わせた1本のまま。**

通貨は `JPY` / `USD` の混在を許すため、**合計は通貨別**で返す。円換算値（`monthlyJpy`）は相手が
Frankfurter のレートで計算した参考値で、取得できていなければ `null` になる。

**動作状況（`/api/status` のチェック名・接続先の設定状況）の名前は `asset-manager`。**
以前は `subscription-lists` だった。ops-dashboard 側でこの名前を使っている場合は追従が要る。


## コネクタ: myroom

いまの部屋の状態（室温・湿度・気圧・CO2・照度とエアコンの運転状態）。**AIDEはセンサーの値を
集めない。** [myroom](https://github.com/guchi-apps/myroom) が Raspberry Pi からの受信・保存・
鮮度判定まで持っているため、サーバー間参照用の読み取りAPI（`GET /api/internal/room-state`）を
叩いて `aide_room_sensors` と `aide_aircon_status` へ畳むだけにしている。
ops-dashboard・Asset Manager と同じ「既にある集約をビューへ畳む」ケース。

```
src/core/connectors/myroom/
  types.ts   myroom のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   1本のGET。設定・タイムアウト・失敗理由の丸め
  control.ts 照明などの操作（ボタンの一覧と押す。aide#317）
  aircon-control.ts エアコンの操作（状態の読み取り・運転指示・入力の検証。aide#316）
src/core/views/room.ts       しきい値判定と圧縮（summarizeRoom は純粋関数。テストはここ）
src/core/views/printer.ts    3Dプリンターの正規化と鮮度判定（後述。aide#378）
```

### 経路

両方とも同じVPS上で動くため **localhost で届き、myroom を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_MYROOM_URL` | `http://127.0.0.1:8000` | そのURLへ問い合わせる |
| `AIDE_MYROOM_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |
| `AIDE_MYROOM_CONTROL_TOKEN` | 操作ツールは「未設定」を返し、myroom へ何も送らない | 操作用の内部APIを `Authorization: Bearer` で叩く |

トークンは相手側の内部APIキーと**同じ値**で、**認証情報として扱う**。1Passwordでは値を複製せず
提供側の `op://` をそのまま参照する（#217）。失敗の理由はHTTPステータスと例外の種別まで丸める
（例外の `message` にはURLが載るため）。

**myroom の読み取りAPIは元々 Supabase のユーザーログイン必須**で、サーバー間から読める口が無い。
内部APIは [myroom#161](https://github.com/guchi-apps/myroom/issues/161) で追加する。**未実装の
バージョンに対しては 404 が返り、`unavailable` に「内部APIが未実装のバージョン」として出る。**

### 照明などの操作（aide#317）

操作そのものは myroom が持っている（`backend/remote.py`。Nature Remo へ赤外線の送信を依頼する）。
**AIDEは Nature Remo を直接叩かず、myroom の画面で登録済みのボタンをIDで押すだけにする。**
直接叩くとボタンの定義・表示名が myroom と二重になり、Nature Remo のレート制限（30回/5分）も
両者で食い合う。**このツールの対象は Nature Remo のボタンだけ**で、エアコン（白くまくん）の操作は
別のツール（[エアコンの操作](#エアコンの操作aide316)）。

| myroom の内部API | 使うツール |
|---|---|
| `GET /api/internal/remote/buttons` | `aide_room_buttons`（`aide_room_press` も押す前に引く） |
| `POST /api/internal/remote/buttons/{id}/send` | `aide_room_press` |

どちらも `INTERNAL_CONTROL_API_KEY`（AIDE側は `AIDE_MYROOM_CONTROL_TOKEN`）で通る、操作専用の口で
[myroom#419](https://github.com/guchi-apps/myroom/issues/419) で追加する。**未実装のバージョンに対しては
404 が返り、`unsupported` として出る。**

誤操作は次の3つで防ぐ。

- **IDと名前の両方を受け取り、押す直前に myroom の今の登録と突き合わせる。** 一致しなければ押さずに
  `mismatch` を返す。Claudeが取り違えたIDや、myroom側で登録し直されたIDをそのまま押さないため
- **同じボタンを30秒以内に続けて押さない**（`allowRepeat: true` で明示したときだけ押す）。赤外線の
  「電源」のようなトグルは2回押すと元に戻るため、再試行で利用者の意図と逆の状態になる
- **押す前に、押すボタンの名前を利用者に確認する**よう、ツールの説明文でClaudeに求める

**結果は「myroom が Nature Remo へ送信を依頼できたか」まで。** 赤外線は片方向で、機器が反応したかは
返ってこない（myroom#106）。応答を待ちきれなかったときは送れたか分からないため `unknown` を返し、
再送せずに利用者へ確かめるよう案内する。照明なら `aide_room_sensors` の照度の変化でも確かめられる。

### エアコンの操作（aide#316）

操作そのものは myroom が持っている（`backend/aircon_control.py`。白くまくん〔AirCloud Home〕へ運転指示を
送る）。**AIDEは白くまくんへ直接繋がず、サインインもトークンの更新も持たない。** 直接叩くと、ログイン状態・
レート制限（429）の管理が myroom と二重になり、資格情報がもう1か所に増える。

| myroom の内部API | 使うもの |
|---|---|
| `GET /api/internal/aircon/units/{ac_id}/state` | `aide_aircon_control`（送る前の状態と、送った後の読み戻し。**DBではなく白くまくんから直接読む**） |
| `POST /api/internal/aircon/units/{ac_id}/control` | `aide_aircon_control`（受けるのは電源・運転モード・設定温度・風量の4項目だけ） |

どちらも照明の操作と同じ `INTERNAL_CONTROL_API_KEY`（AIDE側は `AIDE_MYROOM_CONTROL_TOKEN`）で通る。
**契約は AIDE 側で先に決めた**（[myroom#439](https://github.com/guchi-apps/myroom/issues/439) の実装より前）。
**myroom が未実装のバージョンなら 404 が返り、何も送らずに `unsupported` として止まる。**
**リリースは myroom → AIDE の順**（AIDE を先に出しても、安全に失敗するだけで何も送らない）。

誤操作は次で防ぐ。

- **`acId` と名前の両方を受け取り、送る直前に myroom の今の状態と突き合わせる。** 一致しなければ
  送らずに `mismatch` を返す。名前は `aide_aircon_status` の値をそのまま渡す
- **オフライン（`online: false`）のエアコンには送らない。** 送っても反映されないのに、成功に見える
- **今と同じ値なら送らない**（`changed: false`）。絶対値で指定するので二重に送っても結果は変わらないが、
  送れたか分からない状況での再試行が白くまくんの回数制限を食うだけになるため
- **設定温度は16〜32℃の0.5℃刻みだけを受け、丸めない。** 27.3 を 27.5 にして送ると頼んだ値と違う
- **自動運転（`AUTO`）では設定温度を受けない。** 自動運転の「設定温度」は室温からのシフト量で意味が違う。
  自動運転との行き来で温度の指定が無いときは、myroom が既定値へ置き換える旨を `warning` で返す
- **送る前に、対象の名前と変更内容を利用者へ伝えて確認を取る**よう、ツールの説明文でClaudeに求める。
  迷うときは `dryRun` で「変更前→変更後」だけを見られる

**結果は「送れたか」と「指定どおりの状態になったか」を分けて返す。** 送信後に状態を読み戻し、
`readback.matches` に一致の有無を入れる。**`false` でも失敗とは限らない**（白くまくんの反映に時間がかかる
ことがある）ので、再送せずしばらくしてから確かめるよう案内する。応答を待ちきれなかったときは送れたか分からない
ため `unknown` を返し、再送しない。応答の `before` は変更前の状態で、間違えたときはその値で元に戻せる。

### 鮮度と判定

**センサーの鮮度判定・気圧オフセットの適用・デバイスの表示名は myroom 側が持っている。**
こちらで再実装すれば必ずズレるため、判定済みの値を受け取る（しきい値は `staleThresholdMinutes`
として一緒に返る）。

**受信が止まっているセンサー（`stale`）の値は判定に使わない。** 数日前に止まったセンサーの32℃を
「いまの室温」として報告してしまうため（ops ビューがオフラインのホストを評価しないのと同じ）。
値そのものは残すので、後から見れば何度で止まったかは分かる。

快適域のしきい値は `src/core/views/room.ts` の `THRESHOLDS` にまとめてある（CO2の1000ppmは
建築物衛生法の管理基準）。

### 返す粒度

「いま部屋がどうなっているか」に答えられるところまで。**履歴・日別統計・記録の一覧は返さない。**
生の時系列を渡してもコンテキストを食うだけで答えは良くならない（詳細は myroom の画面がある）。

**キャッシュを挟まない。** 部屋の状態は鮮度そのものが価値であり、ジョブ間隔ぶん古くなると
「いま暑いか」に答えられなくなる（README「どこまでを『重い取得』とみなすか」の右側）。

### MCP層では2本に分ける（#373）

測定値（`aide_room_sensors`）とエアコン（`aide_aircon_status`）は別の問いなので分けている。
「エアコンはついているか」に答えるだけで全センサーの値と屋外との対比まで返るのは過剰だった。
ビュー（`summarizeRoom`）は1つのままで、`problems` は `source`（`sensors` / `aircons`）で
振り分ける（ops と同じ立て付け）。

**操作（`aide_room_buttons` / `aide_room_press`）とは別**。読み取りと書き込みを畳むと、
クライアント側で「常に許可」にしたときに操作まで素通しになる。


## コネクタ: 3Dプリンター（myroom経由。#378）

3Dプリンター（Bambu Lab A1 mini）の進捗・残り時間・完了・エラー。**AIDEはプリンターへ直接繋がない。**
サブPCの常駐プロセスがLAN内のローカルMQTTから状態を集め、[myroom](https://github.com/guchi-apps/myroom)
が正規化して内部API（`GET /api/internal/bambu/printer`）で返す（myroom#428）。AIDEはそれを
`aide_printer_status` へ畳み、状態遷移を Signaly へ通知する。Bambu のシリアル番号・アクセスコード・
ホストは**myroomのサブPC側にしか無く、AIDEは持たない**。

```
src/core/connectors/myroom/index.ts   fetchPrinterState（room-state と同じ通信・同じ AIDE_MYROOM_TOKEN）
src/core/views/printer.ts             正規化と鮮度判定（summarizePrinter は純粋関数。テストはここ）
src/mcp/tools/printer.ts              aide_printer_status
src/worker/jobs/printer-watch.ts      状態遷移の見張り（2分ごと）
src/worker/printer-notify.ts          遷移の判定（decidePrinterEvents）と通知本文
deploy/systemd/aide-printer-watch.*   サブPCの systemd timer
```

### 読んでいる応答（myroom `bambu.build_response()`）

#378 の着手時点では myroom#428 が計画段階で、AIDE は `room-state` の流儀で `/api/internal/printer-state` を
期待する形として先に決めていた。**myroom はパスも形も別に実装した（myroom#428 → #430）ため、AIDE 側を
myroom の実装に合わせ直した（#401）。** 型は `src/core/connectors/myroom/types.ts` の `MyRoomPrinterSnapshot`。
正本は myroom の `backend/bambu.py`（`build_response()` と `build_snapshot()`）。

```jsonc
// GET /api/internal/bambu/printer  （Authorization: Bearer <AIDE_MYROOM_TOKEN>）
{
  "fetchedAt": "2026-09-21T12:00:00+09:00",
  "staleThresholdSeconds": 180,       // 収集が止まったとみなす秒数（無ければAIDEは180秒）
  "configured": true,                 // 収集から一度でも届いているか
  "connection": "online",             // no_data / collector_stale / printer_offline / online
  "online": true, "stale": false,
  "lastUpdateAt": "2026-09-21T11:59:40+09:00",  // 収集から最後に受信した時刻（収集は毎分送る）
  "ageSeconds": 20,
  "lastMessageAt": "2026-09-21T11:59:10+09:00", // プリンターから最後にメッセージを受けた時刻
  "messageAgeSeconds": 50,
  "printer": null | {                 // online のときだけ入る
    "state": "printing",              // idle / preparing / printing / paused / finished / failed / unknown
    "rawState": "RUNNING",            // Bambu の gcode_state
    "job": { "name": "benchy.3mf", "progressPercent": 42, "layer": 84, "totalLayers": 200,
             "remainingMinutes": 35, "estimatedFinishAt": "2026-09-21T12:34:10+09:00" },
    "nozzle": { "temperature": 219.6, "target": 220 },
    "bed": { "temperature": 59.8, "target": 60 },
    "speed": { "level": 2, "mode": "standard" },  // silent / standard / sport / ludicrous
    "ams": { "connected": true, "units": [{ "id": 0, "humidity": 4,
             "slots": [{ "slot": 0, "empty": false, "material": "PLA", "color": "#FF0000", "remainPercent": 80 }] }] },
    "errors": { "printError": null | { "code": "0300_4001" },
                "hms": [{ "code": "HMS_0300_0100_0001_0007", "severity": "serious" }] }
  },
  "lastKnown": null | { /* printer と同じ形。online でないときだけ入る最後の値 */ }
}
```

AIDE が畳むときの読み方:

- **現在値は `printer` からしか作らない。`lastKnown` を現在値として読むことはしない。** 読むと、電源が
  切れる前の「完了」や古い進捗から、いま完了したと誤検知する
- 値の時刻（`measuredAt`・`lastKnown.asOf`）は `lastMessageAt`（無ければ `lastUpdateAt`）。終了予測は
  myroom の `estimatedFinishAt` を使い、無ければその時刻＋残り時間から求める
- エラーは `printError` と、`severity` が `fatal`・`serious` の HMS だけを数える（myroom の通知と同じ線引き。
  `common`・`info` で「エラーが発生」と鳴らさない）
- AMS Lite はユニットをまたいでスロットを1列に並べる（A1 mini の AMS Lite は1台）

読み取り専用の内部APIで、`room-state` と同じ `INTERNAL_API_KEY`（AIDE側は `AIDE_MYROOM_TOKEN`）で通る。
新しい資格情報も環境変数も足していない。**未実装のバージョンに対しては404が返り、ツールは
「内部APIが未実装のバージョン」を `unavailable` に入れて返す**（例外にしない）。

### 鮮度：古い値を現在の状態として答えない

プリンターは電源を切れば黙って消える。myroom が最後に受け取った「印刷中 75%」をそのまま返すと、
電源が切れた後も「まだ印刷中で、あと12分」と答え続ける。**ツールは必ず鮮度を返し、`fresh` でない
ときは現在の値（`printer`）を空にする。**

| `freshness` | 意味 | `printer` | `lastKnown` |
|---|---|---|---|
| `freshness` | myroom の `connection` | 意味 | `printer` | `lastKnown` |
|---|---|---|---|---|
| `fresh` | `online` | プリンターに繋がっていて、収集からの最終受信がしきい値以内 | **入る** | なし |
| `stale` | `collector_stale` | 収集からの受信が途絶えている（サブPCの常駐停止・ネットワーク断） | null | 最後に確認できた値（`asOf` 付き） |
| `disconnected` | `printer_offline` | 収集は生きているが、プリンターに繋がっていない（電源断など） | null | 同上 |
| `unknown` | 上記以外・時刻が読めない | 新しいか判断できない | null | なし |
| `never` | `no_data` | 収集が一度も届いていない | null | なし |

- **`online` でも、AIDEが `lastUpdateAt` から数え直した経過秒が `staleThresholdSeconds` を超えていれば `stale`。**
  片方だけを信じると、どちらかの時計・判定のずれがそのまま「古い値を現在値」にする
- **`lastKnown` には残り時間・終了予測・温度を入れない。** 時間が経てば意味を失い、現在値と読み違えやすい。
  入れるのは状態・ジョブ名・進捗・エラーだけで、`asOf`（その時刻時点の値）を必ず添える
- 完了・待機・失敗では `remainingMinutes` / `estimatedEndAt` を返さない（「あと何分」の材料にしない）
- `complete: false` は「取得そのものができていない」（myroom未対応・トークン不一致・未設定）で、
  プリンターが止まっていることとは別。どちらも例外にはせず、理由を添えて状態として返す

**キャッシュを挟まない。** 進捗も完了も鮮度そのものが価値で、ジョブ間隔ぶん古くなると「終わったか」に
答えられなくなる（README「どこまでを『重い取得』とみなすか」の右側）。

### 状態遷移の通知（`printer-watch`）

サブPCの systemd timer が2分ごとに `printer-watch` を走らせ、myroom の内部APIを読んで前回の記録と
比べ、次の3つだけを Signaly へ送る（通知の基盤は[ジョブ失敗の通知](#ジョブ失敗の通知)と同じ）。

| 通知 | 条件 |
|---|---|
| 印刷が完了 | 状態が変わって `finished` になった |
| 印刷が停止 | 状態が変わって `failed` になった（Bambuは利用者が中止したときも `FAILED`） |
| エラーが発生 | 前回通知していない新しいエラーが現れた（一時停止を伴うことが多い） |

- **初回は通知せず基準だけ作る。** 昨日終わった印刷の「完了」を導入した瞬間に送らないため
- **進捗の実況・印刷開始・エラーを伴わない一時停止は通知しない。** 毎回送ると完了・失敗が埋もれる。
  エラーが続いている間は再送せず、消えたあとに同じエラーが起きればまた送る
- **鮮度が切れている間は何もせず、記録も進めない。** 電源が入っていない間の「最後の値」から遷移を
  作らない。切れている間に印刷が終わっていれば復帰後に「完了」が1回届く（本文に「プリンターの最終更新」と
  「検知時刻」を並べるので、遅れは読み取れる）
- **送れなかったときは記録を進めず、ジョブを失敗させる。** 進めるとその遷移は二度と通知されない。
  次の実行で送り直し、失敗はジョブ失敗として記録・通知される
- 記録は `data/worker/printer-watch.json`。**状態・エラーの署名・時刻だけ**で、取得した値もジョブ名も残さない

**通知は状態の変化を送るだけで、ポーリングの取りこぼしは埋めない。** 2分より短い印刷や、2分の間に
`finished` を経ずに次の印刷が始まった場合は通知されない（Bambu は `FINISH` を次のジョブまで保つため、
通常は起きない）。

### 認証情報を出さない

- **接続情報（ホスト・シリアル番号・アクセスコード）は型に宣言していない。** 正規化は列挙した項目だけを
  写すため、myroom が誤って余計な項目を返しても、応答・ログ・通知には出ない（`printer.test.ts`）
- 文字列は長さを切り詰める（ジョブ名120・エラー本文200など）
- 失敗理由はHTTPステータスと例外の種別まで丸める（既存のmyroomコネクタと同じ。例外の `message` にはURLが載る）
- トークン（`AIDE_MYROOM_TOKEN`）は応答・ログ・通知に出さない

### 設定とリリース順

`printer-watch` は**サブPCで動き、myroom の公開URLを読む**（VPSの `127.0.0.1` には届かない）。
ツール（`aide_printer_status`）はVPSのサーバーが読むので、既定のlocalhostのままでよい。

| 場所 | 設定 |
|---|---|
| VPS（サーバー） | 追加なし。既存の `AIDE_MYROOM_TOKEN` をそのまま使う |
| サブPCの `~/apps/aide/.env` | `AIDE_MYROOM_URL`（myroom の公開URL。`https://myroom.gucchii.com`）・`AIDE_MYROOM_TOKEN`（myroom の `INTERNAL_API_KEY` と同じ値）・`AIDE_SIGNALY_WEBHOOK_URL`（既存） |

**リリース順は myroom#428 が先。** myroom が `main` で `bambu/printer` を返す状態（v4.18.0 以降）で、
かつ AIDE の #401 が `main` へ出てから、サブPCの `.env` を設定し、`aide-printer-watch.timer` を有効にする
（guchi-apps/subpc#108）。順序が逆だと、ツールは「内部APIが未実装」を返すだけで壊れないが、`printer-watch` は404で失敗し続ける
（[ジョブ失敗の通知](#ジョブ失敗の通知)が6時間に1回まで送る）。

**ユニットの配置と有効化はサブPCのリポジトリ（`guchi-apps/subpc`）の `setup.sh` が持つ**
（`SYSTEMD_USER_UNITS` に `aide-printer-watch.timer` を足す。手で `cp` しない。[systemdユニット](#systemdユニット)）。
このリポジトリが持つのはユニットの実体（`deploy/systemd/aide-printer-watch.*`）だけ。

### MCP層では1本にしている

進捗・残り時間・完了・エラー・温度・レイヤー・AMS Lite は、同じ1台の同じ時点の値で、どれを尋ねられても
同じ鮮度の確認が要る。分けると確認を何度も要求することになるため、`aide_printer_status` 1本にしている
（#373の「1つの問い」は「3Dプリンターはいまどうなっているか」）。部屋の温度・CO2（`aide_room_sensors`）とは
問いが違うので別ツールで、説明文で互いを名指ししている。**プリンターを操作する口（印刷の開始・停止・
一時停止）は持たない。**


## コネクタ: DaySpan（予定・タスク・日付リマインド・移動）

今日・今週の予定と空き時間。**AIDEはGoogleカレンダーへ直接繋がない。**
[DaySpan](https://github.com/guchi-apps/dayspan) が Google Calendar の予定・Notion のタスクと
日付リマインド・移動を1つのカレンダーへ統合済みなので、サーバー間参照用の読み取りAPI
（`GET /api/internal/schedule`）を叩いて `aide_schedule` の予定に畳む。
ops-dashboard・Asset Manager・myroom と同じ「既にある集約をビューへ畳む」ケース。

```
src/core/connectors/dayspan/
  types.ts   DaySpan のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   1本のGET。設定・タイムアウト・失敗理由の丸め
src/core/views/schedule.ts    返す粒度への圧縮と空き時間の算出（純粋関数。テストはここ）
```

### Googleカレンダーの認可をAIDEへ持ってこない（aide#173）

取得処理をAIDEへ寄せる案（asset-manager の Zaim と同じ寄せ方）は採らなかった。**DaySpanは
Google Calendar API用のリフレッシュトークンをAES-256-GCMで暗号化して自前DBに保持している**
（向こうのREADME「認可の分離」）。AIDEへ同じ認可経路をもう1本作ると、OAuthクライアント・
同意画面・トークンの失効と再認可を**2か所で面倒を見る**ことになる。

「AIDEにGoogleのコネクタを足す」が起点のIssueだったが、**予定については足す必要が無かった**
（aide#173 のコメント）。読み取りAPIで繋いでおけば、必要になった時点で寄せられる。

### 経路

両方とも同じVPS上で動くため **localhost で届き、DaySpan を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_DAYSPAN_URL` | `http://127.0.0.1:3113` | そのURLへ問い合わせる |
| `AIDE_DAYSPAN_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

トークンは相手側の `INTERNAL_API_KEY` と**同じ値**で、**認証情報として扱う**。1Passwordでは値を
複製せず提供側の `op://` をそのまま参照する（#217）。失敗の理由はHTTPステータスと例外の種別まで
丸める（例外の `message` にはURLが載るため）。

**タイムアウトは8秒**と、他のコネクタ（3秒）より長い。DaySpanの内部APIは受けたリクエストの中で
Google Calendar と Notion を叩くため、localhost で完結する相手と違って外部サービスの応答時間が
そのまま乗る。短く切りすぎると、相手が正常でも毎回タイムアウトになる。

### 日付はDaySpanに解釈させる

**基準日を渡さなければ、DaySpanが利用者の設定タイムゾーン（既定 `Asia/Tokyo`）で「今日」を決める。**
VPSのタイムゾーンはUTCだが、呼び出し側でJSTの日付を作る必要はない（Asset Manager の `asOf` と
同じく、相手が決める）。

**朝のブリーフィングからは日付を明示して渡している。** あちらは自分でJSTの暦日を決めており、
省略すると schedule だけ別の日を返しうるため。

時刻は DaySpan が設定タイムゾーンで描いた `HH:MM`（`startTime` / `endTime`）をそのまま使う。
**AIDE側で時差を足し引きしない。** 解釈し直すと、DaySpanの画面で見た時刻と食い違う。

### 空き時間はAIDE側で算出する

DaySpanは表示用のアプリで、空き時間という概念を持たない。**そのため `freeSlots` だけはこちらの
計算**にあたる（`src/core/views/schedule.ts` の `computeFreeSlots`。純粋関数）。

| | 扱い |
|---|---|
| 数える時間帯 | 既定 08:00〜22:00（`freeFrom` / `freeTo` で変えられる）。夜中を空きとして数えても答えが良くならない |
| 塞ぐもの | 時刻の決まった予定と移動 |
| 塞がないもの | **終日の予定**・時刻の無いタスク。時間帯を持たないものを塞ぐと1日が丸ごと埋まり、答えが常に「空きなし」になる |
| 最小の長さ | 30分。これより短い隙間は移動と準備で消える |
| 日付をまたぐ予定 | 終了が開始より前のものは、その日の窓の終わりまでとして扱う（翌日へ持ち越すと、DaySpanの日ごとの振り分けと食い違う） |

終日の予定を無視したことに気づけるよう、`allDayCount` を日ごとに併せて返している。

### 「予定が無い」と「取得できていない」を混ぜない

DaySpanは**部分的な失敗をHTTP 200のまま `errors` に載せてくる**（Notionが落ちていても、取れた
Googleの予定は返す）。握りつぶすと「予定が無い日」として読まれるため、`unavailable` へそのまま
持ち上げて `complete: false` にする。

**Google未接続・NotionのDB未設定は `errors` に出ない。** DaySpan側で「失敗」ではないためで、
該当する配列が空のまま返る。これだけでは「今日は何も無い」と区別が付かないので、連携そのものの
状態（`sources.googleConnected` 等）を併せて返し、`note` にも断りを入れる。

### 返す粒度

予定は件名・時間帯・場所・カレンダー名・繰り返しの有無・**中止／不参加の記録（`outcome`）・本文
（`description`）**まで（#388）。

**`outcome` は `CANCELED`（予定そのものが無くなった）・`ABSENT`（予定は行われたが自分は行かなかった）・
null。** DaySpanは記録の付いた予定を落とさず返す（黙って消すと「予定が無かった」ことになるため）ので、
AIDEも一覧から消さず、そのまま持ち上げる。aide-bot が「キャンセルになったのか」を判断できるように
するためのもの。**中止・不参加の予定は `freeSlots`・`busyMinutes` を塞がない**（流れた打ち合わせの
時間は実際には空いている）。DaySpanが将来 `outcome` の種類を増やしても、null 以外は「起こらない予定」
として同じに扱う。

**本文は300文字で切って返す**（超えた分は末尾が `…`）。以前は「予定の中身を読み上げるツールではない」
として返していなかったが、キャンセルの有無や補足がメモにしか書かれていない予定があるため、
コンテキストを食わない長さに切って載せる形に改めた。

**返らないもの。** 中止・不参加にした**理由のメモ**（DaySpanの `EventOutcome.note`）と、Googleの
出欠（`responseStatus`）は、DaySpanの内部APIが持ち出していないため返らない。必要になったら
DaySpan側に足す。Notionのタスク・日付リマインドの `memo` も同じく載せていない。

期限切れタスク（`overdueTasks`）は**既定で取りにいかない**（`includeOverdueTasks: true` のときだけ）。
遡るとNotionへの往復が1回増えるうえ、半年前に期限が過ぎたタスクを読み上げても行動は変わらない。

一度に返す日数は**14日まで**に切る（DaySpan側の上限は31日）。

## コネクタ: GitHub

各リポジトリの開発状況。ClaudeアプリにはGitHubのコネクタが無い（接続済みは Notion・Gmail・
Googleカレンダー・Googleドライブ・AIDE）ため、GitHubは「Core と MCP層の境界」でいう
**公式MCPが無いもの**にあたる。Zaimと同じ位置づけ。

```
src/core/connectors/github/
  types.ts   GraphQLレスポンスのうちAIDEが使うフィールドだけ再宣言
  query.ts   クエリ。取得内容は RepoStatus フラグメント1つに集約している
  index.ts   POST /graphql と、失敗理由の丸め
src/core/views/dev.ts        対象の選別と圧縮（summarizeDev は純粋関数。テストはここ）
```

### AIDEを唯一の取得口にはしない

GitHub取得は既に3実装ある。**AIDEはこれらを置き換えない。**

| リポジトリ | 用途 |
|---|---|
| `issue-deck` | GitHub Appでの認証、Issue/PR操作、Actions、webhook。**書き込みを伴う** |
| `ops-dashboard` | Actions残枠 |
| `portfolio` | 公開用のリポジトリ情報取り込み |

issue-deck はGitHub Appの認証・webhook受信・書き込みが本体で、AIDE経由にすると往復が増えるだけ。
AIDEが持つのは読み取りのビューと、下記のIssue起票だけに限る。

### GitHubへの書き込みはIssueの起票1本だけ

外出先でClaudeアプリに思いついたことを話し、そのままIssueにしたいという要望
（guchi-apps/question#15）に対して `aide_create_issue` を持つ（aide#50）。

**Claudeアプリからの経路だけが塞がっていた**ため入れたもの。Claude Code（端末・GitHub Actions）は
`gh issue create` で起票できるが、issue-deck はMCPサーバーを持たず `POST /api/issues` は
Cookie認証のため、Claudeアプリから叩けるものが1つも無かった。「責務」の3条件を満たす。

- **作成だけ。** 編集・close・コメント・PR操作は持たない。issue-deck の画面と Claude Code の仕事
- **トークンを分ける。** 取得用の `AIDE_GITHUB_TOKEN` はRead-onlyのままで、起票は
  `AIDE_GITHUB_ISSUE_TOKEN`（Issues: Read and write）を使う。フォールバックはしない
- **AIDEが起票してもissue-deckと食い違わない。** issue-deck は webhook で GitHub 側の Issue を
  取り込むため、どちらから作っても同じように画面へ出る
- **暴発を機械的に止める。** Claudeは会話の流れでツールを自発的に呼ぶため、1回の呼び出しで1件・
  1時間あたり100件・直前と同一タイトルは拒否、という上限をコード側に持つ（`write.ts`）。
  当初は10分あたり3件だったが、起票したIssueは既定で `70.needs-decision` が付き実装へ自動では乗らない
  ため、まとめて起票できるよう緩めた（#319）
- **ラベルを勝手に作らない。** GitHubのIssue作成APIは未知のラベル名を渡すとラベルごと新規作成
  してしまう。起票前に対象リポジトリのラベル一覧を引き、実在するものだけを付ける
  （既定は `70.needs-decision`。無いリポジトリでは落ちる）。落としたラベルがあったときは、
  実在するラベル名を `availableLabels` に添えて返す（下記「起票に使うラベルの候補」）
- **既定ラベルが落ちたら、起票は止めずに `warning` で知らせる**（#382）。既定ラベルは「人が判断する
  まで無人実行へ乗せない」ガードで、外れたまま黙って起票すると無人実行が着手し得る。ラベル体系の
  改名（`70.needs-decision` への改名）では、落ちた事実が `droppedLabels` に載るだけで誰も
  気づけなかった。起票を止めないのは、ラベル一覧が引けないときや issue-deck を使わないリポジトリで
  何も起票できなくなるのを避けるため。`warning` は `labels` を省略した（既定ラベルの）起票のときだけ
  返し、サーバーのログにも残す。アプリ連携画面（`POST /map/issue`）は、付いた旨の代わりに
  「付けられなかった」旨を出す
- **出所を本文に残す。** 口述の書き起こしは人が自分で書いたIssueと精度が違うため、本文末尾に
  AIDE経由で起票した旨と `<!-- aide:created-via-mcp -->` を必ず付ける

### 返す粒度

**状態の俯瞰まで。ソースコードやREADMEの本文は返さない**（aide#32 で確定）。ファイル取得の
ツールは追加しない。返す量が大きくなるうえ「MCP層は狭く」の方針とぶつかる。コードの詳細は
Claude Code（CLI）とissue-deckが担当する。

取得のツールは**3本**（`aide_dev_status` / `aide_repo_status` / `aide_repo_labels`）。
以前は `aide_dev_status` 1本で、引数 `repo` の有無で「全体の俯瞰」と「1リポジトリの詳細」を
切り替えていたが、**同じツールが答えの形ごと変わる**うえ、起票に使うラベルの候補が欲しいだけの
ときにもコミット・Issue・Pull Request の一覧まで返っていた。#373 で問いの単位へ分けた
（起票の `aide_create_issue` は上記「GitHubへの書き込みはIssueの起票1本だけ」）。

**3本とも取得は `buildDevStatus()` 1つを共有する。** 詳細モード（`repo` 付き）は
GitHubへのGraphQLを1回叩き、`aide_repo_status` と `aide_repo_labels` は返す区画だけが違う。

`attention` に注意点が1行ずつ入り、これだけ読めば答えられるようにしている。しきい値は
`src/core/views/dev.ts` の `DEFAULTS` にまとめてある。

### 起票に使うラベルの候補

`repo` を指定して呼んだときだけ、そのリポジトリに定義されているラベル（名前・色・説明）を
`detail.labels` に返す（aide#122）。Claudeアプリから `aide_create_issue` を呼ぶとき、
**どのラベルが実在するかを知る手段が無かった**ため。実在しない名前は起票時に黙って落ちるので、
知らないまま渡すと「付けたつもりのラベルが付いていない」だけの結果になる。

**ラベルは専用のツール（`aide_repo_labels`）で返す**（#373）。もとは詳細モードの一部
（`detail.labels`）として返しており、ラベルの候補が欲しいだけのときにもコミット・Issue・
Pull Request の一覧が付いてきた。起票の前段としては重すぎるため分けた。
取得そのものは詳細モードと同じクエリを使う。

- **クエリはフラグメントの外に置く**（`query.ts` の `DEV_REPO_QUERY`）。共有すると俯瞰でも
  26リポジトリぶんのラベルが返り、要らない情報でレスポンスが数倍になる
- 名前と説明はGitHubの表記のまま返す（**加工すると `labels` にそのまま渡せなくなる**）。
  色だけは `#` を補う。GitHubは `#` 無しの6桁16進で返す
- 上限は100件（`LABEL_FETCH_LIMIT`）。切れた場合は**省いた件数を `note` に書く**。
  黙って切ると、実在するラベルを無いものとして扱ってしまう

### RESTではなくGraphQLを使う理由

対象が26リポジトリあり、RESTだと**同じ内容に約80リクエスト**かかる（リポジトリごとに
compare・releases・commits・issues）。GraphQLなら**1リクエスト・実測2ポイント**で済む
（上限は1時間5000ポイント）。`fetch` で `POST /graphql` するだけなので実行時依存も増えない。

### 落とし穴

- **`compare` の向きが直感に反する。** `defaultBranchRef.compare(headRef:"main")` は
  base=デフォルトブランチ / head=main なので、**`behindBy` が「未リリースのコミット数」**に
  あたる（`aheadBy` は main 側だけにあるコミット数）。RESTの `compare/main...develop` の
  `ahead_by` と一致することを確認済み。テストで固定してある
- **`main` が無いリポジトリでは `compare` が NOT_FOUND を返す。** `master` 運用のリポジトリで
  普通に起きる安定した状態なので、取得失敗として数えない（数えると `complete` が恒久的に
  false になり、本物の失敗が埋もれる）
- **詳細モードで組織全体を引かない。** 全リポジトリを深く掘るクエリはGitHub側の処理が重く、
  実測で5秒のタイムアウトに掛かった。コストではなく応答時間の問題。1リポジトリだけを引く
  クエリに分けてある（約1秒）
- 俯瞰は実測3〜4秒かかる（うち `compare` だけで約1.4秒）。タイムアウトは10秒に取っている

### 設定

| 環境変数 | 未設定のとき |
|---|---|
| `AIDE_GITHUB_TOKEN` | 取得を試みず「未設定」を返す |
| `AIDE_GITHUB_ISSUE_TOKEN` | `aide_create_issue` が「未設定」を返す。GitHubへは何も送らない。アプリ連携の「Issueを起案…」は出ない |
| `AIDE_GITHUB_ORG` | `guchi-apps` |
| `AIDE_GITHUB_REPOS` | archived を除き、直近 `AIDE_GITHUB_ACTIVE_DAYS` 日にpushがあったものを自動で拾う |
| `AIDE_GITHUB_ACTIVE_DAYS` | `90` |

トークンは**認証情報として扱う**。ログにもMCPのレスポンスにも出さない。取得失敗の理由は
HTTPステータスと例外の種別まで丸める。GraphQLの `errors` も `message` は載せず、
どのリポジトリのどのフィールドかと種別だけを返す（`message` に内部の構成が載ることがあるため）。

fine-grained PAT を使う。GitHub App は採らなかった（この用途に対して、秘密鍵の保管と
JWT署名→インストールトークン交換の実装が重い）。**取得用と起票用で別のトークンを持つ。**

| トークン | 権限 | 使うところ |
|---|---|---|
| `AIDE_GITHUB_TOKEN` | Metadata / Contents / Issues / Pull requests / Actions の **read のみ**。**対象リポジトリに `guchi-apps/docs` を含める** | `aide_dev_status` |
| `AIDE_GITHUB_ISSUE_TOKEN` | Metadata: read と **Issues: read and write** のみ | `aide_create_issue`、アプリ連携の「Issueを起案」（`POST /map/issue`） |

1本にまとめて取得側にも書き込み権限を持たせると、26リポジトリを横断する取得の経路が
そのまま書き込みのできる経路になる。分ければ、起票を止めたいときにこのトークンだけ失効させればよい。
`readGitHubWriteConfig()` は `AIDE_GITHUB_TOKEN` へフォールバックしない（Read-onlyのトークンで
書き込みを試みて403を返すだけの経路ができ、権限を持たせたかが設定から読み取れなくなるため）。

キャッシュは挟まず**都度叩く**。1リクエストで済み、レート制限にも余裕があり、
「いまどうなっているか」という問いに対してキャッシュの古さは害にしかならない。

## コネクタ: Open-Meteo（天気予報）

朝のブリーフィング（guchi-apps/question#7）の材料として、今日・明日の天気・最高／最低気温・
降水確率を取得する。

```
src/core/connectors/weather/
  types.ts   応答のうちAIDEが使うフィールドと、正規化後の形（WeatherForecast）
  parse.ts   日ごとの配列を1日ずつへ畳む＋WMO天気コードの日本語化（純粋関数。テストはここ）
  index.ts   地点の設定・問い合わせURL・失敗理由の丸め
src/worker/jobs/weather-sync.ts   毎時取得してキャッシュ（weather-forecast）へ書く
```

### Open-Meteo を直接叩く

myroom（`backend/weather.py`）と portfolio（`src/hooks/use-weather.ts`）が既に Open-Meteo を
使っており、取得元が揃う。**APIキーが要らない**ので新しい認証経路が増えず、`fetch` だけで
書けるので実行時依存も増えない。

**myroom 経由にはしない。** ops-dashboard・Asset Manager をあの形にしたのは「認証情報を
1か所へ閉じる」「スケジューラを集約する」ためで、天気はAPIキーも巡回も持たないためどちらにも
当たらない。挟むと結合が増えるだけになる。

### 利用条件（無料枠）

| 条件 | AIDEでの扱い |
|---|---|
| 非商用に限る | 個人利用なので満たす |
| 1日10,000回未満（1時間5,000回・1分600回） | 毎時1回の worker ジョブだけが叩く（1日24回） |
| CC BY 4.0 の帰属表示 | `WeatherForecast.attribution` に同梱し、**機能一覧ページ（`/features`）に出す** |

帰属表示を `/features` に置いたのは、天気を見られる人が限られるため。天気そのものはキャッシュと
ビュー（＝認証の内側）にしか出ず、`/features` も同じくログインの内側にある（#332）。
帰属表示はデータ自体にも同梱しているので、見る人の手元には必ず届く。取得元が増えたら `/features` へ足す。

### キャッシュを挟む理由

取得自体は軽い（HTTP GETが1本）ので「どこまでを重い取得とみなすか」では都度叩く側にあたるが、
**利用回数の条件がある外部API**なので、呼ばれた回数だけ外へ出ていく作りにはしない。
予報は毎時更新なので、毎時取れば鮮度も足りる。

### 設定

| 環境変数 | 未設定のとき |
|---|---|
| `AIDE_WEATHER_LAT` | `34.82`（myroom の `OUTDOOR_LAT` と同じ） |
| `AIDE_WEATHER_LON` | `135.56`（myroom の `OUTDOOR_LON` と同じ） |

**値が要るのは worker が動くサブPCだけ**（VPSはキャッシュを読むだけ）。座標として読めない値は
既定へ落とさず例外にする。黙って既定へ戻すと、書き間違えたまま「別の地点の予報が正常に
取れている」状態になり、画面にも通知にも異常が出ない。

座標は自宅の位置にあたるため、**ログにも失敗通知にも出さない**。失敗理由はHTTPステータスと
種別まで丸める（`Open-Meteo が HTTP 429 を返しました（利用回数の上限）` など）。


## コネクタ: Claude Code（サブPCのセッション）

サブPCで動いている Claude Code のセッションと、その**リモートコントロールURL**（#123）。
Claudeとの会話から `aide_claude_sessions` を呼べば、URLをタップしてそのセッションの画面へ
移動できる。URLだけでは終了済みか判別できず、複数セッションのどれかも区別できないため、
状態・プロジェクト・経過時間を併せて返す。

```
src/core/connectors/claude-code/
  types.ts   ~/.claude/sessions/<pid>.json のうち、AIDEが使うフィールドだけを再宣言
  index.ts   台帳を読み、生きているセッションだけを畳む（純粋関数はここ）
src/worker/jobs/claude-sessions-sync.ts   収集して claude-sessions キーへ送る
src/core/views/claude-sessions.ts         キャッシュを読み、経過時間と鮮度を添える
```

### 台帳の場所と読み方

Claude Code はセッションごとに `~/.claude/sessions/<pid>.json` を書いており、作業ディレクトリ・
tmuxセッション名・起動時刻・`busy`/`idle` と、リモートコントロールの接続先ID
（`bridgeSessionId`）が入っている。URLは `https://claude.ai/code/<bridgeSessionId>` で組み立てる。

**この台帳の形はAIDEが決められない。** Claude Code のバージョンが上がればフィールドは黙って
増減するため、必須として扱うのは `pid` だけにし、他は常に「無いかもしれない」前提で読む。

**同じディレクトリの `<pid>.<hash>.key` は認証情報。** 拡張子が `.json` のものだけを読み、
`.key` は開かない。

### 状態は3値。`waiting` が「放置」の手掛かり

`status` は `busy`（応答中）・`waiting`（人の入力を待っている）・`idle`（待機中）の3つで、
**2値ではない**。`waiting` のときは `waitingFor` に理由（`permission prompt` = 承認待ち、
`input needed` = 入力待ち）が入る。

Issueが挙げた「放置セッションかの判断がつかない」に直接答えるのはこの値で、busy/idle へ丸めると
**人の返事を待って止まっているセッションが idle に紛れる**。`statusForMinutes`（その状態が
続いている分数）と併せて返し、長く待たせているものを見分けられるようにしている。

`status` も `bridgeSessionId` も**キーごと存在しないことがある**（SDK経由の起動など）。
必須として扱わず、欠けていれば null で返す。

### 一覧に出さないもの

`kind` が `interactive` でないセッション（SDK経由の裏方プロセス）は一覧から除く。
リモートコントロールもtmuxでのattachもできず、人が開いて操作する対象ではないため。
**ただし黙って落とさない。** 件数を `nonInteractive` として数え、note に出す
（落としたことが見えないと「何件動いているか」がずれる）。

`kind` を書かない世代の台帳は除外しない（欠けているだけで裏方とは限らないため）。

### 終了済みセッションの除き方

台帳は終了時に消えるとは限らず、残骸のPIDが別のプロセスへ割り当て直されることもある。
**PIDの存在確認だけでは足りない。** 台帳が持つ `procStart`（`/proc/<pid>/stat` の22番目の
フィールド＝起動時刻）まで一致して初めて同じプロセスとみなす。

`/proc/<pid>/stat` は前から数えて22番目を取ってはいけない。2番目のフィールドがプロセス名で、
名前自体に空白や括弧を含められるため、**閉じ括弧の最後の出現より後ろだけを数える**。

### 収集が worker 側にある理由と、その代償

台帳は**サブPCのファイルシステムにしか無く**、MCPサーバーはVPSで動く。呼ばれたときに読みに
行けないため、他の重い取得と同じ経路（`POST /api/cache/:key`）でサーバーへ送る
（[worker とサーバーが別マシンである問題](#worker-とサーバーが別マシンである問題)）。

代償として、返せるのは**スナップショット**になる。2分ごとに収集し、直前に始めた・終えた
セッションは反映されないことがあるため、収集時刻（`collectedAt`）と経過分数
（`snapshotAgeMinutes`）を必ず併せて返す。10分以上更新されていなければ `stale` を立て、
「いま動いているもの」として扱わせない（**セッションが無いという意味ではない**）。

**このジョブはサブPCの systemd timer が入っていて初めて動く。** 入っていなければツールは
`stale` を返し続ける。ユニットは `deploy/systemd/` にあり、実行場所は
[systemdユニット](#systemdユニット)のとおり手で反映する。

### ops-dashboard 経由にしなかった理由

[ops-dashboard コネクタ](#コネクタ-ops-dashboard)は既にサブPCのtmuxセッションをVPSの localhost から
**キャッシュ無しで都度取得**しており（30秒間隔で更新）、こちらより鮮度が良い。それでも相乗りせず
自前で収集しているのは次の2点による。

- **向こうのモデルはtmuxセッション単位で、Claude Code のセッション単位ではない。**
  tmuxの外で動いているセッションは表現できず、1つのtmuxセッションと1つのClaude Codeセッションが
  常に対応するとも限らない。`bridgeSessionId` を運ぶには結局この台帳を読む必要がある。
- **別リポジトリ（ops-dashboard）のエージェント改修とデプロイが前提になる。**
  向こうの手当てが済むまでAIDE側は何も返せず、リリースの単位が2リポジトリにまたがる。

代償は鮮度で、**2分ぶん古くなりうる**（向こうなら30秒）。`aide_claude_sessions` が返す
`snapshotAgeMinutes` はそのための値で、間隔を詰めても消えない性質のものとして扱っている。
実運用で2分では足りないと分かった場合は、host-stats エージェント側に
`bridgeSessionId` / `status` / `startedAt` を足して相乗りへ移すのが素直な移行先になる。

### ログに出さないもの

セッション名・作業ディレクトリ・リモートコントロールURLは**ジャーナルにも通知にも出さない**。
URLは開けばそのセッションを操作できるもので、ログへ残す粒度ではない。ジョブが残すのは
件数だけにしてある。

## 天気

Claudeアプリから「今日の天気は」「傘は要るか」と聞いたときに、**今日・明日の予報**を返す
（guchi-apps/question#7・aide#36）。

```
src/core/views/weather.ts   予報の器・畳み込み（純粋関数。テストはここ）
src/mcp/tools/weather.ts    aide_weather
```

### 朝のブリーフィングを畳んだ（#373）

もとは `aide_daily_briefing` という横断ビューで、**今日の予定・交通・天気**を1回の呼び出しで
返していた。3ソースをClaudeに個別に叩かせると往復もトークンも増えるため、という理由だった。

#373 でMCPツールを**「1つの問い」ごと**に分け直したさいに、この畳み込みは解いた。

- **予定は `aide_schedule` が既に答えていた。** あちらは期間を指定して予定と空き時間を返すもので、
  日付を省けば今日ぶんになる。今日だけ答えが2本に割れており、ツール選択が曖昧になっていた
- **交通は取得元が未定**（trainrouteの廃止により白紙。aide#265）。`not_connected` とだけ返す欄を
  毎回持ち回っても、答えは良くならない
- 残った天気は単独の問い（「傘は要るか」）として立つので、そのままツール1本にした

**「今日はどんな感じ」のように予定と天気の両方が要る問いでは、Claudeが2本呼ぶことになる。**
畳んでいた頃より呼び出しは1回増える。両ツールの説明文でこの関係を書き分けてある。

### 「今日」はJSTの暦日で切る

`Asia/Tokyo` の暦日（`YYYY-MM-DD`）を対象日とし、深夜も暦日どおりに扱う。ツールは引数を取らない。

**日付で突き合わせる。配列の先頭を「今日」とみなさない。** キャッシュは日付をまたいで残るため、
添字で取ると日付が変わった直後に昨日の予報を「今日」として返してしまう。対象日が含まれていない場合は
`unavailable` にして、取得済みの時刻と理由を添える。

#### 深夜0時台は「明日」が必ず欠ける

天気の取得は今日・明日の2日ぶん固定（`FORECAST_DAYS`）で、同期は毎時。**日付が変わってから次の同期が
走るまでは、キャッシュの中身が「前日・当日」のまま**になり、`tomorrow` が見つからない。このとき
キャッシュ自体は新しいので `stale` にはならない（180分に満たない）。

全体は落とさず `tomorrow` だけを `null` にし、**「明日の天気が無い」と読まれないよう `note` に
断り書きを添える**。日をまたいだ直後だけ毎日起きる状態なので、鮮度の判定で表現しようとすると壊れる。

### `aide_room_sensors` との棲み分け

`aide_weather` が返すのは**今日・明日の予報**、`aide_room_sensors` が返すのは**いまの実測**
（室温・湿度・CO2と、myroom 経由の屋外の気温・湿度・気圧）。「いま暑いか」は後者、「今日は暑くなるか」
「傘は要るか」は前者にあたる。**両方のツールの説明文でこの違いを書き分ける**——
選択が曖昧になれば、分けた意味が無くなる。

### 取得できなかったことを「そういう天気だ」と読ませない

`state` で区別する。`ok` は中身が入っている、`unavailable` は取得できなかった（対象日ぶんが
キャッシュに無い場合を含む）。**どちらも `data` の有無では見分けられない**ため、理由（`reason`）を
添えて返す。

**MCPの同期リクエスト内で重い取得は行わない。** 天気は weather-sync が毎時書いたキャッシュを読むだけ
（「どこまでを『重い取得』とみなすか」）。


## キャッシュと worker

取得と提供を分離するための仕組み。

```
src/core/cache/store.ts    JSONファイルのキャッシュ
src/worker/run.ts          ジョブのエントリポイント（ワンショット実行）
src/worker/jobs/           個々のジョブ
src/core/views/            キャッシュを読んでビューを組み立てる
```

### なぜキャッシュを挟むか

Zaimの巡回は12秒前後かかる。MCPやAPIの同期リクエストの中で走らせると、応答が遅いうえにヘッドレスChromiumのぶんメモリが跳ねる。VPSは2GBしかないため成立しない。

worker が定期実行して `data/cache/` に書き、MCPサーバーとAPIはそれを読むだけにする。

### JSONファイルである理由

データモデルがまだ固まっていない。この段階でDBを入れると、形を変えるたびにマイグレーション運用のコストが先に来る。形が安定したらMariaDBへ移す。

書き込みは一時ファイル + `rename` で行う。直接上書きすると、書き込み中に読まれたときに壊れたJSONを掴む。

### ジョブの実行

```bash
npm run worker zaim-refresh     # 連携口座を一括更新（押して最大45分待つ、1日2回想定）
npm run worker zaim-sync        # 巡回してキャッシュ更新（重い、1日2回想定）
npm run worker zaim-keep-alive  # セッション延長のみ（軽い、30分ごと想定）
npm run worker weather-sync     # 天気予報を取得（軽い、1時間ごと想定）
npm run worker claude-sessions-sync  # Claude Codeのセッションを収集（軽い、2分ごと想定）
npm run worker printer-watch    # 3Dプリンターの完了・停止・エラーを通知（軽い、2分ごと想定。#378）
```

常駐させずワンショットで実行し、スケジューリングは外（cron / systemd timer / PM2）に任せる。常駐プロセスを増やさずに済み、失敗しても次回実行で自然に復旧する。失敗時は終了コード1を返すので、スケジューラ側から検知できる。

### 実行記録

実行のたびに結果を `job-<ジョブ名>` というキャッシュキーへ1件だけ書く（`src/worker/record.ts`）。
動作状況（`/api/status` → ops-dashboard）はこれを読んで「最後に成功したのはいつか」に答える。

**通知（Signaly）では代われない。** あちらは流れて消えるうえ、成功時は何も送らないため、
「動いているが最後の成功が3日前」という状態を後から知る手段が無かった。

置き場をキャッシュにしているのは、**worker がサブPC・サーバーがVPS**で動くため。ファイルに書いても
サーバーからは見えないが、取得結果と同じ経路（`POST /api/cache/:key`）に載せれば、開発機（両方ローカル）と
本番（別マシン）で同じコードのまま届く。ジョブごとにキーを分けているのは、1つにまとめると書く前に
現在値を読む必要があり、書き込み専用の受け口に読み取り口を足すことになるため。

記録するのは成否・時刻・所要時間・1行のメッセージ・実行ホストだけで、取得した値そのものは入れない。
記録に失敗してもジョブは失敗させない（通知と同じ方針）。

### 実行間隔の制約

Zaimの認証Cookieは**約2時間**で失効し、アクセスのたびにその時点から延長される。したがって **2時間以内に必ず1回はZaimへアクセスする必要がある**。

| ジョブ | 間隔 | 最悪間隔 | 理由 |
|---|---|---|---|
| `zaim-keep-alive` | 30分ごと（揺らぎ2分） | 32分 | 有効期間2時間に対し、**3回続けて失敗しても間に合う**余裕を取る |
| `zaim-refresh` | 1日2回 10:30 / 22:30 JST | — | 押してから反映まで5〜15分、遅い口座は約35分かかる。24時までにその日の最終データを確定させるための逆算 |
| `zaim-sync` | 1日2回 11:30 / 23:30 JST | — | `zaim-refresh` の完了を見込んだ時刻に置き、夜の1回で**その日のうちに**当日の値を確定させる |

「最悪間隔」は `RandomizedDelaySec` を含めた実際の空き時間。**`zaim-keep-alive` はここを2時間より十分短く保つことが要件**で、毎時（最悪1時間5分）では1回失敗しただけで超えていた（#63）。Zaimの2つは巡回そのものが目的なので、この制約は掛からない。

**`zaim-sync` は以前05:00 JSTだった。** 「issue-deckの並行ビルドと競合せず、朝の時点で当日のデータが揃う」ことが理由だったが、その時刻では更新ボタンを押した当日ぶんが翌日のキャッシュにしか載らない。23:30へ移しても朝には前夜23:30のデータ（経過8時間ほど）があり、当日ぶんが揃っているという条件は満たせるため移した（#62）。

**さらに昼の1回を足して1日2回にした（#165）。** 日次1回だと日中に残高を尋ねても前夜の値しか返らず、キャッシュの経過が最大24時間になる。**夜の1回は動かしていない**ので、#62 の「その日のうちに当日ぶんを確定させる」条件はそのまま保たれる。頻度に合わせて次の3つも詰めてある。

| 何を | 変更 | どこ |
|---|---|---|
| 「動いていない」とみなす遅れ | 36時間 → 18時間（12時間＋実行のずれのぶん） | `src/worker/jobs/catalog.ts` の `staleAfterMinutes` |
| 残高データを「古い」とみなす経過 | 24時間 → 18時間 | `src/core/views/money.ts` の `STALE_AFTER_MINUTES` |
| 更新できなかった口座の判定 | 毎回 → その日の最後の巡回だけ | `src/worker/jobs/zaim-sync.ts` の `decideStaleAccountCheck` |

最後の1つは**必須**。更新漏れは「最終更新が当日（JST）か」で見るため、昼の時点では前夜に更新できた口座まで当日でない側に入る。判定したままにすると、昼で「警告」・夜で「復旧」を毎日往復する通知になる。**通知の抑制では塞げない**（全口座が当日になった時点で記録ごと消えるため、次の警告は窓に関係なく無条件で届く）。

**さらに押下を 10:30 / 22:30 へ45分前倒しし、反映を待つ時間も最大45分へ延ばした（#178）。** 押下から巡回までが20分しかなく、反映に約35分かかる口座（SBI証券・楽天証券・Ponta・MUFGカード）が毎晩間に合っていなかった。巡回の 11:35 / 23:35 は動かしていないので、#62 の「23:59までにその日ぶんを確定させる」条件はそのまま保たれる。**押下と巡回の65分の間隔が、この修正の根拠そのもの**なので、どちらかの時刻を動かすときは必ず両方を見る。

**巡回を 11:30 / 23:30 へ5分早めた（#278）。** 押下（10:30 / 22:30）は動かしていないため、間隔は65分→60分に縮まる。反映に最も時間がかかる口座（SBI証券など）でも約35分であり、60分の間隔でも十分な余裕が残るため実害はない。

あわせて**更新漏れの判定を押下側（`zaim-refresh`）から巡回側（`zaim-sync`）へ移した**。押した直後には反映の遅い口座がまだ進んでおらず、押下側で判定すると「更新できない口座」と「反映が遅いだけの口座」を区別できないため（判定の境目である20時はそのまま流用している）。

**移すにあたって「判定しない」を空の配列で表さないこと。** 巡回は連携口座一覧の取得に失敗しても残高・保有銘柄は返すため、`onlineAccounts` は空配列になりうる（`scripts/scrape.mjs` が例外を握る）。これをそのまま `notifyStaleAccounts` へ渡すと「更新漏れ0件」＝直ったと読まれ、**未解決の記録を消して「復旧しました」を誤って送る**。押下側では「1件も読めなかった」をジョブの失敗にしていたため、この経路は無かった。`decideStaleAccountCheck` は判定しない場合に `null` を返し、通知を呼ばせない。

subpcのシステムTZはUTCなので、タイマーには `Asia/Tokyo` の明示が必須。

**このスケジューリングは常時起動のホストに置く必要がある。** 開発機（メインPC）は常時起動しない前提のため、セッションを維持できない。本番では subpc が担う。

### systemdユニット

ユニットは `deploy/systemd/` にある。**実行場所はサブPCの `~/.config/systemd/user/`** で、リポジトリからは自動反映されない（VPSへの `deploy.yml` が触るのはサーバー側だけ）。間隔を変えたら手で反映する。

**新しい定期ジョブのタイマーを足すときは、`guchi-apps/subpc` の `setup.sh`（`SYSTEMD_USER_UNITS`）にも足す。** サブPCでは `./setup.sh --only systemd` がここのユニットを配置して `.timer` を enable し、日次のドリフト検知も回している。リストに無いタイマーは `cp` で置いても、次の反映・検知で「管理外」として差分に出る（#378 の `aide-printer-watch.timer` で気づいた）。以下の手動手順は `setup.sh` を使えない環境向け。

```bash
cp deploy/systemd/*.timer deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aide-zaim-refresh.timer   # 初回のみ（未導入のユニット）
systemctl --user enable --now aide-claude-sessions-sync.timer  # 初回のみ（未導入のユニット）
systemctl --user enable --now aide-printer-watch.timer  # 初回のみ（未導入のユニット。myroom#428 のリリース後）
systemctl --user enable --now aide-zaim-web.service     # 初回のみ（未導入のユニット）
systemctl --user enable --now aide-zaim-money-sync.timer  # 初回のみ（未導入のユニット）
systemctl --user restart aide-zaim-keep-alive.timer aide-zaim-refresh.timer aide-zaim-sync.timer aide-zaim-money-sync.timer
systemctl --user list-timers 'aide-*'
```

**`aide-zaim-web.service` だけタイマーを持たない常駐**（#215。VPSからの中継を受ける口）。
`systemctl --user status aide-zaim-web` と `curl -sS http://$AIDE_ZAIM_WEB_HOST:4748/health` で見る。
**ログアウトで落ちないよう lingering が要る**（`loginctl enable-linger $USER`。他のタイマーも同じ前提）。

以前はユニットがリポジトリの外にしか無く、間隔がなぜその値なのかを追えなかったため、実体をこちらへ移している。

**サブPC側のコードも自動では更新されない。** `deploy.yml` が配るのはVPS（サーバー）だけで、
worker が動く `~/apps/aide` は**人が `git pull` するまで古いまま**。worker まわりの修正は、
`develop` へマージしただけでは効かない（#89 の時点で17コミットぶん遅れていた）。

```bash
# サブPCで
cd ~/apps/aide && git pull --ff-only
```

### ジョブ失敗の通知

終了コード1は systemd のジャーナルに残るだけで誰にも届かない。実際に `aide-zaim-sync.service` の失敗が丸一日気づかれずに放置されたため、失敗を [Signaly](https://github.com/guchi-apps/signaly)（Webhook受信 + Web Push の通知ハブ）へ送っている（`src/worker/notify.ts`）。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_SIGNALY_WEBHOOK_URL` | 通知しない（開発機） | 失敗・復旧をそのWebhookへ送る（本番 = サブPC） |

URLに含まれる `channel_id` が宛先の識別子そのもの（Webhook自体は認証なし）なので、**認証情報として扱う**。ログにも通知本文にも出さない。

送るのは次の4つだけ。

- **失敗**: ジョブ名・失敗理由・発生時刻・実行ホストを載せる。`ZAIM_SESSION_EXPIRED` はタイトルと「対応」欄で他の失敗と区別する。**失効はさらに3通りに書き分ける**（下記）
- **復旧**: 失敗が記録されている状態で成功したときに1回だけ
- **セッション回復（ジョブ横断）**: Zaimのジョブが成功したとき、**他のZaimジョブに残っている失効の失敗**へ1回だけ。ジョブ単位の復旧通知では、12時間ごとの `zaim-refresh` の失効を30分ごとの `zaim-keep-alive` が直しても次の `zaim-refresh` まで伝わらない（#191）。消すのは失効の記録だけで、別の理由で失敗しているジョブの記録は残す
- **一部失敗**: `zaim-sync` の巡回時点で最終更新が当日でない口座があるとき。**ジョブ自体は成功扱いのまま**（押下も巡回も成功しており、AIDE側では直せない）。署名は「更新できなかった口座名の集合」なので、同じ口座が落ち続けている間は静かになり、別の口座が落ちたときは抑制せずに届く。記録は `<ジョブ名>:stale-accounts` としてジョブ自体の失敗とは別に持つ。**判定するのはその日の最後の巡回（23:30）だけ**（#165 / #178。理由は上の「実行間隔の制約」）

**失効の通知は「自動で直る見込みがあるか」で書き分ける**（#191）。かつては失効＝手動ログインでしか直らなかったが、いまは自動再ログイン（#63）があり、多くは次の `zaim-keep-alive` が勝手に直す。それでも「手動でログインし直すまで失敗し続けます」と送っていたため、受け取った側が手動対応の要否を判断できなかった（2026-08-29 22:32 の `zaim-refresh` の失敗は、4秒後の `zaim-keep-alive` が自動再ログインして復旧している）。判定は失敗の中身と資格情報の有無だけで行い、資格情報の**値は読まない**。

| 状態 | 見分け方 | 通知 |
|---|---|---|
| 自動再ログイン待ち | 失効のマーカーのみ・`ZAIM_EMAIL`/`ZAIM_PASSWORD` あり | 黄色。「30分ごとの `zaim-keep-alive` が自動で試みる」。手動を促さない |
| 自動再ログインも失敗 | `ZAIM_AUTO_RELOGIN_FAILED` が付いている | 赤。手動ログインを促す |
| 自動再ログインの設定なし | 失効のマーカーのみ・資格情報なし（開発機・CI） | 赤。手動ログインを促す |

`ZAIM_AUTO_RELOGIN_FAILED` を付けるのは `session.ts` だけで、**自動再ログインを実際に試したうえで直らなかった場合に限る**。元のメッセージは丸ごと残し、マーカーは行を分けて足す（`ZAIM_SESSION_EXPIRED` を落とすと失効として分類されなくなり、失敗理由の1行目も失われる）。**抑制の署名もこの3状態で分ける。** 同じ署名にすると、「自動で直る見込み」を送った直後に自動再ログインが失敗しても、6時間の抑制で「手動が要る」が届かない。

定期実行の成功は送らない。`zaim-keep-alive` は30分ごとなので、成功も送ると1日48件になり肝心の失敗が埋もれる。

**同じ理由で失敗し続けている間は6時間に1回まで**に抑えている（30分ごとの `zaim-keep-alive` がセッション失効すると、抑制しないと48件/日届く）。理由が変わった場合は抑制せずに送る。抑制で黙っている状態と直った状態を区別できるように、復旧通知だけは出している。

未解決の失敗は `data/worker/notify-state.json` に持つ（ジョブ名・失敗理由の署名・時刻・回数だけ。取得データも認証情報も入れない）。**通知の送信失敗でジョブを二重に失敗させない。** 送信・記録まわりの例外はすべて握りつぶし、ログに一行残すだけにする。送れなかった回は通知済みにせず、次の実行で送り直す。

**3Dプリンターの状態遷移（完了・停止・エラー）も同じ Signaly へ送る**（`printer-watch`。失敗・復旧の通知とは別物で、抑制や記録も別。詳細は[コネクタ: 3Dプリンター](#コネクタ-3dプリンターmyroom経由378)）。

**プロセスが起動する前に落ちるケース（node が起動しない・OOMで強制終了）は拾えない。** そこまで拾うなら systemd の `OnFailure=` が要る（ユニットは `deploy/systemd/` にある）。

### 金額の扱い

`balances`（残高一覧）には証券口座の**合計**が含まれ、`holdings`（保有銘柄）はその**内訳**にあたる。両者を足すと証券分を二重に数えるため、ビューでは合算値を出していない。


## worker とサーバーが別マシンである問題

本番では **worker はサブPC、MCPサーバーはVPS**で動く。別マシンなのでキャッシュファイルを共有できない。放置すると worker が更新するキャッシュとサーバーが読むキャッシュが別物になり、Claudeへ古いデータを返し続ける。

worker から HTTP で送る形で解消している。

```
サブPC                          VPS
worker ──POST /api/cache/:key──▶ サーバー ──▶ data/cache/
```

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_INGEST_URL` | ローカルのキャッシュへ直接書く（開発機） | そのURLへHTTPで送る（本番） |
| `AIDE_INGEST_SECRET` | — | 送信・受信の共通シークレット |

同じコードが開発機（両方ローカル）と本番（別マシン）の両方で動く。

**`AIDE_INGEST_URL` だけ設定して `AIDE_INGEST_SECRET` が無い場合はジョブを失敗させる。** 黙ってローカルへ書くと「送ったつもりで届いていない」状態になり、気づくのが遅れるため。

**送信は通信断と5xx・429に限って再試行する**（`src/worker/sink.ts`。#295）。サブPC→VPSは一時的に繋がらないことがあり、2026-09-18 23:35 の `zaim-sync` は巡回を終えたあと送信だけが接続タイムアウト（約10秒）で落ちた。同じ `fetch failed` は他のworkerジョブでも9月だけで10件以上出ていた。送信は同じキーへの上書きなのでやり直しても害がなく、巡回（Zaimへのアクセス）はやり直さずに送信だけをやり直す。

| 呼び出し | 試行回数 | 理由 |
|---|---|---|
| 既定（`zaim-sync` など） | 3回（間隔5秒・15秒） | 1日2回のジョブは1回落ちると12時間古いまま残る |
| `weather-sync` | 2回 | `TimeoutStartSec=2min` に収める |
| `claude-sessions-sync` | 1回 | 2分ごと・`TimeoutStartSec=1min`。次の実行がやり直しになる |
| 実行記録（`recordJobRun`） | 1回・待つのは10秒まで | 失敗時は本体の送信のあとに続くため、ここで粘ると systemd に止められる |

**systemd の `TimeoutStartSec` を超えるとプロセスごと止められ、失敗の通知も記録も残らない。** 回数を増やすときは、本体の送信と記録の送信の最悪の合計がユニットの上限の3/4に収まるかを `sink.test.ts` が確かめている。

4xx（認証・未知のキー）はやり直しても変わらないため即座に失敗させる。**失敗理由には `fetch failed` の中身（`UND_ERR_CONNECT_TIMEOUT`・`ENOTFOUND` など）を添える。** Node の fetch は通信の失敗をすべて `fetch failed` の1語で投げ、理由は `cause` にしか無い。以前はメッセージだけを残していたため、通知からも記録からも何が起きたのかを辿れなかった。**ただし通知の抑制の署名からはこの中身を外す**（`stripFetchFailureDetail`）。同じ通信断でも `UND_ERR_CONNECT_TIMEOUT`・`ECONNRESET` などと揺れるため、署名に残すと「理由が変わった」扱いで抑制が効かなくなる。

**両方とも未設定の場合は失敗しない。** 開発機ではそれが正しい挙動だが、**サブPCで設定を落とすとジョブは成功したままVPSのキャッシュだけが止まる。** 実際、サブPCの `.env` にこの2つが無く、巡回結果がサブPC側の `data/cache/` にだけ書かれ続け、本番のキャッシュが3日ぶん古いままになっていた（#89）。サーバー側からは worker の `.env` を見られない（[worker 側の設定は「未設定」と断定しない](#worker-側の設定は未設定と断定しない)）ため、**サブPC側で確かめる。**

```bash
# サブPCで。値そのものは出さず、設定されているかだけを見る。
grep -c '^AIDE_INGEST_\(URL\|SECRET\)=' ~/apps/aide/.env   # 2 なら設定済み
journalctl --user -u aide-zaim-sync.service -n 5 -o cat      # 「…へ送信した」なら届いている
```

ジョブのログが「ローカルのキャッシュへ書いた」で終わっている間は、**何度巡回しても本番のキャッシュは更新されない。**

### 受け口の認証

MCPのOAuthとは別系統で、共有シークレット1本。呼び出し元が自分のworkerに限られるためOAuthは過剰で、issue-deck の dispatch と同じ方式に揃えている。

受け入れるキーはサーバー側で明示的に限定している（任意のキーで書き込めると、参照側が読まないゴミが溜まる）。**巡回結果（`zaim-snapshot`）だけでなく、ジョブの実行記録（`job-<ジョブ名>`）も同じ経路で届く**ので、両方を許可する。記録側は送信に失敗しても例外を投げない（ジョブを二重に失敗させないため）ので、ここで弾くとログ1行が残るだけで、動作状況のジョブ欄が永久に「記録なし」になる（#89）。


## 個人アプリ向けの読み取りAPI

Claudeアプリ等へMCPで出しているのと同じデータを、既存の個人アプリへはRESTで出す。実装は `src/api/read.ts`。

| | |
|---|---|
| エンドポイント | `GET /api/money/summary` |
| 返す内容 | `aide_balances` と `aide_fixed_costs` を合わせたビュー（`buildMoneySummary()`）。**MCP層だけが2本に分かれており、この読み取りAPIは1本のまま**（#373） |
| 認証 | `Authorization: Bearer $AIDE_READ_SECRET` |

```bash
curl -s -H "Authorization: Bearer $AIDE_READ_SECRET" http://127.0.0.1:3114/api/money/summary
```

```jsonc
{
  "empty": false,
  "fetchedAt": "2026-08-16T03:00:00.000Z",
  "ageMinutes": 120,
  "stale": false,
  "totals": { "balances": 1234567, "holdings": 234567 },
  "balances": [{ "name": "〇〇銀行", "amount": 1000000,
                 "lastUpdatedAt": "2026-08-16T23:20:11+09:00" }],
  "holdings": [{ "account": "〇〇証券", "name": "〇〇インデックス", "amount": 234567,
                 "occurrence": 1, "occurrenceCount": 1,
                 "lastUpdatedAt": "2026-08-16T23:21:00+09:00" }],
  "onlineAccounts": [{ "name": "〇〇銀行", "lastUpdatedAt": "2026-08-16T23:20:11+09:00" }],
  "staleAccounts": [{ "name": "△△銀行", "lastUpdatedAt": "2024-12-18T10:00:00+09:00" }],
  "fixedCosts": {
    "configured": true,
    "monthlyByCurrency": [{ "currency": "JPY", "amount": 2470 }],
    "monthlyByPaymentMethod": [{ "paymentMethod": "〇〇カード", "currency": "JPY", "amount": 2470 }],
    "monthlyJpy": 2470, "usdJpyRate": 152.3, "count": 2,
    "items": [{ "name": "〇〇", "monthlyAmount": 1490, "currency": "JPY",
                "contractStatus": "AUTO_RENEWING", "paymentMethod": "〇〇カード",
                "nextPaymentDate": "2026-09-05" }],
    "upcoming": [{ "name": "〇〇", "date": "2026-09-05", "amount": 1490, "currency": "JPY" }],
    "unavailable": null, "note": "..."
  },
  "note": "..."
}
```

**`fixedCosts` も同じ器で出ている。** `buildMoneySummary()` の戻り値をそのまま返しているため、
月額固定費に項目が増えるとこのAPIの応答にも同時に出る（追加のみなので既存の読み手は壊れない）。

**取得時刻と経過分数を必ず併せて返し、鮮度の判断は呼び出し側に委ねる。** MCP層と同じ方針で、AIDEは
「古いから返さない」という判断をしない。キャッシュが空でも200を返す（`empty: true`）。まだ一度も巡回して
いないのは状態であってエラーではなく、呼び出し側が区別できる形で伝わればよい。

`lastUpdatedAt` は **Zaim側が各金融機関から取得した時刻**で、AIDEが巡回した時刻（`fetchedAt`）とは別物。
更新できない口座があると巡回が新しくても中身は古いままになるため、当日でないものを `staleAccounts` に
まとめている（[更新できない口座の扱い](#更新できない口座の扱い)）。**これも捨てるかどうかは決めない。**
連携していない口座（現金・手入力）と、この項目を持たない時期のキャッシュでは `null` になる。

### Zaim Web版の家計簿明細一覧（aide#244）

`GET /v2/home/money`（公式API）は、**銀行・カード・スマートレシート由来の自動連携レコードを
返さない**（`src/core/connectors/zaim/write.ts:13-15` を参照。guchi-apps/asset-manager#379 で実測）。
`GET /api/money/transactions` は、Zaim Web版の家計簿一覧画面（`https://zaim.net/money?month=YYYYMM`）を
Playwrightで読むため、公式APIに現れない明細もここでは取得できる。一覧はDOMを仮想スクロールで描くため
（最初の23行ほどしか出ない）、DOMではなく画面が裏で読む `/money/details?month=YYYYMM` のJSONを読む（#481）。

**Zaimの「月」は暦月ではない。** 「月の開始日」設定（`ZAIM_MONTH_START_DAY`。既定25）に従い、
`month=202609` は 2026-08-25〜2026-09-24。ジョブは「今日を含むZaimの月＋その前月」を読み、
レスポンスの `months` には**全日を読めた暦月だけ**を入れる（asset-managerが暦月として読むため。
`src/core/connectors/zaim/zaim-month.ts`）。

| | |
|---|---|
| エンドポイント | `GET /api/money/transactions` |
| 返す内容 | 今日を含むZaimの月＋前月ぶんの明細一覧（`buildMoneyTransactions()`） |
| 認証 | `Authorization: Bearer $AIDE_READ_SECRET`（`/api/money/summary` と同じ値） |
| 取得ジョブ | `zaim-money-sync`（1日2回。実体は `src/core/connectors/zaim/money-list.ts`） |

```bash
curl -s -H "Authorization: Bearer $AIDE_READ_SECRET" http://127.0.0.1:3114/api/money/transactions
```

```jsonc
{
  "empty": false,
  "fetchedAt": "2026-09-02T14:35:00.000Z",
  "ageMinutes": 30,
  "stale": false,
  "months": ["202608", "202609"],
  "entries": [
    { "id": 10228209053, "date": "2026-09-02", "amount": 1238,
      "category": "食費", "genre": "調理食品", "account": "スマートレシート",
      "toAccount": "", "place": "ライフ 高槻城西店", "name": "SS大盛りペペロ…", "comment": "" }
  ],
  "note": "..."
}
```

**`id` は明細一覧の編集リンク（`/money/<id>/edit`）から取り出した値。** Zaimの`money_id`そのものなので、
呼び出し側（asset-manager等）はこれを使って二重登録を防げる。読めなかった場合だけ `null` になる。

**`name`（品目名）は、1件の明細に複数品目があると先頭の1件しか取れず、末尾が「…」で省略されることがある。**
これはZaim Web版の一覧表示そのものの仕様で、一覧を1回読むだけでは正確な全品目は分からない。編集画面
（`/money/<id>/edit`）を個別に開けば `var Receipt = {...}` というJS変数に品目ごとの正確なデータ
（`item_name` / `genre_id` / `amount`）が埋め込まれているが、これは明細ごとに追加のページ遷移が要るため
今回のクロール（一覧の1回読み）には含めていない。全品目が必須になった場合はそちらを実装する。

**対象は「当月＋先月（JST）ぶん」。** 月初直後に先月のカード連携明細が候補から漏れないよう、
`zaim-money-sync` が2か月ぶんを取得して1つのキャッシュにまとめる（aide#286）。`months` に実際に
読んだ月（`YYYYMM`）を返す。**先月分だけの取得に失敗した場合は当月のみで保存し、`months` も
当月だけになる**（当月分の取得に失敗した場合はジョブ全体が失敗し、キャッシュは更新されない）。
デプロイ直後、`months` を持たない旧キャッシュを返す場合は応答からこの項目自体を省く。呼び出し側は
`months` が無ければ従来どおり `fetchedAt` の月だけを読んだものとして扱う。

### キャッシュを素で返さない理由

`GET /api/cache/:key`（書き込みと対称な形）ではなくビューを出している。外へ見せる契約が1本で済み、
キャッシュの構造を後から変えられる余地が残る。素で返す口は、必要になった時点で足す。

### 読み取りと書き込みでシークレットを分ける

`AIDE_READ_SECRET` は `AIDE_INGEST_SECRET` とは**別の値**にする。同じ値を使うと、読みたいだけのアプリへ
キャッシュの書き込み権限まで渡すことになる。未設定なら読み取り口は503を返し、そもそも開かない。

### 公開範囲

呼び出し元（asset-manager 等）は同じVPS上で動くため、**`http://127.0.0.1:3114` で叩く**。外向けのURLを
経由する必要はない。

ただし `/api` を丸ごと外部から遮断することはできない。worker はサブPCから `POST /api/cache/:key` を
外向けURLへ送るためで、Apacheで絞る対象は `/api/money` と `/api/zaim` の2つに限る
（[公開URLからの遮断](#公開urlからの遮断)）。


## 個人アプリ向けのZaim登録API

car-care（給油記録）・asset-manager（レシート由来の支出）がZaimへ支出を登録するための口。実装は `src/api/zaim.ts`。

**この口はVPS内のアプリ専用のまま据え置く。** 外（VPS外）のClaude Code・Claudeアプリからの登録は
MCPツールで受ける（[外部のClaude CodeからのZaim登録](#外部のclaude-codeからのzaim登録mcp)）。

| | |
|---|---|
| エンドポイント | `POST /api/zaim/payment` / `GET /api/zaim/master` |
| 認証 | `Authorization: Bearer $AIDE_ZAIM_WRITE_SECRET` |
| 必要な設定 | 上のシークレットと、Zaim OAuthの4つ（`AIDE_ZAIM_CONSUMER_KEY` ほか）。**1つでも欠ければ503** |

```bash
curl -s -X POST -H "Authorization: Bearer $AIDE_ZAIM_WRITE_SECRET" \
  -H "Content-Type: application/json" http://127.0.0.1:3114/api/zaim/payment \
  -d '{"requestId":"car-care:fuel-log:1234","amount":6800,"date":"2026-08-19",
       "categoryId":101,"genreId":10101,"fromAccountId":12345,"place":"〇〇SS"}'
# => {"ok":true,"moneyId":987654321,"duplicated":false,"requestId":"car-care:fuel-log:1234"}
```

### 呼び出しの向きは「アプリ → AIDE」

読み取り（`GET /api/money/summary`）はアプリがAIDEから引くが、登録も**アプリからのpush**にしている。
登録済みかどうかの状態（Zaimの `money_id`）を持つのは各アプリのレコードで、登録の起点も画面操作だから。
AIDEがアプリを巡回して「未登録の支出」を集める形にすると、アプリごとに取得APIを生やすことになる。

### カテゴリ・ジャンルはAIDEが決めない

`categoryId` / `genreId` / `fromAccountId` は**呼び出し元がIDで指定する**。「ガソリン代 → 自動車費/ガソリン」
のような対応はアプリ側のドメイン知識で、AIDEに持ち込むとアプリが増えるたびにここが太る。
IDは `GET /api/zaim/master`（口座・カテゴリ・ジャンルの一覧）で引ける。連携先の設定時に一度引いて、
アプリ側の設定として持つ想定。
（MCP経由の呼び出し元はClaudeで状態を持たないため、そちらだけ24時間キャッシュを挟む。
[外部のClaude CodeからのZaim登録](#外部のclaude-codeからのzaim登録mcp)）

### 二重登録を止める

**同じ支出をZaimへ2回登録しても、この経路からは取り消せない**（作成だけを持ち、削除は持たない）。
呼び出し元が自分のレコードごとに一意な `requestId` を付け、AIDE側は
`data/zaim-payments.json` に `requestId` → `money_id` を記録する（直近500件）。

- **Zaimへ送る前に記録する。** 送った後に記録すると、応答が届かなかった場合に何も残らず、再送で二重登録になる
- 登録済みの `requestId` はZaimへ送らず、前回の `money_id` を `duplicated: true` で返す
- **前回の結果が確定していない `requestId` は 409 で止める。** 打ち切り・Zaim側の障害では登録された
  可能性が残るため、機械的な再送を許さない（人がZaimを確認し、未登録なら別の `requestId` で送り直す）
- Zaimが内容を拒んだ（4xx）ときだけ記録を消し、直してからの再送を許す

記録に書くのは `requestId`・`money_id`・時刻の3つだけで、**金額・店名・コメントは持たない**。
二重登録を防ぐのに要らないうえ、支出の中身そのものを持つのは取得・整形という責務から外れる。

### 応答の意味

| 状態 | 意味 |
|---|---|
| 200 | 登録できた（`duplicated: true` なら再送で、Zaimへは送っていない） |
| 400 | 入力が不正。直して送り直す |
| 409 | 前回の結果が不明。**再送しない**。Zaimを確認する |
| 422 | Zaimが内容を拒んだ。登録はされていない |
| 502 | Zaimへ届かない・打ち切り。登録されたかは不明 |
| 503 | `AIDE_ZAIM_*` が揃っておらず、口が開いていない |

### 公開範囲と、アプリ側の守り

呼び出し元は同じVPS上のアプリなので `http://127.0.0.1:3114` で叩く。ただし上記のとおり
**`/api` を丸ごと外部から遮断できない**ため、遮断が入るまではこの2本も公開URL上に出ている。
晒されるのは「書き込む口」だけでなく、`GET /api/zaim/master` が返す**口座名の一覧**も含む。

- 公開URLからの遮断はVPSのApache側で行う（[公開URLからの遮断](#公開urlからの遮断)）
- **遮断が入った後も、シークレットと総当たり対策は外さない。** Apacheを通らない
  `http://127.0.0.1:3114` を叩ける者（同じVPS上の他アプリ・別経路で入り込んだプロセス）には
  シークレットだけが盾になる。**認可画面と同じ総当たり対策**（送信元ごとに15分あたり5回まで・
  失敗時に固定の待ち・超過で429）を掛けている（`src/api/zaim.ts`）。回数の枠は画面のログインとは
  別に数える
- シークレットは `openssl rand -base64 32` 相当の長さにする（推測ではなく総当たりの対象になるため）

### 公開URLからの遮断

`/api/money` と `/api/zaim` は**同じVPS上のアプリが `127.0.0.1:3114` へ直接叩く口**で、公開URLを
経由して使う必要がない。`aide.gucchii.com` のVirtualHost（`guchi-apps/vps` リポジトリの
`apache/sites-available/aide.gucchii.com{,-le-ssl}.conf`）で、80番・443番の両方に次を置いて落とす。

```apache
<LocationMatch "^/api/(zaim|money)(/|$)">
    Require all denied
</LocationMatch>
```

- **`/api` を丸ごとは落とさない。** worker がサブPCから `POST /api/cache/:key` を公開URLへ送るため、
  ここが403になると巡回結果の投入が止まる
- `<Location>` の前方一致ではなく `<LocationMatch>` を使う。`/api/moneyfoo` のような隣接パスを
  巻き込まないため
- 403で落とす（404で存在を隠す案より、設定から意図が読み取れるほうを採った）

設定の反映は vps 側のIssue（[guchi-apps/vps#101](https://github.com/guchi-apps/vps/issues/101)）で行う。
**このリポジトリのデプロイでは反映されない。**

### アクセストークンの取得

consumer key / secret は [dev.zaim.net](https://dev.zaim.net/) でのアプリ登録で発行する。
アクセストークンはブラウザでの認可が要るため、実行時ではなく次のスクリプトで1回だけ取る。

```bash
AIDE_ZAIM_CONSUMER_KEY=xxx AIDE_ZAIM_CONSUMER_SECRET=yyy \
  node src/core/connectors/zaim/scripts/oauth-token.mjs
```

認可の画面は手元のPCのブラウザで開き、戻り先URLに付く `oauth_verifier` を貼り付ける。
取れた値は本番の `.env`（GitHubのsecret経由）と1Passwordにだけ置く。


## 個人アプリ向けの画像メール送信API

Research Desk（guchi-apps/research-desk#64）が、ブラウザ内で圧縮・ZIP化した画像を社用メールへ
即時送信するための口。実装は `src/api/image-mail.ts`。iCloudショートカット「画像を社用メールに
送る」と同等の操作を、Research Deskの画面から行えるようにする。

**呼び出し元はResearch Desk**のサーバー**（`src/app/api/image-mail/send/route.ts`。Supabase認証は
あちらで完結する）で、ブラウザではない。** サーバー間通信のためCORS対応は不要——`/api/zaim/payment`
と同じ構図。

| | |
|---|---|
| エンドポイント | `POST /api/image-mail/send`（`multipart/form-data`） |
| 認証 | `Authorization: Bearer $AIDE_IMAGE_MAIL_TOKEN`（Research Desk側の同名環境変数と同じ値） |
| 必要な設定 | 上のトークン、宛先（`AIDE_IMAGE_MAIL_TO`）、Gmail OAuthの3つ（`AIDE_GMAIL_CLIENT_ID` ほか）。**1つでも欠ければ503**。送信元（`AIDE_IMAGE_MAIL_FROM`）は任意 |
| リクエストの項目 | `title`（200文字まで）・`imageCount`（整数）・`width`（`1200`/`900`/`600`）・`idempotencyKey`・`zip`（2MiBまで） |

### 件名・宛先・送信元はAIDE側で固定する

件名は常に `[画像] {title}` で組み立てる。`[画像]` は固定文字列で、リクエストのどの項目からも
変更できない。宛先（`AIDE_IMAGE_MAIL_TO`）・BCC（`AIDE_IMAGE_MAIL_BCC`）・送信元
（`AIDE_IMAGE_MAIL_FROM`）もAIDE側の環境変数で固定し、リクエストに同じ項目があっても無視する
（Research Desk側もそもそも送らない）。**呼び出し元から任意のアドレスを名乗れないようにする**
ため、送信元だけをリクエスト項目にする例外は作っていない。

### 送信元はAIDEが保持するGmail資格情報

送信元GmailのOAuthクライアント・リフレッシュトークンはAIDEだけが持ち、Research Deskへは渡さない。
`googleapis` 等のSDKは入れず、依存ゼロの方針に従い `fetch` とMIMEの手組みだけで実装している
（`src/core/connectors/image-mail/gmail.ts`）。

`AIDE_IMAGE_MAIL_FROM` を設定すると、その値が `From` ヘッダに載る（aide#238）。
`user@example.com` と `表示名 <user@example.com>` のどちらの形でも書け、日本語の表示名は
RFC 2047でエンコードされる。**未設定なら `From` を書かず、Gmailが認可済みアカウントのアドレスで
補完する**（以前の挙動）。

**Gmailが `From` に許すのは、認可したアカウント本人か、Gmailの設定「アカウントとインポート →
名前 → 他のメールアドレスを追加」で確認済みの別アドレス（send-as alias）だけ。** それ以外を
指定すると送信時に拒否され、この口は422を返す。エイリアスの確認を済ませてから設定すること。

形式が不正な値（`@` が無い・改行を含むなど）を設定した場合は、Gmailへ送らず503を返す——
`From` へ素通しすると改行で任意のヘッダを差し込まれるため、`src/core/connectors/image-mail/gmail.ts`
の `formatFromAddress()` で弾いている。

`gmail.send` はGoogleの sensitive scope にあたり、OAuth同意画面の公開ステータスが「テスト」の
ままだとリフレッシュトークンが7日で失効する（[Gmailを載せていない理由](#gmailを載せていない理由aide173)
と同じ制約。あちらは読み取り、こちらは送信専用で権限が異なるため、Issue #230で改めて判断した）。
運用では同意画面を「本番」へ切り替えておく必要がある。

### 二重送信を止める

`idempotencyKey` が同じ再送はGmailへ送らず、前回の `messageId` を `duplicated: true` で返す。
考え方は[二重登録を止める](#二重登録を止める)と同じで、送る前に「結果不明」として記録し、
送信されなかったことが確実な場合（Gmailの拒否・資格情報の失効）だけ記録を消す。

### 応答の意味

| 状態 | 意味 |
|---|---|
| 200 | 送信できた（`duplicated: true` なら再送で、Gmailへは送っていない） |
| 400 | 入力が不正。直して送り直す |
| 409 | 前回の結果が不明。**再送しない**。Gmailの送信済みメールを確認する |
| 422 | Gmailが内容を拒んだ。送信されていない |
| 502 | Gmailへ届かない・打ち切り。送信されたかは不明 |
| 503 | `AIDE_IMAGE_MAIL_*` / `AIDE_GMAIL_*` が揃っていない、または `AIDE_IMAGE_MAIL_FROM` の形式が不正で、口が開いていない |

### 記録するもの・しないもの

送信成功・失敗、件数、横幅、ZIPサイズ、Gmail messageIdを `data/image-mail-log.json` に記録する
（`src/core/connectors/image-mail/log.ts`）。**タイトルは記録しない**——写真の内容を示唆する
文字列を平文ログへ溜めないため。**画像データ（ZIP本体）は送信処理後に保持しない。** メモリ上で
Gmail APIへ渡すだけで、ディスクへは一度も書かない。

### 公開URLからの遮断リストには入れない

Research Desk側のサーバーから直接届く必要があるため、`/api/money`・`/api/zaim` と違い
[公開URLからの遮断](#公開urlからの遮断)のApache設定には `image-mail` を入れない。


## 個人アプリ向けの業界ニュース週報メール送信API

Research Desk（guchi-apps/research-desk#110）が、画面で組み立てた業界ニュースの週報を社用メールへ
送信するための口。実装は `src/api/news-mail.ts`。[画像メール送信API](#個人アプリ向けの画像メール送信api)
（aide#230）と同じ作りで、**添付ファイルではなくHTML/テキストの本文を受け取る**点だけが違う。

**呼び出し元はResearch Desk**のサーバー**（guchi-apps/research-desk#111）で、ブラウザではない。**
サーバー間通信のためCORS対応は不要——画像メールと同じ構図。

| | |
|---|---|
| エンドポイント | `POST /api/news-mail/send`（`application/json`） |
| 認証 | `Authorization: Bearer $AIDE_NEWS_MAIL_TOKEN`（Research Desk側の同名環境変数と同じ値。**`AIDE_IMAGE_MAIL_TOKEN` とは別の値**） |
| 必要な設定 | 上のトークン、宛先（`AIDE_NEWS_MAIL_TO`）、Gmail OAuthの3つ（`AIDE_GMAIL_CLIENT_ID` ほか。画像メールと共用）。**1つでも欠ければ503**。送信元（`AIDE_NEWS_MAIL_FROM`）は任意 |
| リクエストの項目 | `idempotencyKey`（200文字まで）・`subject`（先頭 `[業界ニュース] ` 込みでResearch Desk側が組み立て済み）・`bodyText`・`bodyHtml`・`articleCount`（ログ用の記事数） |

### 件名はリクエストの値をそのまま使い、宛先・送信元だけAIDE側で固定する

画像メールは件名を `[画像] {title}` としてAIDE側で組み立てるが、こちらは**件名をResearch Desk側で
組み立て済みとして、そのまま使う**。宛先（`AIDE_NEWS_MAIL_TO`）・BCC（`AIDE_NEWS_MAIL_BCC`）・
送信元（`AIDE_NEWS_MAIL_FROM`）はAIDE側の環境変数で固定し、リクエストに同じ項目があっても無視する
（Research Desk側もそもそも送らない）。本文（`bodyText`・`bodyHtml`）はResearch Desk側で組み立て済みで、
差し込み値はすべてエスケープ済みのため、AIDE側でHTMLのサニタイズは行わない。

### `multipart/alternative` でテキストとHTMLの両方を送る

`src/core/connectors/image-mail/gmail.ts` の `buildAlternativeMimeMessage()` / `sendGmailAlternativeMessage()`
で組み立てる。`buildMimeMessage()`（画像メールの `multipart/mixed`）とは別の関数で、**テキストパートを
HTMLパートより先に置く**（RFC 2046の「後のパートほど優先して表示される」規定により、HTML非対応の
メールクライアントにもテキストを見せるため）。Gmail資格情報・送信元アドレスの検証（`formatFromAddress()`）は
画像メールと共通の実装を使う。

### 二重送信を止める・応答の意味・記録するもの

考え方・実装（冪等記録・失敗の種類分け・応答ステータス）は
[画像メール送信API](#個人アプリ向けの画像メール送信api)と同じで、状態は別ファイル
（`src/core/connectors/news-mail/idempotency.ts` / `log.ts`）に持つ。記録するのは成功・失敗・
記事数（`articleCount`）・HTML本文のバイト数・Gmail messageIdまでで、**件名・本文は記録しない**
——記事の見出し・要約を平文ログへ溜めないため。

### 公開URLからの遮断リストには入れない

画像メールと同じ理由で、[公開URLからの遮断](#公開urlからの遮断)のApache設定には `news-mail` を
入れない。


## ChatGPTからAsset Managerへ請求情報を取り込む（MCP）

ChatGPTのスケジュールからGmailの請求情報を取り込む経路として、MCPツール
`asset_manager_import_payment` を提供する（#199）。このツールはZaim APIを直接呼ばず、
Asset Managerの `POST /api/receipts/import` だけを呼び出す。`gmailMessageId` と
`confidence` は必須で、`source: "gmail"` はAIDE側が付与する。同じ `gmailMessageId` の再送は
Asset Manager側の冪等性で `duplicate` になる。

`date` は購入日時で、`YYYY-MM-DD` に加えて `YYYY-MM-DDTHH:mm`（秒・末尾の `Z` / `+09:00` も可）を
受け付ける（#236）。書式はAsset Manager側の `parsePurchasedAt`（`lib/receipt-service.ts`）に
合わせてあり、タイムゾーンを省いた値はAsset ManagerがJSTとして解釈する。**時刻を付けるのは、
メール本文に購入時刻・利用時刻が印字されていて読み取れるときだけ**で、読み取れない・自信が無い
ときは日付だけを送る（推測した時刻を送らない）。**メールの受信日時（`internalDate`・`Date`
ヘッダ）を購入時刻として使ってはいけない**——請求メールは購入から数時間〜数日遅れて届くため、
家計簿に誤った購入時刻が残る。Zaimの支出に時刻の概念は無いので、時刻が残るのはAsset Manager側だけ。

電気・ガスなど使用量が書かれた請求メールでは、任意項目の `usage`（32文字以内）に本文の表記の
まま渡せる（例: `258kWh`、`12m3`）。単位表記の正規化はAsset Manager側が行うため、AIDEは
本文の表記を変換せずそのまま送る。使用量を `name` に含めてはいけない（分類履歴のキーに影響
するため）。本文から読み取れない・自信が無い月は `usage` を省略する（#223）。

金額の精度は、任意の4項目で伝える（#341。Asset Manager側は asset-manager#483）。
`amountApproximate`（boolean。金額が正確でない可能性がある）・`amountNote`（理由。191文字以内。
例: 「USD 9.99 を 1ドル=150.2円で換算」）・`originalAmount`（外貨建ての元の金額。正の数）・
`originalCurrency`（ISO 4217の3文字。例: `USD`）を、AIDEは検証だけして加工せず転送する
（判定基準はAsset Managerの `validatePaymentImportInput` に揃えてあり、通貨コードの大文字化も
向こうが行う）。**ドル建てなど外貨の請求メールでは `originalAmount` / `originalCurrency` を必ず
付け、`amount` には円へ換算して整数へ丸めた金額を入れる**（`amount` は整数のみで、丸めずに
小数を送ると送信前に `status: error` になる。換算レートと丸めは `amountNote` に書く）。
ツール説明で指示するだけで、`original*` は実行時には必須にしない（読み取れない請求メールまで
弾いてしまうため）。`originalCurrency` が `JPY` 以外なら
`amountApproximate` を省いてもAsset Manager側が概算として扱い、概算の明細はZaimへ自動登録されず、
Asset Managerの突合せタブでカードの連携明細の金額に合わせてから登録する。

**リリース順に注意する。** この受け入れ実装は asset-manager の `develop` にあり、`main` には
未反映（#341の時点）。`main` の受け口は4項目を知らないため、AIDEを先に本番へ出しても400には
ならず、**項目が黙って捨てられて通常の明細として扱われ**、外貨の請求が概算にならずZaimへ自動登録
されうる。**asset-manager の main 反映 → AIDE の本番反映**の順にする。

Asset ManagerのレスポンスJSON（`status`、`receiptId`、`zaimMoneyId`、`reason` 等）は加工せず返す。
認証用の `ZAIM_SYNC_SECRET` は `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET` としてAIDE側だけが保持し、
MCPの入力・出力・ログへは出さない。本番URLは `AIDE_ASSET_MANAGER_URL`（既定は
`https://asset.gucchii.com`）で指定する。デプロイ時のsecret/variable配線は
`.github/secrets-manifest.tsv` と `.github/workflows/deploy.yml` が正である。

## Asset Managerのサブスクを読む（MCP）

「いま何にいくら払っているか」「次に何が更新されるか」に答えるための読み取りツール
`asset_manager_subscriptions`（#345）。asset-manager#491 でサブスク管理アプリ（旧 subscription-lists）の
機能が Asset Manager へ移管され、その読み出し口 `GET /api/subscriptions[?includeEnded=1]` を呼ぶ。
実装は `src/mcp/tools/asset-manager.ts`。引数は `includeEnded`（真偽値。既定は解約済みを含めない）だけ。

認証・宛先は取り込み（上）と同じ `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET`・`AIDE_ASSET_MANAGER_URL`で、
**新しい環境変数・secret は要らない**（Asset Manager 側の対象ユーザーも同じ `ZAIM_SYNC_USER_EMAIL` で決まる）。
応答（`summary`・`subscriptions`）は**加工せず返す**。月額換算・次回請求日・契約状況・円換算は向こうが
計算済みで、こちらで再計算すればズレる。仕様は asset-manager の `docs/subscriptions.md`。

ツールの説明で、答え方を取り違えやすい点を指示している。

- **「1回あたり」と「月あたり」は別物。** 「いくら払っている？」には `monthlyAmountJpy`、「次にいくら請求される？」には `amount`
- **解約予定（`SCHEDULED_TO_END`）は合計に含まれる**（まだ払っているため）。「解約したもの」は `ENDED` だけ
- `usdJpyRate` が `null` のときドル建ては合計から外れる。**`summary.excludedFromTotal` が空かを見てから**合計を答える

### `aide_fixed_costs` との関係

**どちらも同じ Asset Manager の `GET /api/subscriptions` を読む**（#347。以前は `aide_fixed_costs` だけが
旧ソース subscription-lists を読んでいて、同じ問いに別のデータで答えうる状態だった）。
役割は**粒度**で分ける。

| | `aide_fixed_costs` | `asset_manager_subscriptions` |
|---|---|---|
| 返すもの | 畳んだ要約。通貨別の月額合計・支払方法別の合計・明細・31日以内の支払予定 | APIの応答そのまま。契約ごとのプラン・料金改定の履歴・ラベル・契約期間・解約予定の終了日など |
| 対象 | 固定費全体（サブスク・保険・税金・分割払いなど） | 全区分。`summary.monthlyTotalJpy` はサブスク区分だけ、全体は `summary.fixedCost*` |
| 使いどころ | 「毎月いくら出ていくか」「どのカードから落ちるか」 | 契約の中身を見る・料金改定の履歴を調べる・登録前に `id` や支払方法名を確かめる |

固定費を `asset_manager_subscriptions` に任せて `aide_fixed_costs` を外す案は採らなかった。支払方法別の
合計と31日以内の支払予定は Asset Manager の応答に無くAIDE側で積み上げており、`GET /api/money/summary` の
`fixedCosts` も同じ器で読まれているため、外すと読み手が壊れる。

## Asset Managerのサブスクを登録・料金追加する（MCP）

`asset_manager_create_subscription` と `asset_manager_add_subscription_price`（#346）は、サブスクの初回登録と価格改定の記録を行う書き込みツールである。読み取りの `asset_manager_subscriptions` とは別ツールにし、MCPクライアント側で書き込みの承認を分ける。

新規登録では `name`・`paymentMethodName`・契約開始日と、初回料金（`amount`・通貨・請求周期・適用開始日）を渡す。支払い方法は Asset Manager に登録済みの名前を使う。料金改定では一覧が返した `id` と改定後の料金を渡す。**既存料金を更新しない。** 値上げ・値下げ・請求周期の変更はいずれも `effectiveFrom` を持つ料金履歴を1件追加する。

サブスク・料金の編集と削除は持たない。AIDE は ChatGPT と Claude Code を認可上区別できず、削除だけを片方へ安全に制限できないためである。特に削除は料金履歴まで失い、README の「作成だけ」の原則にも反する。

認証・宛先は読み取りと同じ `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET`・`AIDE_ASSET_MANAGER_URL` を使い、新しい環境変数・secret は要らない。入力は AIDE 側と Asset Manager 側の両方で検証し、Asset Manager が返した成功・入力エラーの JSON をそのまま返す。

**リリース順に注意する。** 書き込み API は asset-manager#502 が `main` へ反映されてから使える。**asset-manager の main 反映 → AIDE の本番反映**の順にする。読み取りツールだけは受け口が asset-manager の `develop`・`main` の両方に入っている（#345）。

## 電気代・ガス代を読む（MCP）

「今月の電気代」「先月のガス使用量」「最近の推移」に答えるための読み取りツール
`aide_utility_bills`（#324）。実装は `src/core/views/utility-bills.ts`（集計）と
`src/core/connectors/zaim/read.ts`（Zaim公式APIの `GET /v2/home/money`）。引数は `kind`
（`electricity` / `gas` / `all`）と `months`（今月を含めて遡る月数。既定13・上限36）。

### 情報源はZaim公式API

電気・ガスの請求メールは、上の `asset_manager_import_payment` で Asset Manager へ取り込まれ、
Asset Manager が**Zaim APIで**支出として登録する。そのため公式APIで期間を指定して読める。
ほかの経路は推移に使えないので採っていない。

- **Asset Manager には電気・ガスの請求を読める口が無い**（読み取りは `GET /api/subscriptions` のサブスクだけで、レシート・明細は返さない）
- **Web版の一覧のキャッシュ（`zaim-money-snapshot`）は当月＋先月ぶんしか持たない**。巡回はPlaywrightで重く、月を増やせない

公式APIは**自動連携（カード等）の明細を返さない**。電気・ガスがカード払いで、請求メールからの
取り込みを経ずに自動連携の明細だけがある月は、この経路からは見えない。

鮮度は呼び出しのたびに引くので常に最新。ジャンルの対応表は `aide_zaim_master` と同じ24時間キャッシュ
（`src/core/views/zaim-master.ts`）を使う。Zaimへの問い合わせは種類ごとにジャンルの数だけ（通常は電気・ガスで2本）。

### どれを電気・ガスとみなすか

**Zaimのジャンル名に「電気」「ガス」を含むもの。** 品名・店名では拾わない（「ガス」を含む飲食店名などを
拾うため）。該当するジャンルが無いときは、その種類だけ `unavailable` に理由を入れて返す。

### 使用量と日付

- **使用量は品名から読む。** Asset Manager は `usage` を品名の末尾へ足して登録する（「電気料金 258kWh」。
  asset-manager#307）。`kWh` と `m3`（`㎥`・`m³`・`立方メートル` を寄せる）だけを読み、書かれていない月は `null`
- **検針期間（対象期間）は持っていない。** Zaimの明細は日付を1つしか持たず、それは請求・支払の日。
  月ごとの集計（`monthly`）もこの日付の月で束ねる
- 前月比・前年同月比は、明細のある最新の月から**暦の**前月・前年同月を見る。その月に明細が無ければ `null`
  （明細のある直前の月へずらさない）

## 外部のClaude CodeからのZaim登録（MCP）

上のHTTP APIは**VPS内のアプリ専用のまま据え置く**。外（VPS外）のClaude Code・Claudeアプリから
登録するための口は、OAuth Bearerで守られている `/mcp` の側にMCPツールとして持つ（aide#135）。
実装は `src/mcp/tools/zaim.ts` と `src/core/views/zaim-master.ts` で、Zaimを叩く本体
（`src/core/connectors/zaim/write.ts`）はHTTP APIと共用している。

| ツール | 役割 |
|---|---|
| `aide_zaim_master` | 口座・カテゴリ・ジャンルの候補（IDと名前）を返す。読み取りのみ |
| `aide_zaim_payment` | 支出を1件登録し、`moneyId` と登録された内容を返す |

**1本に畳んでいない。** `aide_dev_status` のように読み取りを1本へ畳む前例はあるが、ここは
読みと書きなので、畳むとClaude Code側で「常に許可」にしたときに書き込みまで素通しになる。
承認の粒度が変わるので分ける。

### マスタは24時間キャッシュする

`GET /api/zaim/master` は「連携先の設定時に一度引く」前提で**キャッシュを持たない**。
呼び出し元がアプリならアプリ側の設定として持てるが、**Claudeは状態を持たないので登録のたびに引く**。
そのまま通すとZaimのAPIが1回の登録で3本飛ぶため、キャッシュ（`data/cache/zaim-master.json`）を挟む。

- 鮮度の基準は**24時間**。`src/core/views/money.ts` と同じ値で、Zaim由来のデータに対する既存の基準に揃えた。
  口座の新設・カテゴリのカスタマイズは月に1回あるかどうかの操作なので、これで十分短い
- **workerジョブにはしない。** Playwright巡回ではなくOAuthのHTTP GET 3本で、
  [「重い取得」の基準](#どこまでを重い取得とみなすか)では「都度叩く」側に近い。
  ジョブにすると口座を作った直後に次の同期まで候補へ出てこない
- **古いキャッシュを掴んだときの逃げ道を持つ。** `aide_zaim_master` の `refresh: true` のほか、
  `aide_zaim_payment` は渡されたIDがマスタに無ければ**自動で一度だけ引き直す**
- キャッシュのキーは `POST /api/cache/:key` の許可キー（`src/api/ingest.ts`）へ**足さない**。
  書くのはこのサーバー自身だけで、受け口から「どのIDがどの口座か」を差し替えられる理由が無い
- **`GET /api/zaim/master` にはキャッシュを挟まない。** 設定時にしか呼ばれないため毎回叩いてよく、
  **経路によって鮮度が違う**（`fetchZaimMaster()` は素のまま、鮮度の扱いは呼び出し側が持つ）

### 冪等キーは支出の内容から作る

HTTP APIの `requestId` は「呼び出し元のレコードを指す文字列」（`car-care:fuel-log:1234`）だが、
**Claudeには対応するレコードが無い。** 毎回新しい値を作らせると、同じ支出を2回言うだけで2件登録され、
この経路からは取り消せない。そこでAIDE側が内容から決める。

- キーは `mcp:<SHA-256の先頭16桁>`。材料は**日付・金額・カテゴリ・ジャンル・口座・店名・品名**
- **`comment` は材料に混ぜない。** メモを書き換えただけで別の支出とみなされ、判定をすり抜けるため
- **キーを平文にはしない。** `data/zaim-payments.json` は「`requestId`・`money_id`・時刻の3つだけ」
  という方針で、内容をそのまま並べた値を置くと支出の一覧そのものになる
- **ただし「復元できないから安全」ではない。** 材料の取りうる範囲は狭く（金額は上限30万円、
  日付は数十通り、カテゴリ・ジャンルはマスタから既知）、総当たりで元の値へ戻せる。
  安全側の根拠は復元の難しさではなく、**この値を `data/` とサーバーログの外へ出さないこと**に置く。
  MCPの応答に `requestId` は載せない（返すのは `moneyId` と登録内容だけ）。
  固定のsaltを混ぜる案は採らない——saltが変われば同じ支出が別の鍵になり、判定そのものが効かなくなる
- 既に同じキーの記録があれば**登録せずに止め**、既存の `moneyId` を返す。同じ日・同じ店・同じ金額の
  **正当な2件目**は、利用者に確認したうえで `allowDuplicate: true` を付けると `mcp:...#2` として通る
- **前回の結果が確定していない記録（`money_id` が null）は `allowDuplicate` でも跨がせない。**
  `createZaimPayment()` の `conflict` 判定は `requestId` の完全一致なので、連番で別の鍵にすると
  素通りしてしまう。同じ系列に1件でもあれば `conflict` のまま止め、Zaimの画面で確認してもらう
- 連番は件数ではなく**空き番号**で決める。古い記録は500件で落ちるため、件数から作ると
  残っている番号と衝突し、別の支出が「登録済み」として素通りする

### 会話由来の入力に対する歯止め

`write.ts` の `MAX_AMOUNT`（1億円）は「アプリが桁を1つ間違えた」を止めるためのもので、
**会話からの入力には緩い。** MCP経由だけ次を足している。

- **1件30万円まで**（`MCP_MAX_AMOUNT`）。超えるものはZaimの画面から登録してもらう
- **未来の日付は登録しない**（日本時間の暦日で判定）
- **カテゴリ・ジャンル・口座のIDがマスタに実在するかを、Zaimへ送る前に確かめる。**
  ジャンルが指定カテゴリのものかまで見る（Zaimは `mapping=1` で両方をIDで受け取るため、
  噛み合わない組み合わせは意図しない分類になる）
- 登録できたら `moneyId` と併せて、**解決後の口座名・カテゴリ名・ジャンル名を含む登録内容**を返す。
  桁違い・日付の取り違えに、利用者がその応答で気づけるようにするため

**カテゴリ・ジャンルの名寄せは持たない。** 「ガソリン代 → 自動車費/ガソリン」の対応はここでも作らず、
Claudeが `aide_zaim_master` の一覧から選ぶ。AIDEにドメイン知識を持ち込まない方針はHTTP APIと同じ。


## 認証

ClaudeアプリからリモートMCPサーバーへ接続するための OAuth 2.1 を実装している。認可サーバーとリソースサーバーを同一プロセスに置いている（利用者が1人で、分ける利点がないため）。

**ここで扱うのは「機械（Claudeアプリ）をこのサーバーへ接続させる」ための認可で、利用者の身元は問わない。** ブラウザでアプリ連携ページ（`/map`）を開くほうは別系統で、許可したGoogleアカウントだけが通る（[アプリ連携ページ](#アプリ連携ページ) を参照）。

### 起動時に必ず決まる

**`AIDE_AUTH_PASSWORD` が未設定だと起動しない。** 認証なしのまま公開してしまう事故を、設定ミスではなく起動失敗として顕在化させるため。

無効にするには `AIDE_AUTH_DISABLED=1` を明示する。その場合は起動時に警告を出す。

### Claudeが叩くパス

実測（2026-08-14）で判明した順序。**404を返すとClaudeは無認証のまま接続を継続してしまう**ため、必ず応答する。

```
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
```

未認証で `/mcp` を叩かれた場合は、401 と `WWW-Authenticate: Bearer resource_metadata="..."` を返す。このヘッダが無いとClaudeはディスカバリを始めない。

### フロー

動的クライアント登録（RFC 7591）→ 認可コード + PKCE（S256必須）→ トークン。
クライアントは動的登録のため `client_secret` を持たない。その代わりに PKCE を必須にしている。

利用者の認証はパスワード1つ。凝った作りにすると壊れるうえ、利用者が1人なら得るものが無い。

### トークン

不透明なランダム文字列で、サーバー側で照合する。JWTと違い**即座に失効させられる**ことを優先した。

```bash
rm data/auth/oauth-state.json   # 全トークンを即時失効
```

有効期限はアクセストークン30日・リフレッシュトークン180日と長い。個人利用で再認証の手間を避けるためで、上記の失効手段があることが前提。リフレッシュはローテーションする（使ったリフレッシュトークンは無効化する）。リフレッシュトークンの期限（`refreshExpiresAt`）はアクセストークンの期限（`expiresAt`）とは別に持ち、アクセストークンが切れた後も180日までは更新できる。保存済みの状態から落とすのは、リフレッシュトークンの期限も過ぎたものだけ。

### 総当たり対策

公開URL上に単一パスワードのフォームを晒すため、回数制限を入れている。

| 対象 | 制限 |
|---|---|
| 認可（パスワード） | 失敗ごとに約0.7秒待つ。15分間に5回失敗で15分ロック（`Retry-After` を返す） |
| 動的クライアント登録 | 送信元ごとに1時間20件まで |

画面のGoogleログインには回数制限を置いていない。総当たりできるパスワードが無く、
許可リストに載っているかどうかはGoogleでのログインを終えて初めて判定されるため。

ロックは**送信元ごと**に独立している。全体で1つにすると、第三者が失敗を繰り返すだけで正規利用者を締め出せる。送信元の判定は `X-Forwarded-For` の**末尾**を使う（プロキシ配下では socket のアドレスが全リクエストで同じになり、制限が機能しないため）。先頭はクライアントが自由に書ける値で、Apache（mod_proxy）は既存の値を消さずに末尾へ実際の接続元を足す。先頭を採るとリクエストごとに値を変えるだけで制限を外せる（#300）。

- **プロキシが1段（Apache、開発では cloudflared）であることが前提。** 前段にCDN等を足すと末尾がそのCDNのアドレスになり、全員が同じ送信元に数えられる（1人の失敗で全員ロックされる）
- 転送ヘッダを信用するのは接続元がループバック（=手前のプロキシ）のときだけ。サブPCの受け口のようにTailscaleのアドレスで直接受ける口では socket のアドレスを使う
- 記録する送信元は1万件までで、超えたら期限切れを掃除し、それでも空かなければ古いものから捨てる。大量の送信元から失敗を送るだけでヒープを食い潰されないようにするため

状態はプロセス内メモリに置く。再起動で消えるが、試行のたびにディスクへ書くと、書き込み負荷でサービスを劣化させる材料を与えることになる。

**登録エンドポイントは仕様上（RFC 7591）未認証で公開される。** 無制限に受け付けると状態ファイルが際限なく膨らむため、ここにも上限を設けている。

### 設計上の注意

- **`redirect_uri` が登録内容と一致しない場合、そこへリダイレクトしない。** エラーもクライアントへ返さず認可画面で止める。緩めるとオープンリダイレクトになる
- **パスワード照合は長さが違っても同じ経路を通す。** 早期returnすると処理時間からパスワード長を推測される
- **公開URLはリバースプロキシのヘッダから解決する。** Apache や cloudflared の背後ではHostが公開名と異なる。メタデータのURLがずれるとクライアントが別ホストへ飛んで認証が壊れる

### 既知の未整理

Claudeは `Anthropic/Toolbox` と `Anthropic/ClaudeAI` の2クライアントで接続するため、再接続のたびに登録が積み上がる。実害は無いが、肥大化したら同一 `client_name` + `redirect_uri` の再利用を入れる。


## 本番

| | |
|---|---|
| ポート | 3114（vps README の予約済みポートに登録済み） |
| 想定ドメイン | `aide.gucchii.com` |

### 環境変数の配線

**本番の `.env` は `deploy.yml` が毎回まるごと上書きする。** VPS上で手で追記した値はデプロイのたびに
消える。消えても例外にはならず、そのコネクタが「未設定」を返すだけなので、次に呼ぶまで誰も気づけない
（実際に `AIDE_GITHUB_TOKEN` と `AIDE_OPS_DASHBOARD_TOKEN` がその状態だった。#55）。

実行時に本番で要る値を足すときは、**5か所すべて**に通す。

| # | 場所 | 役割 |
|---|---|---|
| 1 | `.github/secrets-manifest.tsv` | 1Password（正）と GitHub secret/variable の対応表 |
| 2 | `deploy.yml` のジョブの `env:` | GitHub側の値を取り出す。`scripts/generate-workflow-env-block.sh` で生成する |
| 3 | 「Deploy and restart」ステップの `env:` | SSHアクションへ渡す |
| 4 | 同ステップの `envs:` | **appleboy/ssh-action はここに列挙した名前しかリモートへ渡さない** |
| 5 | 同ステップの `.env` heredoc | 実際にVPSへ書き出す |

1Password 側へ値を入れたら `scripts/sync-github-secrets.sh --only <KEY>` で GitHub Secret へ同期する
（実行時に1Passwordは呼ばない。#1）。トークン類は未発行でもデプロイを止めないよう `${VAR:-}` で書き、
空ならAIDE側が「未設定」として振る舞う。

この5か所の抜けは `src/deploy-env-wiring.test.ts` が検査する。`src/` が読む `AIDE_*` は、すべて
配線されているか、テスト内の `NOT_REQUIRED_IN_PRODUCTION` に理由付きで登録されているかのどちらかになる。

**この検査は `process.env["AIDE_XXX"]` という直接参照だけを走査する（aide#230）。**
`readResearchDeskConfig(env: NodeJS.ProcessEnv = process.env)` のように、テストでenvを
差し替えられるようにする目的で関数の引数に持たせ、内部では `env["AIDE_XXX"]` と間接的に
読む書き方をすると、この走査から漏れる——本番で値が空でも検査は気づかない。**実行時に
本番で要る `AIDE_*` は、`src/api/zaim.ts` の `zaimWriteSecret()` のように引数を取らず
`process.env["AIDE_XXX"]` を直接参照する形にする。** テスト側は `process.env["AIDE_XXX"] = "..."`
を実際にセット・削除して差し替える。

コメント中に環境変数名をワイルドカード付きで例示するときも要注意で、
`` `process.env["AIDE_GMAIL_*"]` `` のように `process.env["..."]` の形で書くと、正規表現が
`*` の手前までを1つの名前として拾い、存在しない `AIDE_GMAIL_` の配線漏れとして誤検出する。
コメントでは `AIDE_GMAIL_*` を直接参照する、のように地の文で書く。
