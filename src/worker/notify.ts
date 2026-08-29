import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { isZaimAutoReloginFailed, isZaimSessionExpired } from "../core/connectors/zaim/errors.ts";
import { readZaimCredentials } from "../core/connectors/zaim/retry.ts";
import type { ZaimOnlineAccount } from "../core/connectors/zaim/types.ts";
import { DATA_DIR } from "../core/paths.ts";

/**
 * worker ジョブの失敗を Signaly（Webhook受信＋Web Push の通知ハブ）へ送る。
 *
 * ジョブは失敗すると終了コード1を返すが、systemd timer はそれを記録するだけで誰にも伝えない。
 * 実際に `aide-zaim-sync.service` の失敗に丸一日気づけなかったため、通知経路を足している（#26）。
 *
 * 方針は3つ。
 *
 * 1. **通知するのは失敗と復旧だけ。** 成功を毎回送ると `zaim-keep-alive`（毎時）だけで
 *    1日24件になり、肝心の失敗が埋もれる。
 * 2. **同じ理由の連続失敗は6時間に1回まで。** セッション失効は手動ログインをやり直すまで
 *    直らないため、抑制しないと毎時同じ通知が届く。抑制で黙っていた障害が直ったときだけ
 *    「復旧」を1回送り、静かになった理由が復旧なのか抑制なのかを分かるようにする。
 * 3. **通知の失敗でジョブを二重に失敗させない。** ここでの例外はすべて握りつぶし、
 *    ログに一行残すだけにする。Webhook URL は `channel_id` を含む認証情報なのでログに出さない。
 * 4. **通知に書く対応は、受け取った時点の実態と一致させる。** セッション失効はかつて手動
 *    ログインでしか直らなかったが、いまは自動再ログイン（#63）があり、多くは30分ごとの
 *    `zaim-keep-alive` が勝手に直す。それでも「手動でログインし直すまで失敗し続けます」と
 *    送っていたため、受け取った側が手動対応の要否を判断できなかった（#191）。
 *    いまは失敗の中身から3通りに書き分け、他のジョブが直したときは横断で回復を伝える。
 */

/** 同じ理由で失敗し続けている間、次の通知までに空ける時間。 */
const SUPPRESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 通知の送信タイムアウト。ジョブの終了を長く引き止めない。 */
const SEND_TIMEOUT_MS = 10_000;

/** 通知に載せる失敗理由の上限。keep-alive の失敗は stderr 全文が載るため切り詰める。 */
const REASON_MAX_LENGTH = 500;

/** 失敗理由が変わったかの判定に使う署名。セッション失効はURL等が混ざっても同一とみなす。 */
const SESSION_EXPIRED_SIGNATURE = "ZAIM_SESSION_EXPIRED";

/**
 * セッション失効の行き先。**通知の文面と署名はこれで決まる。**
 *
 * - `auto-pending`: 資格情報が設定されており、自動再ログインでまだ直る見込みがある。
 *   `zaim-refresh` / `zaim-sync` の失効はここに落ちるのが普通で、30分ごとの
 *   `zaim-keep-alive` が直す（実際 2026-08-29 の失敗は4秒後の keep-alive で復旧している）。
 * - `auto-failed`: 自動再ログインを試したうえで直らなかった（`ZAIM_AUTO_RELOGIN_FAILED`）。
 * - `manual-only`: 資格情報が無く、自動再ログインを試す経路自体が無い。
 *
 * **`auto-pending` と他は署名を分ける。** 同じ署名にすると「自動で直る見込み」を送った直後に
 * 自動再ログインが失敗しても、6時間の抑制で「手動が要る」が届かなくなる。
 */
export type SessionExpiryKind = "auto-pending" | "auto-failed" | "manual-only";

// Signalyの色指定は10進整数（Discord形式）。docs/webhook.md 参照。
const COLOR_FAILURE = 15548997; // #ed4245
const COLOR_RECOVERY = 5763719; // #57f287
const COLOR_WARNING = 16705372; // #fee75c

/**
 * ジョブ自体は成功したが一部だけ失敗した状態の記録キー（`state` はジョブ名で引くため接尾辞で分ける）。
 * `notifyJobRecovered` が消すのは `state[job]` だけなので、両者は干渉しない。
 */
const PARTIAL_STATE_SUFFIX = ":stale-accounts";

/** 通知に並べる口座名の上限。1フィールドの文字数制限に収める。 */
const LISTED_ACCOUNTS_MAX = 20;

/** ジョブごとの未解決の失敗。復旧通知を出したら消す。 */
export interface FailureRecord {
  /** 失敗理由の署名。変わったら抑制せずに通知する。 */
  signature: string;
  /** 連続失敗が始まった時刻（ISO8601）。 */
  firstFailedAt: string;
  /** 最後に通知できた時刻（ISO8601）。まだ一度も送れていなければ null。 */
  notifiedAt: string | null;
  /** 連続失敗回数。 */
  count: number;
}

export type NotifyState = Record<string, FailureRecord>;

interface SignalyField {
  name: string;
  value: string;
  inline?: boolean;
}

interface SignalyPayload {
  embeds: [{ title: string; description: string; color: number; fields: SignalyField[] }];
}

export interface FailureSummary {
  /** 通知に載せる失敗理由（1行・切り詰め済み）。 */
  reason: string;
  /** セッション失効ならその行き先。失効でなければ null。 */
  sessionExpiry: SessionExpiryKind | null;
  /** 抑制判定に使う署名。 */
  signature: string;
}

/**
 * この失効が自動再ログインで直る見込みがあるか。
 *
 * 資格情報の**値は読まない**（設定の有無だけを見る）。値は自動再ログインの子プロセスへ
 * 環境変数として渡るもので、通知にもログにも出さない。
 */
function classifySessionExpiry(
  raw: string,
  env: Record<string, string | undefined>,
): SessionExpiryKind {
  if (isZaimAutoReloginFailed(raw)) return "auto-failed";
  return readZaimCredentials(env) ? "auto-pending" : "manual-only";
}

/**
 * 例外を通知向けの理由へ整形する。
 *
 * `zaim-keep-alive` は `execFile` の失敗としてスクリプトのstderr全文がメッセージに載る。
 * そのまま送るとスタックトレースで通知が埋まるため、1行目だけを使う。
 */
export function summarizeFailure(
  cause: unknown,
  env: Record<string, string | undefined> = process.env,
): FailureSummary {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const sessionExpiry = isZaimSessionExpired(raw) ? classifySessionExpiry(raw, env) : null;

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // execFile の失敗は1行目が「Command failed: node ...」で、本当の理由は stderr 側の
  // Error 行にある。1行目だけを見ると「何かが落ちた」以上のことが分からない。
  const line = lines.find((candidate) => candidate.startsWith("Error:")) ?? lines[0] ?? "";
  const reason = line
    ? line.length > REASON_MAX_LENGTH
      ? `${line.slice(0, REASON_MAX_LENGTH)}…`
      : line
    : "（失敗理由を取得できませんでした）";

  return {
    reason,
    sessionExpiry,
    // 失効は文面（URLや行番号が混ざる）ではなく行き先で束ねる。行き先が変われば署名も変わり、
    // 「自動で直る見込み」から「手動が要る」へ悪化したときは抑制されずに届く。
    signature: sessionExpiry ? `${SESSION_EXPIRED_SIGNATURE}:${sessionExpiry}` : reason,
  };
}

/** 失効の記録か（ジョブ横断の回復通知が拾う対象）。 */
function isSessionExpirySignature(signature: string): boolean {
  return signature.startsWith(`${SESSION_EXPIRED_SIGNATURE}:`);
}

/**
 * 今回の失敗を通知するかどうかと、保存する記録を決める。
 *
 * 返す記録の `notifiedAt` は前回のまま。実際に送信できたときだけ呼び出し側が更新する
 * （送れなかったのに抑制がかかると、次の実行まで誰も気づけない時間が延びるため）。
 */
export function decideNotification(
  previous: FailureRecord | undefined,
  signature: string,
  now: Date,
): { shouldNotify: boolean; record: FailureRecord } {
  const continued = previous?.signature === signature;
  const record: FailureRecord = {
    signature,
    firstFailedAt: continued ? previous.firstFailedAt : now.toISOString(),
    notifiedAt: continued ? previous.notifiedAt : null,
    count: continued ? previous.count + 1 : 1,
  };

  const elapsed = record.notifiedAt ? now.getTime() - new Date(record.notifiedAt).getTime() : null;
  const shouldNotify = elapsed === null || elapsed >= SUPPRESSION_WINDOW_MS;
  return { shouldNotify, record };
}

/** 日時はJSTで出す。通知を読むのは日本にいる人だけで、UTC表記だと毎回換算が要る。 */
export function formatJst(at: Date): string {
  // sv-SE ロケールは "2026-08-14 20:07:36" 形式になる。
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(at);
  return `${formatted} JST`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間${minutes % 60}分`;
  return `${Math.floor(hours / 24)}日${hours % 24}時間`;
}

/** 手動ログインのやり直し方。文面を1か所に持つ。 */
const MANUAL_LOGIN_ACTION =
  "サブPCの `~/apps/aide` で `node src/core/connectors/zaim/scripts/login.mjs` を実行し、手動でログインし直す";

/** 失効の行き先ごとの、タイトル・本文・対応欄。 */
const SESSION_EXPIRY_TEXT: Record<
  SessionExpiryKind,
  { titleSuffix: string; description: string; action: string }
> = {
  "auto-pending": {
    titleSuffix: "Zaimのセッションが失効（自動再ログイン待ち）",
    description:
      "Zaimのログインセッションが失効しています。**30分ごとの `zaim-keep-alive` が自動で" +
      "再ログインを試みます。**直れば「Zaimのセッションが回復しました」が届くので、" +
      "それまで手動の対応は要りません。",
    action:
      "まず待つ（次の `zaim-keep-alive` まで最大32分）。" +
      `回復の通知が届かない、または再ログインの失敗が通知されたら、${MANUAL_LOGIN_ACTION}`,
  },
  "auto-failed": {
    titleSuffix: "Zaimの再ログインが必要",
    description:
      "Zaimのログインセッションが失効しており、**自動再ログインも失敗しました。**" +
      "手動でログインし直すまで、次回以降も失敗し続けます。",
    action: MANUAL_LOGIN_ACTION,
  },
  "manual-only": {
    titleSuffix: "Zaimの再ログインが必要",
    description:
      "Zaimのログインセッションが失効しています。**このホストには自動再ログインの資格情報" +
      "（`ZAIM_EMAIL` / `ZAIM_PASSWORD`）が設定されていません。**" +
      "手動でログインし直すまで、次回以降も失敗し続けます。",
    action: MANUAL_LOGIN_ACTION,
  },
};

export function buildFailurePayload(input: {
  job: string;
  summary: FailureSummary;
  occurredAt: Date;
  record: FailureRecord;
}): SignalyPayload {
  const { job, summary, occurredAt, record } = input;

  const fields: SignalyField[] = [
    { name: "ジョブ", value: `\`${job}\``, inline: true },
    { name: "発生時刻", value: formatJst(occurredAt), inline: true },
    { name: "実行ホスト", value: hostname(), inline: true },
  ];
  if (record.count > 1) {
    fields.push({
      name: "連続失敗",
      value: `${record.count}回目（${formatJst(new Date(record.firstFailedAt))}から）`,
      inline: false,
    });
  }
  const expiry = summary.sessionExpiry ? SESSION_EXPIRY_TEXT[summary.sessionExpiry] : null;
  if (expiry) {
    // 何をすれば直るかまで書く。通知を見た時点で対応が決まるようにするため。
    fields.push({ name: "対応", value: expiry.action, inline: false });
    // keep-alive 経由だと理由が英語のスタックのままになる。本文は日本語の説明に差し替え、
    // 元のメッセージはこちらへ回す。
    fields.push({ name: "エラー", value: summary.reason, inline: false });
  }

  return {
    embeds: [
      {
        title: expiry ? `🔑 [AIDE] ${job}: ${expiry.titleSuffix}` : `❌ [AIDE] ${job} 失敗`,
        description: expiry ? expiry.description : summary.reason,
        // 自動で直る見込みがあるものは赤で出さない。手動対応が要るものと同じ色にすると、
        // どちらも「いま動くべき失敗」に見えてしまう。
        color: summary.sessionExpiry === "auto-pending" ? COLOR_WARNING : COLOR_FAILURE,
        fields,
      },
    ],
  };
}

export function buildRecoveryPayload(input: {
  job: string;
  record: FailureRecord;
  recoveredAt: Date;
}): SignalyPayload {
  const { job, record, recoveredAt } = input;
  const failedSince = new Date(record.firstFailedAt);

  return {
    embeds: [
      {
        title: `✅ [AIDE] ${job} 復旧`,
        description: "失敗が続いていたジョブが成功しました。手動の対応は要りません。",
        color: COLOR_RECOVERY,
        fields: [
          { name: "ジョブ", value: `\`${job}\``, inline: true },
          { name: "復旧時刻", value: formatJst(recoveredAt), inline: true },
          { name: "実行ホスト", value: hostname(), inline: true },
          {
            name: "失敗していた期間",
            value: `${formatJst(failedSince)} から ${formatDuration(
              recoveredAt.getTime() - failedSince.getTime(),
            )}（${record.count}回）`,
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * 未解決の失敗の記録。
 *
 * `data/` 配下だがZaimのログイン状態（`data/zaim/`）とは別のファイルで、中身はジョブ名・
 * 失敗理由の署名・時刻・回数だけ。取得したデータや認証情報は入れない。
 * 置き場をテストから差し替えられるようにしてあるのはキャッシュ（`AIDE_CACHE_DIR`）と同じ理由。
 */
function stateFilePath(): string {
  const dir = process.env["AIDE_WORKER_STATE_DIR"];
  return resolve(dir ? resolve(dir) : resolve(DATA_DIR, "worker"), "notify-state.json");
}

export async function readState(): Promise<NotifyState> {
  try {
    return JSON.parse(await readFile(stateFilePath(), "utf8")) as NotifyState;
  } catch {
    // 未作成でも壊れていても、通知が1回余分に出るだけで害はない。空から始める。
    return {};
  }
}

async function writeState(state: NotifyState): Promise<void> {
  const path = stateFilePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

function webhookUrl(): string | undefined {
  const url = process.env["AIDE_SIGNALY_WEBHOOK_URL"]?.trim();
  return url ? url : undefined;
}

/** 送信できたかを返す。URLは `channel_id` を含む認証情報なのでログに出さない。 */
async function send(url: string, payload: SignalyPayload): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[notify] Signalyへの通知に失敗しました: ${response.status}`);
      return false;
    }
    return true;
  } catch (cause) {
    console.error(
      `[notify] Signalyへの通知に失敗しました: ${cause instanceof Error ? cause.message : cause}`,
    );
    return false;
  }
}

/**
 * ジョブの失敗を通知する。**呼び出し側は失敗させない**（例外を投げない）。
 * `AIDE_SIGNALY_WEBHOOK_URL` が未設定なら何もしない（開発機で余計な通知を出さないため）。
 */
export async function notifyJobFailure(job: string, cause: unknown): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  try {
    const now = new Date();
    const summary = summarizeFailure(cause);
    const state = await readState();
    const { shouldNotify, record } = decideNotification(state[job], summary.signature, now);

    if (shouldNotify) {
      const sent = await send(url, buildFailurePayload({ job, summary, occurredAt: now, record }));
      // 送れなかったときは notifiedAt を進めない。次の実行で送り直す。
      if (sent) record.notifiedAt = now.toISOString();
    }

    state[job] = record;
    await writeState(state);
  } catch (cause) {
    console.error(
      `[notify] 失敗通知の処理でエラーが出ました: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

/**
 * 更新できなかった口座の署名。**顔ぶれが同じなら同じ署名**になるよう名前順に並べる。
 * 同じ口座が落ち続けている間は静かにし、別の口座が落ちたときは抑制せずに知らせるため。
 */
export function staleAccountsSignature(accounts: readonly ZaimOnlineAccount[]): string {
  return accounts
    .map((account) => account.name)
    .sort()
    .join("／");
}

/** 最終更新の表示。読めていない口座は「不明」にする。 */
function formatLastUpdated(account: ZaimOnlineAccount): string {
  if (!account.lastUpdatedAt) return `${account.name}: 不明`;
  return `${account.name}: ${formatJst(new Date(account.lastUpdatedAt))}`;
}

export function buildStaleAccountsPayload(input: {
  job: string;
  accounts: readonly ZaimOnlineAccount[];
  occurredAt: Date;
  record: FailureRecord;
}): SignalyPayload {
  const { job, accounts, occurredAt, record } = input;

  const listed = accounts.slice(0, LISTED_ACCOUNTS_MAX).map(formatLastUpdated);
  if (accounts.length > listed.length) {
    listed.push(`ほか${accounts.length - listed.length}件`);
  }

  const fields: SignalyField[] = [
    { name: "ジョブ", value: `\`${job}\``, inline: true },
    { name: "確認時刻", value: formatJst(occurredAt), inline: true },
    { name: "実行ホスト", value: hostname(), inline: true },
    { name: "更新できなかった口座", value: listed.join("\n"), inline: false },
    {
      // 何をすれば直るかまで書く。通知を見た時点で対応が決まるようにするため。
      name: "対応",
      value:
        "Zaim の「口座の連携」からこの口座の設定を直す" +
        "（APIキーの権限、金融機関側のログイン期限切れなど）。AIDE側では直せない。",
      inline: false,
    },
  ];
  if (record.count > 1) {
    fields.push({
      name: "連続",
      value: `${record.count}回目（${formatJst(new Date(record.firstFailedAt))}から）`,
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `⚠️ [AIDE] ${job}: 更新できなかった口座があります`,
        description:
          "Zaimの連携口座を更新したが、次の口座は最終更新が当日になっていない。" +
          "**この口座の残高は当日の値ではない。**",
        color: COLOR_WARNING,
        fields,
      },
    ],
  };
}

export function buildStaleAccountsRecoveryPayload(input: {
  job: string;
  record: FailureRecord;
  recoveredAt: Date;
}): SignalyPayload {
  const { job, record, recoveredAt } = input;

  return {
    embeds: [
      {
        title: `✅ [AIDE] ${job}: 全口座が更新できました`,
        description: "更新できていなかった口座が最新化されました。手動の対応は要りません。",
        color: COLOR_RECOVERY,
        fields: [
          { name: "ジョブ", value: `\`${job}\``, inline: true },
          { name: "確認時刻", value: formatJst(recoveredAt), inline: true },
          { name: "実行ホスト", value: hostname(), inline: true },
          {
            name: "更新できていなかった口座",
            value: `${record.signature}（${formatJst(new Date(record.firstFailedAt))}から${record.count}回）`,
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * 一部の口座だけ更新できなかったことを通知する。**ジョブは成功扱いのまま。**
 *
 * ジョブ全体の失敗（`notifyJobFailure`）では拾えない。更新ボタンは押せているのに
 * 特定の口座だけ古い残高が残る状態は、Zaim側の連携設定を直すまで続くため、
 * 抑制の仕組みはそのまま流用する（同じ顔ぶれなら6時間に1回、直ったら1回だけ復旧を送る）。
 *
 * **呼ぶかどうかは呼び出し側が決める。** `zaim-sync` はその日の最後の巡回でしか呼ばない
 * （#165 / #178。理由は `jobs/zaim-sync.ts` の `decideStaleAccountCheck`）。
 *
 * **判定していないときは呼んではいけない。** 空の配列は「更新漏れ0件」の意味で、記録があれば
 * 復旧として送って消してしまう。連携口座を1件も読めなかった場合を空配列として渡すと、
 * 直っていないのに「復旧しました」が届く（#178）。
 *
 * 呼び出し側は失敗させない（例外を投げない）。
 */
export async function notifyStaleAccounts(
  job: string,
  accounts: readonly ZaimOnlineAccount[],
): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  const key = `${job}${PARTIAL_STATE_SUFFIX}`;
  try {
    const now = new Date();
    const state = await readState();
    const previous = state[key];

    if (accounts.length === 0) {
      // 直ったときだけ1回送る。日常の「全部更新できた」では何も送らない。
      if (!previous) return;
      if (!(await send(url, buildStaleAccountsRecoveryPayload({ job, record: previous, recoveredAt: now }))))
        return;
      delete state[key];
      await writeState(state);
      return;
    }

    const { shouldNotify, record } = decideNotification(previous, staleAccountsSignature(accounts), now);
    if (shouldNotify) {
      const sent = await send(url, buildStaleAccountsPayload({ job, accounts, occurredAt: now, record }));
      // 送れなかったときは notifiedAt を進めない。次の実行で送り直す。
      if (sent) record.notifiedAt = now.toISOString();
    }

    state[key] = record;
    await writeState(state);
  } catch (cause) {
    console.error(
      `[notify] 一部失敗の通知でエラーが出ました: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

export function buildZaimSessionRecoveryPayload(input: {
  succeededJob: string;
  recovered: readonly { job: string; record: FailureRecord }[];
  recoveredAt: Date;
}): SignalyPayload {
  const { succeededJob, recovered, recoveredAt } = input;

  return {
    embeds: [
      {
        title: "✅ [AIDE] Zaimのセッションが回復しました",
        description:
          `\`${succeededJob}\` が成功したため、失効していたZaimのログインセッションは回復しています。` +
          "**手動でのログインし直しは要りません。**",
        color: COLOR_RECOVERY,
        fields: [
          { name: "回復を確認したジョブ", value: `\`${succeededJob}\``, inline: true },
          { name: "確認時刻", value: formatJst(recoveredAt), inline: true },
          { name: "実行ホスト", value: hostname(), inline: true },
          {
            name: "失効で失敗していたジョブ",
            value: recovered
              .map(
                ({ job, record }) =>
                  `\`${job}\`: ${formatJst(new Date(record.firstFailedAt))} から${record.count}回`,
              )
              .join("\n"),
            inline: false,
          },
          {
            // 「回復した」だけだと、失敗していたジョブの結果まで取り戻せたように読める。
            name: "補足",
            value: "上のジョブ自体は次回の定期実行でやり直される（その回の結果は取得できていない）。",
            inline: false,
          },
        ],
      },
    ],
  };
}

/**
 * **ジョブをまたいでZaimのセッション回復を伝える。**
 *
 * 復旧通知（`notifyJobRecovered`）はジョブ単位なので、`zaim-refresh`（12時間ごと）が失効で
 * 失敗し、その直後に `zaim-keep-alive`（30分ごと）が自動再ログインで直しても、`zaim-refresh`
 * の復旧は12時間後まで出ない。その間、通知を見た側には失敗だけが残る（#191）。
 *
 * Zaimのジョブが成功した時点でセッションは有効なので、**他のジョブに残っている失効の失敗は
 * 原因が解消済み**とみなして1回だけ回復を送り、記録を消す。消すのは失効の記録だけで、
 * 別の理由で失敗しているジョブの記録は残す。
 *
 * 呼び出し側は失敗させない（例外を投げない）。
 */
export async function notifyZaimSessionRecovered(succeededJob: string): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  try {
    const state = await readState();
    const recovered = Object.entries(state)
      .filter(([job]) => job !== succeededJob && !job.endsWith(PARTIAL_STATE_SUFFIX))
      .filter(([, record]) => isSessionExpirySignature(record.signature))
      .map(([job, record]) => ({ job, record }));
    if (recovered.length === 0) return;

    // 送れなかったら記録を残す。次にZaimのジョブが成功したときに送り直せる。
    const sent = await send(
      url,
      buildZaimSessionRecoveryPayload({ succeededJob, recovered, recoveredAt: new Date() }),
    );
    if (!sent) return;

    for (const { job } of recovered) delete state[job];
    await writeState(state);
  } catch (cause) {
    console.error(
      `[notify] セッション回復の通知でエラーが出ました: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}

/**
 * 未解決の失敗があった場合だけ復旧を通知する。日常の成功では何も送らない。
 * 失敗時と同じく、ここでの問題でジョブを失敗させない。
 */
export async function notifyJobRecovered(job: string): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  try {
    const state = await readState();
    const record = state[job];
    if (!record) return;

    // 送れなかったら記録を残す。次に成功したときに送り直せる。
    if (!(await send(url, buildRecoveryPayload({ job, record, recoveredAt: new Date() })))) return;

    delete state[job];
    await writeState(state);
  } catch (cause) {
    console.error(
      `[notify] 復旧通知の処理でエラーが出ました: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
