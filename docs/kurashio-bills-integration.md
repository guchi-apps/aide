# kurashio月次請求連携の照合記録（#678・#683）

AIDEの `kurashio_utility_bill_contracts` / `kurashio_get_utility_bill` / `kurashio_import_utility_bill`
（`src/core/connectors/myroom/bills.ts`・`src/mcp/tools/kurashio-bills.ts`）が呼ぶ kurashio 側の内部APIを、
**固定SHAの実コードと本番の応答**で照合した記録。リリース全体レビュー（RC-5・aide#682）が
「連携先の実装・認証・一意制約／rollback・書込トークンの手順が資料に無い」として未確認にした4項目
（複数PRの相互作用・認証・実行ホスト・設定）の根拠をここへまとめる。

**この記録は確認した時点の事実で、合格の宣言ではない。** kurashio の main や共有トークンの登録が
変わったら照合し直す。秘密値・個人の請求データは載せていない。

## 照合した対象

| 対象 | SHA・状態 | 確認時刻（UTC） |
|---|---|---|
| AIDE リリース候補 RC-5（aide#682） | base `95d4b2b835674908eb2482cf33bbc5da01f58d4f` / head `7b1052153ad332f0c3550c287b202fd15b6648f5` | 2026-10-24 11:00 |
| AIDE 実装（aide#681） | head `1735ac53e638596bec134b10ddb776e0d546e29e`（developへマージ済み） | 同上 |
| kurashio 実装 guchi-apps/kurashio#815（kurashio#814 の実装） | head `cfd9bea5d4a297091756a094e55e8edebabd71d6` / merge `9b89df02a5d06aedc497d32db31980c9232dc74b`（2026-10-23T23:28:11Z） | 2026-10-24 11:05 |
| kurashio 後続修正 guchi-apps/kurashio#818（kurashio#817） | merge `d939f2e3a3c63f07c906263fdc4ea111b093417a`（2026-10-23T23:47:19Z） | 同上 |
| kurashio リリース guchi-apps/kurashio#819（v4.45.0） | main `c5b5ee41f2c89231faac17ba716fa139fba5713c`（2026-10-24T06:24:10Z） | 同上 |
| kurashio 本番デプロイ | `Deploy to Production` が `c5b5ee4` で success（actions run 40070065305） | 同上 |
| kurashio 本番の稼働版 | `GET https://myroom.gucchii.com/api/app-version` → `{"version":"4.45.0","sha":"c5b5ee41f2c8…"}` | 2026-10-24T11:05:33Z |

kurashio#815 だけを本番とみなさず、`9b89df0` が `origin/main`（`c5b5ee4`）の祖先であることと、
その後 main に入ったのが #817 の2コミット（`869043f`・`e7825be`）とリリースだけであることを `git log` で確かめた。
以下のコード参照はすべて `c5b5ee4`（本番稼働版）のもの。

## 1. API契約（複数PRの相互作用）

| AIDE（`src/core/connectors/myroom/bills.ts`） | kurashio（`c5b5ee4`） | 一致 |
|---|---|---|
| `fetchBillContracts`: `GET /api/internal/bills/contracts?kind=` → `contracts[].contract_key / plan_name / latest_billing_month` | `backend/main.py` `get_internal_bill_contracts` → `bills.list_contracts`（同じ3項目。お客さま番号は持たず返さない） | ○ |
| `fetchBill`: `GET /api/internal/bills/record?kind&contract_key&(billing_month｜source_message_id)` → `{record, source}`、未登録は404 `detail:"not_found"` | `get_internal_bill_record`: 月と出典のどちらか一方だけ（両方・無しは422）。無ければ `HTTPException(404, "not_found")` | ○ |
| `importBill`: `POST /api/internal/bills/import`、送る11項目（`ImportPayload`） | `InternalBillImport`（`extra="forbid"`）の11項目と同名・同型。余計な項目は422 | ○ |
| 応答 `status` = `created` / `duplicate` / `conflict`、`fields`、`record`、`source` | `bills._result`（同じキー）。`DB_MOCK` は `mock_ok` → AIDEは保存していない `failed` として扱う | ○ |
| `record.revision` | `serialize_record` が `updated_at` のISO文字列（MySQLは秒精度） | ○ |

**旧版との404互換。** ルートが無い FastAPI は `{"detail":"Not Found"}` を返し、未登録の `"not_found"` と
区別できる。AIDEは前者を `unsupported`、後者を `found:false` にする（`fetchBill`）。現在の本番には
ルートが有る（下記「本番の応答」で401が返る＝ルートが存在する）。

同じ候補の aide#680（`AIDE_ZAIM_WRITE_SECRET` の配布行撤去）は、触るファイルが `deploy.yml`・
`secrets-manifest.tsv`・`src/deploy-env-wiring.test.ts` だけで、請求連携のコードと重ならない。
前提の「VPSの本体が共有トークンから取得している」ことは、issue-deck#4792 で利用元に `aide` が出ていることを
本人が画面で確認済み（2026-10-23T23:04:49Z のコメント）。

## 2. 認証（読み取り・書込の分離）

`backend/internal_auth.py`（`c5b5ee4`）:

- 照会2本は `require_internal_token`（読み取り用 `MYROOM_INTERNAL_API_KEY`）
- 取込は `require_internal_bills_write_token`。**共有トークン `MYROOM_INTERNAL_BILLS_WRITE_API_KEY` だけ**を読み、
  環境変数フォールバックは無い。未取得なら503、値違いは401。比較は SHA-256 ダイジェストの `hmac.compare_digest`
- `tests/test_bill_import.py::test_tokens` が、読み取り用・操作用・無しのどれでも取込が401、書込トークンで照会が401になることを確かめる

AIDE側は照会と登録で別のOAuth scopeを要求し（`src/mcp/tools/kurashio-bills.ts` の `requiredScopes`）、
書込トークンも共有トークンAPIからだけ取る（`readBillsWriteConfig`）。

## 3. 一意制約・rollback（状態の整合）

- `utility_bill_imports` は `UNIQUE(source_message_id, kind, contract_key)`（`backend/database.py`
  `uq_utility_bill_imports_source`。本番DDLは `migrate_db.py` が作り、kurashio の gate が `deploy/gate-install.sh` で毎デプロイ実行）
- `bills.import_bill` は「出典が別の月 → conflict」「行が無い → 請求行と出典行を1トランザクションで insert → created」
  「行がある → 主要項目一致で duplicate・違えば conflict（何も書かない）」。同時書込の `IntegrityError` は
  `db.rollback()` して読み直し（最大3回）、既存行を上書きしない（`test_primary_key_race_does_not_overwrite`）
- それ以外の例外は API 側で `db.rollback()` して500（`import_internal_bill`）。AIDEは書込の5xxを `unknown` にし、
  再送させずに `sourceMessageId` での照会方法を返す
- #817 以降、サブPCの日次収集（`POST /api/bills`・上書き）は、出典の記録された行を飛ばす（`bills.upsert_records`。
  `test_legacy_upsert_does_not_overwrite_imported_row`）。AIDEが `created` で作った行は収集に上書きされない

kurashio CI（`backend` ジョブ＝`pytest tests/ -q`）は、#815 head `cfd9bea`・#818 head `e7825be`・
リリース head `508123b` のいずれでも success。

## 4. 実行ホスト・設定（書込トークン）

**本番の応答（認証を付けず、本文も空。書き込みは起きない）**、2026-10-24T11:05:33Z:

| 要求 | 応答 | 読み取れること |
|---|---|---|
| `GET /api/internal/bills/contracts?kind=electricity` | 401 `Invalid internal API token` | ルートが有り、読み取り用トークンは設定済み |
| `GET /api/internal/bills/record?…` | 401 | 同上 |
| `POST /api/internal/bills/import`（`{}`） | 503 `MYROOM_INTERNAL_BILLS_WRITE_API_KEY is not configured` | kurashio 本番が書込トークンを取得できていない（未登録、または取得失敗） |

- **書込トークンの登録（aide#679）は公開後の有効化作業で、公開前の必須条件ではない。** 未取得の間、AIDEは
  `readBillsWriteConfig` が null を返して `not_configured` で止まり、kurashio へ送信しない
  （`kurashio-bills.test.ts`「未設定・認証拒否・未対応を区別する」）。仮に AIDE だけが取れても kurashio は503で、
  AIDEは `not_configured` に分類する。照会2本は読み取り用トークンで公開直後から動く
- 登録・ローテーションの手順は kurashio `CLAUDE.md`（`c5b5ee4`）の「月次請求の取込」節が正: issue-deck の共有トークンに同名で登録 →
  kurashio は再起動不要（成功値10分・失敗30秒のキャッシュ）→ AIDE から1件通して `created`、再送で `duplicate` を確かめる
- AIDE側に `deploy.yml`・`secrets-manifest.tsv` の追加は無い（環境変数フォールバックを持たない。`src/deploy-env-wiring.test.ts`）。
  poller・サブPCの常駐は請求連携に関与しない
