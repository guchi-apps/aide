import { createHash } from "node:crypto";
import { tokyoDate } from "../../core/connectors/subscriptions/index.ts";
import { findPaymentSeries, nextRequestId } from "../../core/connectors/zaim/idempotency.ts";
import { loadZaimOAuthCredentials } from "../../core/connectors/zaim/oauth.ts";
import {
  createZaimPayment,
  normalizePaymentInput,
  type ZaimPaymentInput,
} from "../../core/connectors/zaim/write.ts";
import { readZaimMaster, type ZaimMasterView } from "../../core/views/zaim-master.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * Zaimへの支出登録（aide#135）。**AIDEが持つ2つ目の書き込みツール。**
 *
 * 外（VPS外）のClaude CodeからZaimへ支出を登録したい、が起点（guchi-apps/question#24）。
 * Zaimへ書ける口は `POST /api/zaim/payment` だけで、これは同じVPS上の個人アプリが
 * `127.0.0.1` へ直接叩く前提。**外部からは届かず、guchi-apps/vps#101 で公開URLからは
 * `/api/zaim` を403にするため今後も塞がる。** HTTP APIは内向きのまま据え置き、
 * OAuth Bearerで守られている `/mcp` の側に口を開ける。
 *
 * README「書き込みをどこまで持つか」の3条件はすべて満たす。
 *
 * 1. **他のどこからも塞がっている経路。** 外部のClaude CodeからZaimへ書く手段は現状ゼロ。
 *    aide#37 は「Zaimの公開APIが叩ける」ため条件1の例外だったが、**呼び出し元が外部の
 *    Claude Codeなら経路そのものが無い**。あの節を根拠にせず、このIssueで改めて判断した
 * 2. **読み取りとは別の資格情報。** 既存の OAuth 1.0a（`AIDE_ZAIM_*`）。巡回の storage state とは別
 * 3. **作成だけ。** `write.ts` は編集・削除を持たない
 *
 * **読み取り（`aide_zaim_master`）と書き込み（`aide_zaim_payment`）は1本に畳まない。**
 * `aide_dev_status` のように畳む前例はあるが、あちらは読み取りだけ。ここで畳むと
 * Claude Code側でツールを「常に許可」にしたときに書き込みまで素通しになる。承認の粒度が
 * 変わるので分けている。
 */

/**
 * MCP経由の上限額。**`write.ts` の `MAX_AMOUNT`（1億）とは別に、こちらだけ厳しくする。**
 *
 * あちらは「アプリが桁を1つ間違えた」を機械的に止めるための歯止めで、入力はアプリのレコード。
 * こちらの入力は**会話**で、聞き間違い・言い間違いがそのまま金額になる。しかもこの経路は
 * 取り消せない。個人の支出でこれを超えるものは、Zaimの画面で入れたほうが確実。
 */
export const MCP_MAX_AMOUNT = 300_000;

/**
 * `normalizePaymentInput()` を通すための仮の値。
 *
 * 本物の `requestId` は**正規化した後の内容**から作る（前後の空白を落とす前に作ると、
 * 同じ支出が別のキーになって二重登録の判定をすり抜ける）。検査だけ先に通したいので、
 * ここでは形式を満たすだけの値を渡し、あとで差し替える。
 */
const PENDING_REQUEST_ID = "mcp:pending";

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・重複・入力の誤りは「エラー」ではなく状態。isError にすると Claude が
    // 同じ内容で再試行し、往復が増えるだけになる（`aide_create_issue` と同じ考え方）。
    isError: false,
  };
}

/**
 * 支出の内容から冪等キーを作る。
 *
 * 既存の呼び出し元（car-care・asset-manager）は自分のレコードIDからキーを決められるが、
 * **Claudeには対応するレコードが無い。** 毎回新しい値を作らせると、同じ支出を2回言うだけで
 * 2件登録され、この経路からは取り消せない。だから内容そのものから決める。
 *
 * **キーを平文にはしない。** `idempotency.ts` は「`requestId`・`moneyId`・時刻の3つだけ。
 * 金額・店名・コメントは書かない」という方針で、`car-care:fuel-log:1234` のように内容を
 * 表さない値が来る前提になっている。内容をそのまま並べた文字列を置くと、
 * `data/zaim-payments.json` が支出の一覧そのものになる。
 *
 * **ただし「復元できないから安全」ではない。** 材料の取りうる範囲は狭く（金額は上限30万円、
 * 日付は数十通り、カテゴリ・ジャンルはマスタから既知）、総当たりで元の値へ戻せる。
 * 安全側の根拠は復元の難しさではなく、**この値を `data/` とサーバーログの外へ出さないこと**に置く。
 * MCPの応答には `requestId` を載せていない（返すのは `moneyId` と登録内容だけ）。
 * 固定のsaltを混ぜて復元を難しくする案は採らない——saltが変われば同じ支出が別の鍵になり、
 * 二重登録の判定そのものが効かなくなる。設定項目を1つ増やす代償のほうが大きい。
 *
 * **`comment` は混ぜない。** コメントを書き換えただけで別の支出とみなされ、二重登録の
 * 判定をすり抜ける。日付・金額・分類・店名・品名が同じなら同じ支出として扱う。
 */
export function paymentKey(input: ZaimPaymentInput): string {
  const fields = [
    input.date,
    String(input.amount),
    String(input.categoryId),
    String(input.genreId),
    input.fromAccountId === undefined ? "" : String(input.fromAccountId),
    input.place ?? "",
    input.name ?? "",
  ];
  // 長さを前に付けてから繋ぐ。単純な区切り文字だけだと、店名にその文字が入ったときに
  // 別々の支出が同じ材料になりうる（place="A|B" と place="A" / name="B"）。
  const material = fields.map((field) => `${field.length}:${field}`).join("|");
  return `mcp:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export interface ResolvedNames {
  /** 支払元の口座名。`fromAccountId` を省いた場合は null。 */
  accountName: string | null;
  categoryName: string;
  genreName: string;
}

/**
 * 渡されたIDがマスタに実在するかを確かめ、名前を引く。
 *
 * **AIDEが名寄せをするわけではない**（「ガソリン代 → 自動車費/ガソリン」の対応は持たない、が
 * `write.ts` の方針）。ここでやるのは、Claudeが選んだIDが本当にあるかの確認と、
 * 登録後に「何を登録したか」を人が読める形で返すための引き当てだけ。
 *
 * **ジャンルとカテゴリの対応も見る。** Zaimは `mapping=1` で両方をIDで受け取るため、
 * 噛み合っていない組み合わせを送ると意図しない分類で登録されうる。
 */
export function resolveNames(
  master: ZaimMasterView,
  input: ZaimPaymentInput,
): { ok: true; names: ResolvedNames } | { ok: false; error: string } {
  const category = master.categories.find((item) => item.id === input.categoryId);
  if (!category) return { ok: false, error: `categoryId ${input.categoryId} はZaimのカテゴリに見つかりません` };

  const genre = master.genres.find((item) => item.id === input.genreId);
  if (!genre) return { ok: false, error: `genreId ${input.genreId} はZaimのジャンルに見つかりません` };
  if (genre.categoryId !== input.categoryId) {
    return {
      ok: false,
      error:
        `genreId ${input.genreId}（${genre.name}）はカテゴリ ${genre.categoryId} のジャンルで、` +
        `指定された categoryId ${input.categoryId}（${category.name}）と噛み合っていません`,
    };
  }

  let accountName: string | null = null;
  if (input.fromAccountId !== undefined) {
    const account = master.accounts.find((item) => item.id === input.fromAccountId);
    if (!account) return { ok: false, error: `fromAccountId ${input.fromAccountId} はZaimの口座に見つかりません` };
    accountName = account.name;
  }

  return { ok: true, names: { accountName, categoryName: category.name, genreName: genre.name } };
}

/**
 * 口座・カテゴリ・ジャンルの候補。
 *
 * 登録に渡すIDを引くための読み取り専用のツール。**キャッシュを挟む**（24時間。
 * `src/core/views/zaim-master.ts`）ので、登録のたびに呼ばれてもZaimのAPIは叩かれない。
 */
export const zaimMasterTool: Tool = {
  name: "aide_zaim_master",
  description:
    "Zaimに登録できる口座・カテゴリ・ジャンルの一覧（IDと名前）を返す。" +
    "aide_zaim_payment に渡す categoryId / genreId / fromAccountId を決めるために呼ぶ。" +
    "genres には categoryId が付いているので、**カテゴリとジャンルは対応する組み合わせで選ぶこと**。" +
    "結果は24時間キャッシュしており、取得時刻と経過分数を併せて返す。" +
    "登録したい口座やカテゴリが一覧に無い場合（Zaimで作った直後など）だけ refresh: true で引き直す。",
  inputSchema: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description:
          "キャッシュを無視してZaimから引き直す。" +
          "**普段は指定しない。** 一覧に載っていない口座・カテゴリを使いたいときだけ true にする。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const credentials = loadZaimOAuthCredentials();
    if (!credentials) {
      return json({ ok: false, reason: "未設定（AIDE_ZAIM_* が揃っていないため、Zaimへは何も問い合わせていません）" });
    }

    const outcome = await readZaimMaster(credentials, { refresh: args["refresh"] === true });
    if (outcome.ok) return json({ ok: true, ...outcome.master });

    // 引き直しに失敗しても、掴んでいるキャッシュがあれば古い旨を添えて返す。
    // 候補が何も出せないと、Zaimが一時的に落ちているだけで登録そのものができなくなる。
    return json({ ok: false, reason: outcome.reason, ...(outcome.master ?? {}) });
  },
};

/**
 * 支出を1件登録する。**AIDEが持つ2つ目の書き込みツール。**
 */
export const zaimPaymentTool: Tool = {
  name: "aide_zaim_payment",
  description:
    "Zaimへ支出を1件登録する。**書き込みを伴うツール。この経路から取り消し・修正はできない。**" +
    "「Zaimにつけておいて」「家計簿に記録して」と明示的に頼まれたときだけ呼ぶ。" +
    "会話に支出の話が出ただけでは呼ばない。" +
    "先に aide_zaim_master を呼び、categoryId / genreId / fromAccountId を対応する組み合わせで決めること。" +
    `1件あたり ${MCP_MAX_AMOUNT.toLocaleString("en-US")}円までで、未来の日付は登録できない。` +
    "**同じ内容（日付・金額・分類・店名・品名）が既に登録されている場合は登録せずに止まる。** " +
    "本当に別の支出なら、**利用者に確認したうえで** allowDuplicate: true を付けて呼び直す" +
    "（確認せずに付け直さないこと。二重登録になり、取り消せない）。" +
    "登録できたら moneyId と、実際に登録された内容（解決後の口座名・カテゴリ名・ジャンル名）を返す。",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "integer",
        description: `金額（円。1以上の整数）。${MCP_MAX_AMOUNT.toLocaleString("en-US")}円を超えるものは登録できない。`,
      },
      date: {
        type: "string",
        description:
          "支出の日付（YYYY-MM-DD。日本時間の暦日）。**未来の日付は登録できない。** " +
          "「昨日」「一昨日」のような相対表現は、利用者の今日を基準に具体的な日付へ直してから渡す。",
      },
      categoryId: { type: "integer", description: "カテゴリID。aide_zaim_master の categories から選ぶ。" },
      genreId: {
        type: "integer",
        description:
          "ジャンルID。aide_zaim_master の genres から選ぶ。" +
          "**その genre の categoryId が上の categoryId と一致している必要がある。**",
      },
      fromAccountId: {
        type: "integer",
        description:
          "支払元の口座ID。aide_zaim_master の accounts から選ぶ。" +
          "どの口座から払ったか分からない場合は省く（Zaim側で口座なしの記録になる）。",
      },
      place: { type: "string", description: "店名（100文字まで）。分からなければ省く。" },
      name: { type: "string", description: "品目名（100文字まで）。分からなければ省く。" },
      comment: { type: "string", description: "メモ（100文字まで）。二重登録の判定には使わない。" },
      allowDuplicate: {
        type: "boolean",
        description:
          "同じ内容の登録が既にある場合でも、別の支出として登録する。" +
          "**利用者に確認せずに指定しないこと。** 同じ日に同じ店で同じ金額を2回払った、" +
          "というように利用者が別件だと明言した場合にだけ true にする。" +
          "前回の結果が確定していない（kind: conflict）場合は、これを付けても登録されない。",
      },
    },
    required: ["amount", "date", "categoryId", "genreId"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const credentials = loadZaimOAuthCredentials();
    if (!credentials) {
      return json({ ok: false, reason: "未設定（AIDE_ZAIM_* が揃っていないため、Zaimへは何も送っていません）" });
    }

    // 形式の検査は既存の口（`POST /api/zaim/payment`）と同じものを通す。
    // requestId だけは正規化後の内容から作るので、ここでは仮の値を渡しておく。
    const normalized = normalizePaymentInput({ ...args, requestId: PENDING_REQUEST_ID });
    if ("error" in normalized) return json({ ok: false, kind: "invalid", reason: normalized.error });
    const input = normalized.input;

    // ---- MCP経由だけの歯止め ----
    if (input.amount > MCP_MAX_AMOUNT) {
      return json({
        ok: false,
        kind: "invalid",
        reason:
          `amount が ${MCP_MAX_AMOUNT.toLocaleString("en-US")}円を超えています（会話からの登録は取り消せないため、` +
          "この経路では受け付けません）。金額が正しいなら、Zaimの画面から登録してください。",
      });
    }
    const today = tokyoDate(new Date());
    if (input.date > today) {
      return json({
        ok: false,
        kind: "invalid",
        reason: `date が未来（${input.date}）です。今日は ${today}（日本時間）で、支出は今日までの日付でしか登録できません。`,
      });
    }

    // ---- IDがマスタに実在するかを確かめる ----
    // 見つからなければ**一度だけ**引き直す。Zaimで口座やカテゴリを作った直後は
    // キャッシュ（24時間）に載っておらず、そのままではその口座へ登録できない。
    let master = await readZaimMaster(credentials);
    let resolved = master.master ? resolveNames(master.master, input) : null;
    if (resolved && !resolved.ok) {
      master = await readZaimMaster(credentials, { refresh: true });
      resolved = master.master ? resolveNames(master.master, input) : null;
    }
    if (resolved && !resolved.ok) {
      return json({
        ok: false,
        kind: "invalid",
        reason: resolved.error,
        // 引き直せていないなら、IDが無いのではなくZaimへ届いていないだけかもしれない。
        // これを黙って「見つかりません」と言うと、実在するIDを疑わせることになる。
        ...(master.ok ? {} : { masterRefreshFailed: master.reason }),
        hint: "aide_zaim_master を呼び直して、実在する ID の組み合わせを選んでください。",
      });
    }

    // ---- 二重登録を止める ----
    const base = paymentKey(input);
    const series = await findPaymentSeries(base);

    // **結果が確定していない記録は `allowDuplicate` でも跨がせない。**
    // `createZaimPayment()` の conflict 判定は `requestId` の完全一致なので、連番で別の鍵に
    // すると `status: "new"` になってZaimへ送られてしまう。打ち切り・5xx の直後は登録された
    // 可能性が残っており、ここが「取り消せない二重登録」の最後の砦になる（README「二重登録を止める」）。
    const unresolved = series.find((record) => record.moneyId === null);
    if (unresolved) {
      return json({
        ok: false,
        kind: "conflict",
        reason:
          `同じ内容の登録を ${unresolved.at} に試みており、結果が確定していません。登録していません。`,
        hint:
          "**再送しないでください**（allowDuplicate を付けても通しません）。" +
          "Zaimを確認してもらい、登録されていなければZaimの画面から登録してください。",
      });
    }

    if (series.length > 0 && args["allowDuplicate"] !== true) {
      return json({
        ok: false,
        kind: "duplicate",
        reason:
          "同じ内容（日付・金額・分類・店名・品名）の支出が既に登録されています。登録していません。",
        existing: series.map((record) => ({ moneyId: record.moneyId, at: record.at })),
        hint:
          "本当に別の支出かどうかを**利用者に確認**してください。別件だと確認できた場合だけ、" +
          "同じ引数に allowDuplicate: true を付けて呼び直します。",
      });
    }

    const requestId = nextRequestId(base, series);
    const outcome = await createZaimPayment(credentials, { ...input, requestId });
    if (!outcome.ok) {
      return json({
        ok: false,
        kind: outcome.kind,
        reason: outcome.reason,
        ...(outcome.kind === "rejected"
          ? { hint: "aide_zaim_master を refresh: true で引き直し、ID の組み合わせを確かめてください。" }
          : {}),
        ...(outcome.kind === "conflict"
          ? { hint: "**再送しないでください。** Zaimの画面で登録されているかを利用者に確認してもらいます。" }
          : {}),
      });
    }

    return json({
      ok: true,
      moneyId: outcome.moneyId,
      duplicated: outcome.duplicated,
      // 何が登録されたかをそのまま返す。桁違い・日付の取り違えに、利用者がこの応答で気づける。
      registered: {
        date: input.date,
        amount: input.amount,
        categoryName: resolved?.ok ? resolved.names.categoryName : null,
        genreName: resolved?.ok ? resolved.names.genreName : null,
        accountName: resolved?.ok ? resolved.names.accountName : null,
        place: input.place ?? null,
        name: input.name ?? null,
        comment: input.comment ?? null,
      },
      // マスタを引けないままZaimへ送った場合だけ true。名前の欄が null なのはこれが理由。
      ...(resolved === null ? { masterUnavailable: true } : {}),
    });
  },
};
