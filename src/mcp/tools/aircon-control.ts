import {
  AIRCON_FAN_SPEEDS,
  AIRCON_MODES,
  AIRCON_POWERS,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  TEMPERATURE_STEP,
  conflictsWithAutoMode,
  fetchAirconState,
  parseAirconCommand,
  planAirconChange,
  sendAirconCommand,
} from "../../core/connectors/myroom/aircon-control.ts";
import type { AirconCommand, AirconState } from "../../core/connectors/myroom/aircon-control.ts";
import { normalizeName, readMyRoomControlConfig } from "../../core/connectors/myroom/control.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * エアコンの操作（aide#316）。myroom 経由で白くまくんへ運転指示を送る。
 * README「書き込みをどこまで持つか」の3条件は `src/core/connectors/myroom/aircon-control.ts` を参照。
 *
 * **読み取り（`aide_aircon_status`）と操作を分けている。** 1本に畳むと、クライアント側で
 * 「常に許可」にしたときに操作まで素通しになる（Zaim・照明と同じ理由）。
 *
 * 誤操作を防ぐため、送る前に次を確かめる。
 *
 * - **IDと名前の両方を受け取り、いまの登録と突き合わせる。** 取り違えたIDで別のエアコンを操作しない
 * - **いまの状態を白くまくんから直接読み、実際に変わる項目だけを送る。** 変わらない指示は送らない
 * - **オフライン（online: false）のエアコンには送らない。** 送っても反映されないのに、成功に見えてしまう
 * - **自動運転では設定温度を受けない。** 自動運転の「設定温度」は室温からのシフト量で、意味が違う
 *
 * 送った後は状態を読み戻し、指示どおりになっているかを返す。**変更前の状態も返す**ので、
 * 間違えたときはその値で元に戻せる。
 */

const NOT_CONFIGURED = "未設定（AIDE_MYROOM_CONTROL_TOKEN が無いため、myroom へは何も送っていません）";

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・不一致・myroom側のエラーは「エラー」ではなく状態。isError にすると
    // Claudeが同じ内容で再試行し、操作が二重になりうる（他の書き込みツールと同じ考え方）。
    isError: false,
  };
}

/** 応答へ載せる状態。 */
function view(state: AirconState): Record<string, unknown> {
  return {
    name: state.name,
    power: state.power,
    mode: state.mode,
    targetTemperature: state.targetTemperature,
    roomTemperature: state.roomTemperature,
    fanSpeed: state.fanSpeed,
    online: state.online,
  };
}

/** 読み戻した状態が、頼んだ内容と合っているか。 */
function matchesCommand(state: AirconState, command: AirconCommand): boolean {
  return (
    (command.power === undefined || state.power === command.power) &&
    (command.mode === undefined || state.mode === command.mode) &&
    (command.targetTemperature === undefined || state.targetTemperature === command.targetTemperature) &&
    (command.fanSpeed === undefined || state.fanSpeed === command.fanSpeed)
  );
}

export const airconControlTool: Tool = {
  name: "aide_aircon_control",
  description:
    "エアコンの電源・運転モード・設定温度・風量を変更する（myroom 経由で白くまくんへ運転指示を送る）。" +
    "**実際に部屋のエアコンを操作するツール。**" +
    "利用者がエアコンの操作を明示的に頼んだときだけ呼ぶ。会話にエアコンの話が出ただけでは呼ばない。" +
    "先に aide_aircon_status で対象の acId と name を確かめる（エアコンが複数あって決まらなければ利用者に選んでもらう）。" +
    "**送る前に、対象の名前と変更内容（例:「リビングを冷房26℃・風量自動にします」）を利用者に伝えて確認を取ること。**" +
    "acId と expectedName（aide_aircon_status の name をそのまま）の両方を渡す。今の登録と食い違うと送らずに返す。" +
    "power・mode・targetTemperature・fanSpeed のうち変えたい項目だけを渡す（指定しない項目は今のまま）。" +
    "設定温度は16〜32℃の0.5℃刻み。**自動運転（mode: AUTO）では設定温度を指定できない**" +
    "（自動運転の設定温度は室温からのシフト量で意味が違うため）。" +
    "今と同じ値なら何も送らず changed: false を返す。オフライン（online: false）のエアコンには送らない。" +
    "結果は、送信後の状態の読み戻し（readback.matches）まで返す。" +
    "**matches が false でも失敗とは限らず、反映に少し時間がかかっているだけのことがある**ので、" +
    "利用者には「送信しました。反映を確認できていません」と伝え、再送せずしばらくしてから状態を確かめる" +
    "（aide_aircon_status は最大5分前の記録なので、すぐの確認には向かない）。" +
    "kind が unknown のときは送れたか分からないので、**再送せず**利用者にエアコンの様子を確認してもらう。" +
    "応答の before は変更前の状態で、間違えたときはその値で元に戻せる。" +
    "**どの項目をどう変えるか自信が無いときは dryRun: true で呼ぶ**と、送らずに「変更前→変更後」だけを返す。" +
    "照明などの操作は aide_room_buttons と aide_room_press。",
  inputSchema: {
    type: "object",
    properties: {
      acId: { type: "integer", description: "操作するエアコンのID（aide_aircon_status の acId）。" },
      expectedName: {
        type: "string",
        description: "操作するエアコンの名前（aide_aircon_status の name。例: 「リビング」）。",
      },
      power: { type: "string", enum: [...AIRCON_POWERS], description: "電源。ON / OFF。" },
      mode: {
        type: "string",
        enum: [...AIRCON_MODES],
        description: "運転モード。COOLING=冷房 / HEATING=暖房 / DRY=除湿 / FAN=送風 / AUTO=自動。",
      },
      targetTemperature: {
        type: "number",
        minimum: MIN_TEMPERATURE,
        maximum: MAX_TEMPERATURE,
        multipleOf: TEMPERATURE_STEP,
        description: "設定温度（℃）。16〜32の0.5刻み。自動運転（AUTO）では指定できない。",
      },
      fanSpeed: {
        type: "string",
        enum: [...AIRCON_FAN_SPEEDS],
        description: "風量。AUTO=自動 / LV1=静 … LV4=強。",
      },
      dryRun: {
        type: "boolean",
        description:
          "**送らずに、何がどう変わるかだけを返す。** 名前の突き合わせ・オフライン・変更の有無の判定まで" +
          "本番と同じものを通すので、変更内容を利用者に確かめてもらえる。",
      },
    },
    required: ["acId", "expectedName"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const acId = args["acId"];
    const expectedName = typeof args["expectedName"] === "string" ? args["expectedName"].trim() : "";
    if (typeof acId !== "number" || !Number.isInteger(acId) || acId < 1 || !expectedName) {
      return json({
        ok: false,
        kind: "invalid",
        reason: "acId（1以上の整数）と expectedName が必要です（aide_aircon_status で確かめてください）",
      });
    }

    const parsed = parseAirconCommand(args);
    if (!parsed.ok) return json({ ok: false, kind: "invalid", reason: `${parsed.reason}。何も送っていません。` });
    const command = parsed.command;

    const config = readMyRoomControlConfig();
    if (!config) return json({ ok: false, reason: NOT_CONFIGURED });

    // いまの状態を白くまくんから直接読む。名前の突き合わせにも、変更前の記録にも使う。
    const current = await fetchAirconState(config, acId);
    if (!current.ok) return json(current);
    const before = current.state;

    // 名前が読めないエアコンは突き合わせられない。それでも操作は止めない（IDが合っていれば対象は決まる）。
    if (before.name && normalizeName(before.name) !== normalizeName(expectedName)) {
      return json({
        ok: false,
        kind: "mismatch",
        reason: `そのIDのエアコンは「${before.name}」で、指定の「${expectedName}」と一致しません。何も送っていません。`,
        hint: "操作するエアコンを利用者に確認し直してから、aide_aircon_status の acId と name の組み合わせで呼び直してください。",
      });
    }
    const target = before.name || expectedName;

    if (!before.online) {
      return json({
        ok: false,
        kind: "offline",
        reason: `「${target}」はオフライン（online: false）です。何も送っていません。`,
        hint: "エアコンがネットワークに繋がっていません。電源やWi-Fiを利用者に確認してもらってください。",
        before: view(before),
      });
    }

    if (conflictsWithAutoMode(before, command)) {
      return json({
        ok: false,
        kind: "invalid",
        reason:
          "自動運転（AUTO）では設定温度を指定できません（自動運転の設定温度は室温からのシフト量で、意味が違うため）。何も送っていません。",
        hint: "温度を指定したいときは、冷房・暖房などの mode と一緒に指定してください。",
      });
    }

    const plan = planAirconChange(before, command);
    if (plan.changes.length === 0) {
      return json({
        ok: true,
        changed: false,
        aircon: target,
        note: "すでに指定のとおりの状態なので、何も送っていません。",
        before: view(before),
      });
    }

    // **送る直前で止める。** 状態の読み取りと突き合わせは本番と同じものを通している。
    if (args["dryRun"] === true) {
      return json({
        ok: true,
        dryRun: true,
        aircon: target,
        wouldChange: plan.changes,
        ...(plan.note ? { warning: plan.note } : {}),
        before: view(before),
        note: "何も送っていません。この内容でよければ dryRun を外して呼び直してください。",
      });
    }

    const outcome = await sendAirconCommand(config, acId, command);
    if (!outcome.ok) {
      return json({
        ...outcome,
        aircon: target,
        before: view(before),
        ...(outcome.kind === "unknown"
          ? { hint: "**再送しないでください。** エアコンが変わったかを利用者に確認してもらうか、少し置いてから状態を確かめます。" }
          : {}),
        ...(outcome.kind === "rate_limited"
          ? { hint: "しばらく待ってからでないと送れません。続けて再試行しないでください。" }
          : {}),
      });
    }

    // 送信後の状態を読み戻す。反映に時間がかかることがあるので、合っていなくても失敗とはしない。
    const readback = await fetchAirconState(config, acId);
    const readbackResult = readback.ok
      ? { matches: matchesCommand(readback.state, command), state: view(readback.state) }
      : { matches: null, reason: `読み戻せませんでした: ${readback.reason}` };

    return json({
      ok: true,
      sent: true,
      aircon: target,
      changes: plan.changes,
      ...(plan.note ? { warning: plan.note } : {}),
      before: view(before),
      ...(outcome.state ? { expected: view(outcome.state) } : {}),
      readback: readbackResult,
      note:
        readbackResult.matches === true
          ? "運転指示を送り、指定どおりの状態になっていることを確認しました。"
          : "運転指示を送りました。まだ指定の状態を確認できていません（反映に時間がかかっているだけのことがあります）。",
    });
  },
};
