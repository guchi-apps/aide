import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
    buildZaimMoneyList,
    buildZaimRefreshResult,
    buildZaimSnapshot,
    extractZaimMoneyId,
    findStaleZaimAccounts,
    parseYenAmount,
    parseZaimLastUpdatedAt,
    parseZaimMoneyDate,
    toMatchKey,
} from "./parse.ts"

describe("parseYenAmount", () => {
    it("通貨記号・カンマ・空白を除いて数値へ変換する", () => {
        assert.equal(parseYenAmount("￥1,234,567"), 1234567)
        assert.equal(parseYenAmount("¥ 8,900"), 8900)
        assert.equal(parseYenAmount("\n  ￥12,000 \n"), 12000)
    })

    it("マイナス残高を扱える", () => {
        assert.equal(parseYenAmount("￥-45,600"), -45600)
    })

    it("金額として読めない文字列はnullを返す", () => {
        assert.equal(parseYenAmount(""), null)
        assert.equal(parseYenAmount("残高なし"), null)
        assert.equal(parseYenAmount("￥1,2.3"), null)
    })
})

describe("toMatchKey", () => {
    it("DOM分割で混ざった空白・改行を除去する", () => {
        assert.equal(toMatchKey("楽天カー ド"), toMatchKey("楽天カード"))
        assert.equal(toMatchKey(" eMAXIS Slim\n 全世界株式 "), "eMAXISSlim全世界株式")
    })
})

describe("buildZaimSnapshot", () => {
    it("残高一覧の名称と金額を抽出する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [
                { name: " 三菱UFJ銀行 ", amount: "￥1,234,567" },
                { name: "楽天カー\nド", amount: "￥-45,600" },
            ],
            securities: [],
        })

        assert.deepEqual(snapshot.balances, [
            { name: "三菱UFJ銀行", amount: 1234567, lastUpdatedAt: null },
            { name: "楽天カー ド", amount: -45600, lastUpdatedAt: null },
        ])
        assert.deepEqual(snapshot.holdings, [])
    })

    it("金額を読めない行は除外する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [
                { name: "三菱UFJ銀行", amount: "￥1,000" },
                { name: "合計", amount: "" },
                { name: "", amount: "￥2,000" },
            ],
            securities: [],
        })

        assert.deepEqual(snapshot.balances, [
            { name: "三菱UFJ銀行", amount: 1000, lastUpdatedAt: null },
        ])
    })

    it("残高一覧に同名が複数現れた場合は最初の1件を採用する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [
                { name: "三菱UFJ銀行", amount: "￥1,000" },
                { name: "三菱UFJ銀行", amount: "￥1,000" },
            ],
            securities: [],
        })

        assert.deepEqual(snapshot.balances, [
            { name: "三菱UFJ銀行", amount: 1000, lastUpdatedAt: null },
        ])
    })

    it("同じ銘柄が特定口座・NISA等で複数行に分かれている場合は出現順を付けて保持する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [],
            securities: [
                {
                    url: "https://zaim.net/securities/1",
                    account: "SBI 証券",
                    holdings: [
                        { name: "eMAXIS Slim 全世界株式", amount: "￥1,000,000" },
                        { name: "SBI・V・S&P500", amount: "￥400,000" },
                        { name: "eMAXIS Slim 全世界株式", amount: "￥250,000" },
                    ],
                },
            ],
        })

        assert.deepEqual(
            snapshot.holdings.map((h) => [h.name, h.amount, h.occurrence, h.occurrenceCount]),
            [
                ["eMAXIS Slim 全世界株式", 1000000, 1, 2],
                ["SBI・V・S&P500", 400000, 1, 1],
                ["eMAXIS Slim 全世界株式", 250000, 2, 2],
            ]
        )
    })

    it("同じ銘柄が同じ評価額で口座内に複数行あっても別の行として保持する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [],
            securities: [
                {
                    url: "https://zaim.net/securities/1",
                    account: "SBI 証券",
                    holdings: [
                        { name: "楽天VTI", amount: "￥300,000" },
                        { name: "楽天VTI", amount: "￥300,000" },
                    ],
                },
            ],
        })

        assert.deepEqual(
            snapshot.holdings.map((h) => [h.amount, h.occurrence]),
            [
                [300000, 1],
                [300000, 2],
            ]
        )
    })

    it("銘柄に取得元の証券口座名を付与する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [],
            securities: [
                {
                    url: "https://zaim.net/securities/1",
                    account: "SBI証券",
                    holdings: [{ name: "eMAXIS Slim 全世界株式", amount: "￥3,000,000" }],
                },
                {
                    url: "https://zaim.net/securities/2",
                    account: "楽天証券",
                    holdings: [{ name: "eMAXIS Slim 全世界株式", amount: "￥500,000" }],
                },
            ],
        })

        assert.deepEqual(
            snapshot.holdings.map((h) => [h.account, h.name, h.amount]),
            [
                ["SBI証券", "eMAXIS Slim 全世界株式", 3000000],
                ["楽天証券", "eMAXIS Slim 全世界株式", 500000],
            ]
        )
    })

    it("連携口座の最終更新を残高・保有銘柄へ付与する", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [
                { name: "三菱UFJ銀行", amount: "￥1,000" },
                { name: "SBI証券", amount: "￥5,000" },
                { name: "現金", amount: "￥3,000" },
            ],
            securities: [
                {
                    url: "https://zaim.net/securities/1",
                    account: "SBI証券",
                    holdings: [{ name: "楽天VTI", amount: "￥5,000" }],
                },
            ],
            onlineAccounts: [
                { name: "三菱UFJ銀行", lastUpdatedAt: "最終更新：2026年08月16日 14:27:38" },
                { name: "SBI証券", lastUpdatedAt: "最終更新：2026年08月16日 14:30:00" },
            ],
        })

        assert.deepEqual(
            snapshot.balances.map((balance) => [balance.name, balance.lastUpdatedAt]),
            [
                ["三菱UFJ銀行", "2026-08-16T14:27:38+09:00"],
                ["SBI証券", "2026-08-16T14:30:00+09:00"],
                // 連携していない口座（現金・手入力）は最終更新を持たない。
                ["現金", null],
            ]
        )
        assert.equal(snapshot.holdings[0]?.lastUpdatedAt, "2026-08-16T14:30:00+09:00")
        assert.deepEqual(snapshot.onlineAccounts, [
            { name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T14:27:38+09:00" },
            { name: "SBI証券", lastUpdatedAt: "2026-08-16T14:30:00+09:00" },
        ])
    })

    it("残高一覧と連携口座一覧で粒度が違っても前方一致で突き合わせる", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [{ name: "三菱UFJ銀行 普通", amount: "￥1,000" }],
            securities: [],
            onlineAccounts: [
                { name: "三菱UFJ", lastUpdatedAt: "最終更新：2026年08月16日 14:00:00" },
                // より長く一致するほうを採る。
                { name: "三菱UFJ銀行", lastUpdatedAt: "最終更新：2026年08月16日 15:00:00" },
            ],
        })

        assert.equal(snapshot.balances[0]?.lastUpdatedAt, "2026-08-16T15:00:00+09:00")
    })

    it("連携口座の情報が無い巡回結果でも組み立てられる", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [{ name: "三菱UFJ銀行", amount: "￥1,000" }],
            securities: [],
        })

        assert.deepEqual(snapshot.onlineAccounts, [])
        assert.equal(snapshot.balances[0]?.lastUpdatedAt, null)
    })

    it("口座名が取れない場合はURLを口座名として使う", () => {
        const snapshot = buildZaimSnapshot({
            url: "https://zaim.net/home",
            balances: [],
            securities: [
                {
                    url: "https://zaim.net/securities/1",
                    account: "",
                    holdings: [{ name: "楽天VTI", amount: "￥300,000" }],
                },
            ],
        })

        assert.deepEqual(
            snapshot.holdings.map((h) => [h.account, h.name, h.amount]),
            [["https://zaim.net/securities/1", "楽天VTI", 300000]]
        )
    })
})

describe("parseZaimLastUpdatedAt", () => {
    it("Zaimの表示をJSTオフセット付きのISO8601へ直す", () => {
        assert.equal(
            parseZaimLastUpdatedAt("最終更新：2026年08月16日 14:27:38"),
            "2026-08-16T14:27:38+09:00"
        )
        // 桁が揃っていない表記・秒が無い表記も拾う。
        assert.equal(parseZaimLastUpdatedAt("2026年8月6日 9:05"), "2026-08-06T09:05:00+09:00")
    })

    it("日時として読めない文字列はnullを返す", () => {
        assert.equal(parseZaimLastUpdatedAt(""), null)
        assert.equal(parseZaimLastUpdatedAt("最終更新：未取得"), null)
        // 範囲外の日付を通すと、無い日の残高として扱われてしまう。
        assert.equal(parseZaimLastUpdatedAt("2026年02月31日 00:00:00"), null)
    })
})

describe("findStaleZaimAccounts", () => {
    // UTC 2026-08-16 14:00 は JST 2026-08-16 23:00。
    const now = new Date("2026-08-16T14:00:00.000Z")

    it("最終更新が当日でない口座だけを返す", () => {
        const stale = findStaleZaimAccounts(
            [
                { name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T23:20:00+09:00" },
                { name: "ゆうちょ銀行", lastUpdatedAt: "2024-12-18T10:00:00+09:00" },
                { name: "Coincheck", lastUpdatedAt: "2026-08-15T23:20:00+09:00" },
            ],
            now
        )

        assert.deepEqual(
            stale.map((account) => account.name),
            ["ゆうちょ銀行", "Coincheck"]
        )
    })

    it("最終更新を読めなかった口座も当日と確認できない以上は含める", () => {
        const stale = findStaleZaimAccounts([{ name: "不明な口座", lastUpdatedAt: null }], now)
        assert.deepEqual(
            stale.map((account) => account.name),
            ["不明な口座"]
        )
    })

    it("UTCで前日になる時刻でも日本時間の当日で判定する", () => {
        // UTC 2026-08-16 15:30 は JST 2026-08-17 00:30。日付をまたいだ直後は当日が変わる。
        const afterMidnight = new Date("2026-08-16T15:30:00.000Z")
        const accounts = [{ name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T23:20:00+09:00" }]

        assert.equal(findStaleZaimAccounts(accounts, now).length, 0)
        assert.equal(findStaleZaimAccounts(accounts, afterMidnight).length, 1)
    })
})

describe("buildZaimRefreshResult", () => {
    it("押下結果の日時をISO8601へ直す", () => {
        const result = buildZaimRefreshResult({
            pressed: true,
            waitedMs: 480_000,
            timedOut: false,
            accounts: [
                {
                    name: "三菱UFJ銀行",
                    lastUpdatedAt: "最終更新：2026年08月16日 23:20:11",
                    previousLastUpdatedAt: "最終更新：2026年08月15日 23:20:03",
                    advanced: true,
                },
                {
                    name: "ゆうちょ銀行",
                    lastUpdatedAt: "最終更新：2024年12月18日 10:00:00",
                    previousLastUpdatedAt: "最終更新：2024年12月18日 10:00:00",
                    advanced: false,
                },
            ],
        })

        assert.equal(result.pressed, true)
        assert.equal(result.waitedMs, 480_000)
        assert.deepEqual(
            result.accounts.map((account) => [account.name, account.lastUpdatedAt, account.advanced]),
            [
                ["三菱UFJ銀行", "2026-08-16T23:20:11+09:00", true],
                ["ゆうちょ銀行", "2024-12-18T10:00:00+09:00", false],
            ]
        )
        assert.equal(result.accounts[0]?.previousLastUpdatedAt, "2026-08-15T23:20:03+09:00")
    })

    it("押す前に一覧へ無かった口座は previousLastUpdatedAt が null になる", () => {
        const result = buildZaimRefreshResult({
            pressed: true,
            waitedMs: 0,
            timedOut: false,
            accounts: [
                {
                    name: " 新しい口座 ",
                    lastUpdatedAt: "最終更新：2026年08月16日 23:20:11",
                    previousLastUpdatedAt: null,
                    advanced: false,
                },
            ],
        })

        assert.equal(result.accounts[0]?.name, "新しい口座")
        assert.equal(result.accounts[0]?.previousLastUpdatedAt, null)
    })
})

describe("extractZaimMoneyId", () => {
    it("編集リンクから明細IDを取り出す", () => {
        assert.equal(extractZaimMoneyId("/money/10228209053/edit"), 10228209053)
    })

    it("読めない形式は null を返す", () => {
        assert.equal(extractZaimMoneyId(""), null)
        assert.equal(extractZaimMoneyId("/money/new"), null)
        assert.equal(extractZaimMoneyId("/money/0/edit"), null)
    })
})

describe("parseZaimMoneyDate", () => {
    it("「9月2日（水）」と month（YYYYMM）から YYYY-MM-DD を組み立てる", () => {
        assert.equal(parseZaimMoneyDate("9月2日（水）", "202609"), "2026-09-02")
    })

    it("桁が揃っていない表記も拾う", () => {
        assert.equal(parseZaimMoneyDate("12月31日(木)", "202512"), "2025-12-31")
    })

    it("実在しない日付・読めない形式は null を返す", () => {
        assert.equal(parseZaimMoneyDate("2月31日（日）", "202602"), null)
        assert.equal(parseZaimMoneyDate("", "202609"), null)
        assert.equal(parseZaimMoneyDate("9月2日（水）", "26-09"), null)
    })
})

describe("buildZaimMoneyList", () => {
    it("一覧の生テキストから明細を組み立てる", () => {
        const list = buildZaimMoneyList({
            url: "https://zaim.net/money?month=202609",
            month: "202609",
            entries: [
                {
                    editUrl: "/money/10228209053/edit",
                    date: "9月2日（水）",
                    amount: "￥1,238",
                    category: "食費",
                    genre: "調理食品",
                    account: "スマートレシート",
                    toAccount: "",
                    place: "ライフ 高槻城西店",
                    name: "SS大盛りペペロ…",
                    comment: "",
                },
            ],
        })

        assert.deepEqual(list.entries, [
            {
                id: 10228209053,
                date: "2026-09-02",
                amount: 1238,
                category: "食費",
                genre: "調理食品",
                account: "スマートレシート",
                toAccount: "",
                place: "ライフ 高槻城西店",
                name: "SS大盛りペペロ…",
                comment: "",
            },
        ])
    })

    it("金額・日付を読めない行は落とす", () => {
        const list = buildZaimMoneyList({
            url: "https://zaim.net/money?month=202609",
            month: "202609",
            entries: [
                {
                    editUrl: "/money/1/edit",
                    date: "",
                    amount: "￥100",
                    category: "",
                    genre: "",
                    account: "",
                    toAccount: "",
                    place: "",
                    name: "",
                    comment: "",
                },
                {
                    editUrl: "/money/2/edit",
                    date: "9月2日",
                    amount: "",
                    category: "",
                    genre: "",
                    account: "",
                    toAccount: "",
                    place: "",
                    name: "",
                    comment: "",
                },
            ],
        })

        assert.deepEqual(list.entries, [])
    })

    it("編集リンクを読めない行はIDだけ null になる（他の項目は落とさない）", () => {
        const list = buildZaimMoneyList({
            url: "https://zaim.net/money?month=202609",
            month: "202609",
            entries: [
                {
                    editUrl: "",
                    date: "9月2日",
                    amount: "￥500",
                    category: "食費",
                    genre: "外食",
                    account: "財布",
                    toAccount: "",
                    place: "",
                    name: "",
                    comment: "",
                },
            ],
        })

        assert.equal(list.entries.length, 1)
        assert.equal(list.entries[0]?.id, null)
        assert.equal(list.entries[0]?.amount, 500)
    })
})
