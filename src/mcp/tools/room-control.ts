import {
  fetchRoomButtons,
  normalizeName,
  pressRoomButton,
  readMyRoomControlConfig,
} from "../../core/connectors/myroom/control.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 部屋の照明などの操作（aide#317）。myroom に登録済みの Nature Remo のボタンを押す。
 * README「書き込みをどこまで持つか」の3条件は `src/core/connectors/myroom/control.ts` を参照。
 *
 * **一覧（`aide_room_buttons`）と押す（`aide_room_press`）を分けている。** Zaim（#135）と同じ理由で、
 * 1本に畳むとClaude Code側で「常に許可」にしたときに操作まで素通しになる。
 *
 * 誤操作を防ぐため、押すときは次の2つを確かめる。
 *
 * - **ボタンIDと名前の両方を受け取り、myroom の今の登録と突き合わせる。** IDだけだと、Claudeが
 *   取り違えたIDや、myroom側で登録し直されて別のボタンを指すようになったIDをそのまま押してしまう
 * - **同じボタンを短い間隔で続けて押さない。** 赤外線の「電源」のようなトグルは2回押すと元に戻る。
 *   応答待ちで打ち切られたClaudeが再試行すると、利用者の意図と逆の状態になる
 */

/** 同じボタンを続けて押したとみなす間隔。 */
export const REPEAT_GUARD_MS = 30_000;

/** ボタンIDごとの、最後に送信を依頼した時刻（エポックミリ秒）。プロセス内だけで持つ。 */
const lastPressedAt = new Map<string, number>();

/** テスト用。前のテストの押下記録を持ち越さないようにする。 */
export function resetPressHistory(): void {
  lastPressedAt.clear();
}

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・不一致・myroom側のエラーは「エラー」ではなく状態。isError にすると
    // Claudeが同じ内容で再試行し、操作が二重になりうる（他の書き込みツールと同じ考え方）。
    isError: false,
  };
}

const NOT_CONFIGURED = "未設定（AIDE_MYROOM_CONTROL_TOKEN が無いため、myroom へは何も送っていません）";

export const roomButtonsTool: Tool = {
  name: "aide_room_buttons",
  description:
    "部屋の照明など、AIDEから操作できる機器のボタンの一覧を返す（myroom に登録済みの Nature Remo のボタン）。" +
    "「電気をつけて」「照明を消して」のように機器の操作を頼まれたら、まずこれを呼んで押すボタンを探す。" +
    "各ボタンの name（「グループ名 / ボタン名」）と id を aide_room_press に渡す。" +
    "読み取りだけで、機器は操作しない。部屋の室温・照度などの測定値は aide_room_sensors、" +
    "エアコンの運転状態は aide_aircon_status。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const config = readMyRoomControlConfig();
    if (!config) return json({ ok: false, reason: NOT_CONFIGURED });

    const result = await fetchRoomButtons(config);
    if (!result.ok) return json(result);

    return json({
      ok: true,
      buttons: result.buttons,
      ...(result.buttons.length === 0
        ? { hint: "操作できるボタンが登録されていません。myroom の設定画面（電気の操作）から登録してもらってください。" }
        : {}),
    });
  },
};

export const roomPressTool: Tool = {
  name: "aide_room_press",
  description:
    "部屋の照明などのボタンを1つ押す（myroom 経由で Nature Remo から赤外線を送る）。" +
    "**実際に部屋の機器を操作するツール。**" +
    "利用者が機器の操作を明示的に頼んだときだけ呼ぶ。会話に照明の話が出ただけでは呼ばない。" +
    "先に aide_room_buttons で一覧を取り、依頼に合うボタンが1つに決まらなければ候補を示して利用者に選んでもらう。" +
    "**押す前に、押すボタンの name を利用者に伝えて確認を取ること。**" +
    "id と expectedName（一覧の name をそのまま）の両方を渡す。今の登録と食い違うと押さずに返す。" +
    "結果は「送信を依頼できたか」までで、赤外線は片方向のため機器が反応したかは分からない。" +
    "反応を確かめたいときは利用者に尋ねるか、照明なら aide_room_sensors の照度の変化を見る" +
    "（照度の測定は数分おきなので、すぐには変わらない）。" +
    "kind が unknown のときは送れたか分からないので、**再送せず**利用者に機器の様子を確認してもらう。" +
    "同じボタンを30秒以内に続けて押すと断る。利用者が続けて押すことを望んだときだけ allowRepeat: true を付ける" +
    "（「電源」のようなボタンは2回押すと元に戻るため）。" +
    "**どのボタンか自信が無いときは dryRun: true で呼ぶ**と、押さずに" +
    "「どのボタンを押すことになるか」だけを返す。",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "押すボタンのID（aide_room_buttons の id）。" },
      expectedName: {
        type: "string",
        description: "押すボタンの名前（aide_room_buttons の name。例: 「照明 / 点ける」）。",
      },
      allowRepeat: {
        type: "boolean",
        description:
          "同じボタンを30秒以内に続けて押すことを許す。**利用者が続けて押すことを望んだときだけ**付ける。",
      },
      dryRun: {
        type: "boolean",
        description:
          "**押さずに、どのボタンを押すことになるかだけを返す。** 登録との突き合わせと" +
          "連打の判定まで本番と同じものを通すので、押すボタンの名前を利用者に確かめてもらえる。" +
          "**押したことにはならないので、連打の30秒も数え始めない。**",
      },
    },
    required: ["id", "expectedName"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = typeof args["id"] === "string" ? args["id"].trim() : "";
    const expectedName = typeof args["expectedName"] === "string" ? args["expectedName"].trim() : "";
    if (!id || !expectedName) {
      return json({ ok: false, kind: "invalid", reason: "id と expectedName が必要です（aide_room_buttons で確かめてください）" });
    }

    const config = readMyRoomControlConfig();
    if (!config) return json({ ok: false, reason: NOT_CONFIGURED });

    // myroom の今の登録と突き合わせる。一覧はNature Remoを叩かないので、押すたびに引いてよい。
    const list = await fetchRoomButtons(config);
    if (!list.ok) return json(list);

    const button = list.buttons.find((candidate) => candidate.id === id);
    if (!button) {
      return json({
        ok: false,
        kind: "not_found",
        reason: "そのIDのボタンは myroom に登録されていません。何も送っていません。",
        buttons: list.buttons,
      });
    }
    if (normalizeName(button.name) !== normalizeName(expectedName)) {
      return json({
        ok: false,
        kind: "mismatch",
        reason: `そのIDのボタンは「${button.name}」で、指定の「${expectedName}」と一致しません。何も送っていません。`,
        hint: "押すボタンを利用者に確認し直してから、一覧の id と name の組み合わせで呼び直してください。",
      });
    }

    const now = Date.now();
    const last = lastPressedAt.get(button.id);
    if (args["allowRepeat"] !== true && last !== undefined && now - last < REPEAT_GUARD_MS) {
      return json({
        ok: false,
        kind: "repeated",
        reason: `「${button.name}」は${Math.ceil((now - last) / 1000)}秒前に押したばかりです。何も送っていません。`,
        hint: "続けて押すのが利用者の意図だと確認できた場合だけ allowRepeat: true を付けて呼び直してください。",
      });
    }

    // **押下の記録より前で止める。** 下見のつもりの呼び出しで30秒の連打ガードを
    // 数え始めると、確認が取れた直後の本番の呼び出しが `repeated` で断られる。
    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        wouldPress: button.name,
        note: "何も送っていません。このボタンでよければ dryRun を外して呼び直してください。",
      });
    }

    // 送れたか分からない（unknown）ときも、続けて押さないよう記録しておく。
    lastPressedAt.set(button.id, now);
    const outcome = await pressRoomButton(config, button.id);
    if (!outcome.ok) {
      if (outcome.kind !== "unknown") lastPressedAt.delete(button.id);
      return json({
        ...outcome,
        button: button.name,
        ...(outcome.kind === "unknown"
          ? { hint: "**再送しないでください。** 機器が反応したかを利用者に確認してもらいます。" }
          : {}),
      });
    }

    return json({
      ok: true,
      sent: true,
      button: button.name,
      note: "赤外線の送信を依頼しました。機器が実際に反応したかは分かりません。",
    });
  },
};
