import type {
  ZaimBalance,
  ZaimHolding,
  ZaimOnlineAccount,
  ZaimRawEntry,
  ZaimRawRefreshResult,
  ZaimRawScrapeResult,
  ZaimRefreshResult,
  ZaimSnapshot,
} from "./types.ts";

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 照合用キー。ZaimのDOMは名称の途中で要素が分かれ「楽天カー ド」のように
 * 空白・改行が混ざるため、空白を完全に除去した文字列で突き合わせる。
 */
export function toMatchKey(text: string): string {
  return text.replace(/\s+/g, "");
}

export function parseYenAmount(text: string): number | null {
  const normalized = text
    .replace(/[￥¥]/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** 「最終更新：2026年08月16日 14:27:38」のような表示。秒は無い表記も許容する。 */
const LAST_UPDATED_PATTERN = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/**
 * Zaimの「最終更新」表示をISO8601へ直す。読めなければ null。
 *
 * **JSTのオフセットを必ず付ける。** サブPCもVPSもシステムTZはUTCで、
 * オフセットを落とすと読む側が9時間ずれた時刻として解釈する。
 */
export function parseZaimLastUpdatedAt(text: string): string | null {
  const matched = LAST_UPDATED_PATTERN.exec(text ?? "");
  if (!matched) return null;

  // 秒は表記されない場合があるため既定値を持たせる。他は一致した時点で必ず取れている。
  const [, year = "", month = "", day = "", hour = "", minute = "", second = "00"] = matched;
  const pad = (value: string) => value.padStart(2, "0");
  // 「2026年02月31日」のような値を通さない。**Dateは繰り上げてしまう**（3月3日になる）ため、
  // 組み立てた日付が入力と一致するかで確かめる。
  const at = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00Z`);
  if (
    at.getUTCFullYear() !== Number(year) ||
    at.getUTCMonth() + 1 !== Number(month) ||
    at.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return null;
  }

  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}+09:00`;
}

/** 日本時間の日付（`YYYY-MM-DD`）。en-CA ロケールがこの形式になる。 */
function tokyoDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(at);
}

/**
 * Zaim側の最終更新が当日（JST）でない連携口座を返す。
 *
 * 更新ボタンを押しても、連携設定が壊れている口座（APIキーの権限エラー、
 * 金融機関側のログイン期限切れ）は何日・何ヶ月も前の残高のまま残る。
 * **記録するかどうかを決めるのは参照側で、ここは「当日ではない」という事実だけを返す。**
 * 最終更新を読めなかった口座（null）も、当日と確認できない以上こちらへ含める。
 */
export function findStaleZaimAccounts(
  accounts: readonly ZaimOnlineAccount[],
  now: Date,
): ZaimOnlineAccount[] {
  const today = tokyoDate(now);
  return accounts.filter((account) => account.lastUpdatedAt?.slice(0, 10) !== today);
}

/**
 * 残高・保有銘柄の名称に対応する連携口座の最終更新を引く。
 *
 * 残高一覧と連携口座一覧は同じ口座でも粒度が違うことがある（「三菱UFJ銀行」と
 * 「三菱UFJ銀行 普通」など）。完全一致を優先し、無ければ前方一致のうち
 * もっとも長く一致するものを採る。当たらなければ null（現金・手入力の口座がこれにあたる）。
 */
function matchLastUpdatedAt(accounts: readonly ZaimOnlineAccount[], name: string): string | null {
  const key = toMatchKey(name);
  if (!key) return null;

  let best: { length: number; lastUpdatedAt: string | null } | null = null;
  for (const account of accounts) {
    const accountKey = toMatchKey(account.name);
    if (!accountKey) continue;
    if (accountKey === key) return account.lastUpdatedAt;
    if (!key.startsWith(accountKey) && !accountKey.startsWith(key)) continue;
    if (!best || accountKey.length > best.length) {
      best = { length: accountKey.length, lastUpdatedAt: account.lastUpdatedAt };
    }
  }
  return best?.lastUpdatedAt ?? null;
}

function parseOnlineAccounts(raw: ZaimRawScrapeResult): ZaimOnlineAccount[] {
  const accounts: ZaimOnlineAccount[] = [];
  const seen = new Set<string>();
  for (const entry of raw.onlineAccounts ?? []) {
    const name = collapseWhitespace(entry.name);
    if (!name) continue;
    const key = toMatchKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ name, lastUpdatedAt: parseZaimLastUpdatedAt(entry.lastUpdatedAt) });
  }
  return accounts;
}

/** 更新スクリプトの出力を、日時をISO化した結果へ変換する。 */
export function buildZaimRefreshResult(raw: ZaimRawRefreshResult): ZaimRefreshResult {
  return {
    pressed: Boolean(raw.pressed),
    waitedMs: Number(raw.waitedMs) || 0,
    timedOut: Boolean(raw.timedOut),
    accounts: (raw.accounts ?? []).flatMap((account) => {
      const name = collapseWhitespace(account.name);
      if (!name) return [];
      return [
        {
          name,
          lastUpdatedAt: parseZaimLastUpdatedAt(account.lastUpdatedAt),
          previousLastUpdatedAt: account.previousLastUpdatedAt
            ? parseZaimLastUpdatedAt(account.previousLastUpdatedAt)
            : null,
          advanced: Boolean(account.advanced),
        },
      ];
    }),
  };
}

function parseEntries(entries: ZaimRawEntry[]): { name: string; amount: number }[] {
  const parsed: { name: string; amount: number }[] = [];
  for (const entry of entries) {
    const name = collapseWhitespace(entry.name);
    const amount = parseYenAmount(entry.amount);
    if (!name || amount === null) continue;
    parsed.push({ name, amount });
  }
  return parsed;
}

/** 巡回結果の生テキストを、金額を数値化した取得結果へ変換する。 */
export function buildZaimSnapshot(raw: ZaimRawScrapeResult): ZaimSnapshot {
  const onlineAccounts = parseOnlineAccounts(raw);

  // 同じ銘柄が特定口座・NISA等で複数行に分かれることがある。
  // Zaimは口座区分を表示しないため合算せず、出現順を持たせて行単位で区別できるようにする。
  const holdings: ZaimHolding[] = [];
  const occurrenceCounts = new Map<string, number>();
  const holdingKey = (account: string, name: string) =>
    `${toMatchKey(account)} ${toMatchKey(name)}`;

  for (const page of raw.securities ?? []) {
    const account = collapseWhitespace(page.account || page.url);
    if (!account) continue;

    // 最終更新は証券口座ごとに付く。同じ口座の銘柄は同じ値になる。
    const lastUpdatedAt = matchLastUpdatedAt(onlineAccounts, account);

    for (const holding of parseEntries(page.holdings)) {
      const key = holdingKey(account, holding.name);
      const occurrence = (occurrenceCounts.get(key) ?? 0) + 1;
      occurrenceCounts.set(key, occurrence);
      holdings.push({
        account,
        name: holding.name,
        amount: holding.amount,
        occurrence,
        occurrenceCount: 0,
        lastUpdatedAt,
      });
    }
  }

  for (const holding of holdings) {
    holding.occurrenceCount =
      occurrenceCounts.get(holdingKey(holding.account, holding.name)) ?? 1;
  }

  // 残高一覧は口座ごとに1行のため、同名が複数現れた場合は最初の1件を採用する。
  const balances: ZaimBalance[] = [];
  const seenBalances = new Set<string>();
  for (const balance of parseEntries(raw.balances)) {
    const key = toMatchKey(balance.name);
    if (seenBalances.has(key)) continue;
    seenBalances.add(key);
    balances.push({ ...balance, lastUpdatedAt: matchLastUpdatedAt(onlineAccounts, balance.name) });
  }

  return { balances, holdings, onlineAccounts };
}
