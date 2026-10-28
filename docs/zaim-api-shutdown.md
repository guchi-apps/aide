# Zaim公式APIの終了に伴う棚卸しと移行（#714）

くふう Zaim は **2026-12-07 中に Zaim API の全エンドポイントと Developers Center を順次停止**し、
後継APIは提供しない。API経由で取得・保存したデータとOAuth認証情報は、提供終了後すみやかに、
**遅くとも 2027-01-07 までに**開発者側で削除するよう求められている（公式告知:
https://content.zaim.net/notices/show/2280）。Zaim本体のアプリ・Webは継続する。

この文書は、AIDEのどこが公式APIに依存していたか・各機能をどう判断したか・何を消し何を残すかの記録。
**実値（トークン・口座名・明細・件数）は載せない。** 確認した時点の事実で、連携先や本番の状態が
変わったら照合し直す。

## 1. 機能ごとの棚卸しと判断

| 機能 | 呼び出し元 | 依存していたもの | 判断 | いまの挙動 |
|---|---|---|---|---|
| `POST /api/zaim/payment`（#37） | なし（下記「連携先の照合」） | OAuth・`POST /v2/home/money/payment`・冪等記録 | **廃止** | 認証より先に 410（`kind: "retired"`・移行先 `/api/zaim/payment/web`） |
| `GET /api/zaim/master`（#37） | なし | OAuth・口座/カテゴリ/ジャンルの取得 | **廃止**（代替なし） | 410（`kind: "retired"`） |
| MCP `aide_zaim_payment`（#135） | 会話（Claude） | 上と同じ本体＋MCP用の冪等キー | **廃止**（利用者が選択） | Zaimへ何も送らず、廃止の理由と「Zaimの画面で登録する」を返す |
| MCP `aide_zaim_master`（#135） | 会話（Claude） | 上と同じ本体＋24時間キャッシュ | **廃止**（利用者が選択） | 廃止の理由だけを返す |
| MCP `aide_utility_bills`（#324） | 会話（Claude） | `GET /v2/home/money`（ジャンル指定）＋マスタ | **kurashio の月次請求へ移行**（利用者が選択） | kurashio の内部APIで請求月・金額・使用量を読む。無い値は `null` |

MCPの2ツールは**カタログに残している**。消すとClaudeには「ツールが無い」としか見えず、
なぜ登録できないのかが利用者に伝わらないため。

**Web画面経由の登録へ付け替えなかった理由。** `/api/zaim/payment/web` は分類を**名前**で受け取り、
口座・分類の一覧を返す口を持たない。会話から安全に登録する（実在する口座・分類だけを選ばせる、
二重登録を内容から止める）には、Web画面から一覧を読む新しい実装が要る。必要になったら別Issueで行う。

### 公式APIに依存していない（触っていない）経路

| 経路 | 手段 | 資格情報 |
|---|---|---|
| 残高・保有銘柄の巡回（`zaim-sync`・`zaim-refresh`・`zaim-keep-alive`） | Playwright（サブPCのworker） | ログイン状態（storage state） |
| 明細一覧の巡回（`zaim-money-sync`・`GET /api/money/transactions`） | 同上 | 同上 |
| `POST /api/zaim/payment/web`・`/web/genre`・`/web/memo`・`/api/zaim/receipt-detail/refresh` | 同上（VPSはサブPCの受け口へ中継） | 同上＋`AIDE_ZAIM_WRITE_SECRET` |

これらは**事業者が提供する後継APIではなく、画面の自動操作**。継続利用の可否（利用規約）と
画面変更で壊れるリスクは公式APIの終了と別の論点として残る（下記「残る論点」）。

### 連携先の照合（2026-10-28T14:41Z）

Issueの open/closed ではなくブランチの実物で確かめた（`git grep`）。

| リポジトリ | 確認したSHA | AIDEのZaim口の利用 |
|---|---|---|
| guchi-apps/asset-manager | `main` d0e8b51 / `develop` 9c3c9b0 | `/api/zaim/payment/web`・`/web/genre`・`/web/memo`・内訳の再取得だけ。`/api/zaim/payment`・`/api/zaim/master` は呼んでいない（#302 で移行済み） |
| guchi-apps/car-care | `main` 00ffd41 / `develop` a0eaa3a | AIDEのZaim口を呼んでいない（car-care#141 で廃止済み） |

asset-manager 自身が持つ公式APIクライアント（`lib/zaim-api.ts` など）は asset-manager#788 で扱う。
Web経路の `fromAccountId` は入力画面の口座の選択肢の値（公式APIの口座IDと同じ値）なので、公式API停止後も
登録は動く。ただし**新しい口座のIDを引く手段は無くなった**（asset-manager#788 側の論点）。

## 2. 認証情報と保存データ

| 対象 | 由来 | 置き場 | 判断 |
|---|---|---|---|
| `AIDE_ZAIM_CONSUMER_KEY` / `_SECRET`・`AIDE_ZAIM_ACCESS_TOKEN` / `_SECRET` | 公式API（OAuth 1.0a） | 1Password（`op://apps/aide/zaim-*`）・GitHub repo secret・VPSの `.env` | **削除**。コード・`deploy.yml`・`secrets-manifest.tsv` からは本PRで外した。実値の削除は本人（下記） |
| `data/zaim-payments.json`（`AIDE_ZAIM_PAYMENT_LOG_PATH`） | 公式API経由の登録の冪等記録（requestId・money_id・時刻） | VPS | **削除**。読むコードは本PRで撤去した |
| `data/cache/zaim-master.json` | 公式APIで取った口座・カテゴリ・ジャンル | VPS | **削除**。読むコードは本PRで撤去した |
| VPS・サブPCのバックアップに含まれる上の2ファイル | 同上 | バックアップ先（本人が確認） | バックアップの範囲を確かめ、含まれていれば削除または期限切れを確認 |
| `AIDE_ZAIM_WRITE_SECRET` | AIDE内部の共有シークレット | 共有トークン・`.env` | **保持**。Web経路の認証に使う |
| `data/zaim/storage-state.json`・巡回キャッシュ（`zaim-balance`・`zaim-money-snapshot` 等）・`data/zaim-web-*.json` | Web画面（ログイン状態・巡回） | サブPC・VPS | **保持**。公式API由来ではない |
| Zaim本体の家計簿データ（公式APIで登録した明細を含む） | 利用者の家計簿 | Zaim | **触らない**。開発者側のデータではない |

## 3. 期限までの作業（本人確認が要るもの）

コードの撤去は本PRで終わる。**不可逆な削除と本番の確認は本人が行う**（実値をIssueに載せない。追跡は #726）。

1. **2026-12-07 まで** — 本PRを本番（`main`）へ出したあと、次を読み戻しで確かめる
   - `/api/app-version` の `sha` が本PR以降であること
   - `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3114/api/zaim/payment` が 410 であること
   - MCP `aide_utility_bills` が kurashio の請求を返すこと（`configured: true`・`unavailable: null`）
   - 公式APIを叩くコードが残っていないこと（`git grep -n "api.zaim.net" origin/main` が空）
2. **2027-01-07 まで** — 認証情報と保存データの削除
   - VPSの `.env` から `AIDE_ZAIM_CONSUMER_*` / `AIDE_ZAIM_ACCESS_*` の行が消えたか（デプロイgateが送らない値を残すかは要確認）
   - GitHub の repo secret 4つを削除
   - 1Password の `op://apps/aide/zaim-consumer-key` ほか4項目を削除（アーカイブで済ませない）
   - VPSの `data/zaim-payments.json`・`data/cache/zaim-master.json` を削除し、バックアップでの扱いを確認
   - Zaim Developers Center のアプリ登録が停止までに消えるか、自分で削除できるかを確認
3. 第三者へ提供している機能は無い（AIDEの利用者は本人だけ）ため、事前告知は不要と判断した

## 4. 残る論点

- **Web画面の自動操作の継続利用。** 公式APIの代わりに事業者が提供するものではない。利用規約上の扱いと、
  画面変更で壊れたときに安全に止まるか（既存のDRY_RUN・取り違え検知・冪等記録で止まる設計）は、
  公式APIの終了とは別に本人が判断する
- 会話（MCP）からZaimへ登録する手段は無くなった。必要ならWeb画面から一覧を読む実装を別Issueで起こす
