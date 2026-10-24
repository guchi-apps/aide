import {
  BILL_KINDS,
  CONTRACT_KEY_PATTERN,
  fetchBill,
  fetchBillContracts,
  importBill,
  readBillsReadConfig,
  readBillsWriteConfig,
  type BillKind,
  type BillRecord,
  type BillsConfig,
  type BillsFailure,
  type ImportPayload,
} from "../../core/connectors/myroom/bills.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * kurashio の電気・ガスの月次請求を照会・登録する（#678）。API契約は guchi-apps/kurashio#814。
 *
 * **読み取りと書き込みは別ツール・別scope**（`kurashio-bills:read` / `kurashio-bills:write`）。
 * Zaim由来の読み取り `aide_utility_bills` とは保存先も目的も違うので、意味を混ぜない。
 *
 * 安全のための作り:
 * - 既存の行は書き換えない（kurashio が `duplicate` / `conflict` を返す）。訂正の経路は持たない
 * - 契約キーは kurashio の候補一覧にあるものを受ける。候補に無い初回・新規の契約は、利用者が確認したうえで
 *   `confirmNewContract: true` を明示したときだけ通す（推測で作らない。#685）
 * - 金額が不明なら送らない（`insufficient_data`）。0円などで埋めない
 * - 登録後に読み取り用トークンで読み戻し、主要項目が一致したときだけ `created` を返す
 * - 応答待ちが切れたら `unknown` と、出典で照会する方法を返す（盲目的な再送をさせない）
 */

export const KURASHIO_BILLS_READ = ["kurashio-bills:read"] as const;
export const KURASHIO_BILLS_WRITE = ["kurashio-bills:write"] as const;

const BILLING_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** タイムゾーン付きのISO 8601（`Z` か `+09:00`）。無いと受信日時がどの時刻か決まらない。 */
const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_AMOUNT_YEN = 1_000_000;
const MAX_USAGE = 100_000;
const MAX_MESSAGE_ID = 255;
const MAX_LABEL = 64;
/** 使用量の一致は kurashio と同じく小数1桁の丸め（メールの表記）で見る */
const USAGE_TOLERANCE = 0.05;

export interface KurashioBillsDeps {
  readConfig: () => Promise<BillsConfig | null>;
  writeConfig: () => Promise<BillsConfig | null>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_DEPS: KurashioBillsDeps = { readConfig: readBillsReadConfig, writeConfig: readBillsWriteConfig };

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function invalid(reason: string): ToolResult {
  return result({ status: "invalid", reason }, true);
}

function failure(f: BillsFailure, extra: Record<string, unknown> = {}): ToolResult {
  return result({ status: f.kind, reason: f.reason, ...extra }, true);
}

function notConfigured(which: "read" | "write"): ToolResult {
  return result(
    {
      status: "not_configured",
      reason:
        which === "read"
          ? "AIDE に kurashio の読み取り用トークン（MYROOM_INTERNAL_API_KEY）が設定されていません"
          : "AIDE が kurashio の書込専用の共有トークン（MYROOM_INTERNAL_BILLS_WRITE_API_KEY）を取得できません",
    },
    true,
  );
}

function parseKind(value: unknown): BillKind | null {
  return typeof value === "string" && (BILL_KINDS as readonly string[]).includes(value) ? (value as BillKind) : null;
}

function parseContractKey(value: unknown): string | null {
  return typeof value === "string" && CONTRACT_KEY_PATTERN.test(value) ? value : null;
}

function parseMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_MESSAGE_ID ? trimmed : null;
}

function optionalLabel(value: unknown, name: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.trim().length > MAX_LABEL) {
    return { ok: false, reason: `${name} は${MAX_LABEL}文字以内の文字列で指定してください` };
  }
  return { ok: true, value: value.trim() || null };
}

/**
 * メールの受信日時を、kurashio の既存データと同じ「JSTのタイムゾーン無し」へ揃える。
 * 収集スクリプトは受信日時をJSTのnaiveで保存している。タイムゾーン付きで送ると kurashio は
 * UTCへ直して保存するため、同じ列に2つの基準が混ざる。
 */
export function toJstNaive(value: string): string {
  const jst = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 19);
}

type Parsed = { ok: true; payload: ImportPayload } | { ok: false; result: ToolResult };

/** 取込の引数を検証して、kurashio へ送る形にする。形の検証だけで、業務の判定はkurashioに任せる。 */
export function parseImportArgs(args: Record<string, unknown>): Parsed {
  const bad = (reason: string): Parsed => ({ ok: false, result: invalid(reason) });

  const billingMonth = args["billingMonth"];
  if (typeof billingMonth !== "string" || !BILLING_MONTH.test(billingMonth)) {
    // 日付（2026-08-05）を受けると、受信日・検針日を請求月と取り違えたまま保存しかねない。
    return bad("billingMonth は請求月を YYYY-MM で指定してください（受信日・検針日ではなく、メールに書かれた「◯月分」）");
  }
  const kind = parseKind(args["kind"]);
  if (!kind) return bad("kind は electricity か gas を指定してください（水道は対象外）");
  const contractKey = parseContractKey(args["contractKey"]);
  if (!contractKey) return bad("contractKey は kurashio_utility_bill_contracts が返した契約キーを指定してください");

  const amount = args["amountYen"];
  if (amount === undefined || amount === null) {
    return {
      ok: false,
      result: result(
        { status: "insufficient_data", reason: "金額（amountYen）が分からないため登録しません。0円などで補わないでください" },
        true,
      ),
    };
  }
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > MAX_AMOUNT_YEN) {
    return bad(`amountYen は0以上${MAX_AMOUNT_YEN}以下の整数（円）で指定してください`);
  }

  const usage = args["usageValue"];
  if (usage !== undefined && usage !== null && (typeof usage !== "number" || !Number.isFinite(usage) || usage < 0 || usage > MAX_USAGE)) {
    return bad(`usageValue は0以上${MAX_USAGE}以下の数値で指定してください`);
  }
  const unit = args["usageUnit"];
  if (unit !== undefined && unit !== null && (typeof unit !== "string" || unit.length > 16)) {
    return bad("usageUnit は kWh / m3（m³・㎥も可）で指定してください");
  }
  if ((usage === undefined || usage === null) && typeof unit === "string" && unit.trim()) {
    return bad("usageUnit だけを指定することはできません。使用量が不明なら両方省略してください");
  }

  const receivedAt = args["receivedAt"];
  if (receivedAt !== undefined && receivedAt !== null) {
    if (typeof receivedAt !== "string" || !ZONED_DATETIME.test(receivedAt) || Number.isNaN(Date.parse(receivedAt))) {
      return bad("receivedAt はメールの受信日時をタイムゾーン付きISO 8601で指定してください（例: 2026-08-05T09:12:00+09:00）");
    }
  }

  const messageId = parseMessageId(args["sourceMessageId"]);
  if (!messageId) return bad(`sourceMessageId は元メール（Gmail）の messageId を${MAX_MESSAGE_ID}文字以内で指定してください`);

  const confidence = args["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return bad("confidence はメールからの読み取りの確からしさを0〜1で指定してください");
  }

  const planName = optionalLabel(args["planName"], "planName");
  if (!planName.ok) return bad(planName.reason);
  const sourceLabel = optionalLabel(args["sourceLabel"], "sourceLabel");
  if (!sourceLabel.ok) return bad(sourceLabel.reason);

  return {
    ok: true,
    payload: {
      billing_month: billingMonth,
      kind,
      contract_key: contractKey,
      amount_yen: amount,
      usage_value: typeof usage === "number" ? usage : null,
      usage_unit: typeof unit === "string" && unit.trim() ? unit.trim() : null,
      plan_name: planName.value,
      received_at: typeof receivedAt === "string" ? toJstNaive(receivedAt) : null,
      source_message_id: messageId,
      source_label: sourceLabel.value,
      confidence,
    },
  };
}

/** 読み戻した行が、登録を求めた内容・kurashio の登録応答と一致するか。食い違った項目名を返す。 */
export function verifyRecord(saved: BillRecord, payload: ImportPayload, reported: BillRecord | null): string[] {
  const fields: string[] = [];
  if (saved.billingMonth !== payload.billing_month) fields.push("billingMonth");
  if (saved.kind !== payload.kind) fields.push("kind");
  if (saved.contractKey !== payload.contract_key) fields.push("contractKey");
  if (saved.amountYen !== payload.amount_yen) fields.push("amountYen");
  const usageMatches =
    saved.usageValue === null || payload.usage_value === null
      ? saved.usageValue === payload.usage_value
      : Math.abs(saved.usageValue - payload.usage_value) <= USAGE_TOLERANCE;
  if (!usageMatches) fields.push("usageValue");
  // 単位は kurashio が正規化する（m³ → m3）ので、入力ではなく登録応答の値と比べる。
  if (reported && saved.usageUnit !== reported.usageUnit) fields.push("usageUnit");
  return fields;
}

function lookupHint(payload: ImportPayload) {
  return {
    tool: "kurashio_get_utility_bill",
    arguments: { kind: payload.kind, contractKey: payload.contract_key, sourceMessageId: payload.source_message_id },
    note: "同じ内容で再送する前に、この照会で保存されたかを確かめてください（再送しても上書きはされません）",
  };
}

export function createKurashioBillContractsTool(deps: KurashioBillsDeps = DEFAULT_DEPS): Tool {
  return {
    name: "kurashio_utility_bill_contracts",
    description:
      "kurashioに記録済みの電気・ガスの契約候補（不透明な契約キー・契約種別・最新の請求月）を返す読み取りツール。" +
      "kurashio_import_utility_bill の contractKey を決めるために先に呼ぶ。お客さま番号は返さない（kurashioも持っていない）。" +
      "候補が複数あってメールの契約種別・時期から1つに決められないとき、または候補が無い（引越し直後の新しい契約など）ときは、" +
      "推測で選ばずに利用者へ確認する。Zaim由来の電気代・ガス代の推移は aide_utility_bills を使う。",
    requiredScopes: KURASHIO_BILLS_READ,
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: [...BILL_KINDS], description: "electricity=電気 / gas=ガス" } },
      required: ["kind"],
      additionalProperties: false,
    },
    async handler(args) {
      const kind = parseKind(args["kind"]);
      if (!kind) return invalid("kind は electricity か gas を指定してください");
      const config = await deps.readConfig();
      if (!config) return notConfigured("read");
      const fetched = await fetchBillContracts(config, kind, deps.fetchImpl);
      if (!fetched.ok) return failure(fetched);
      return result({ status: "ok", kind, contracts: fetched.contracts });
    },
  };
}

export function createKurashioGetBillTool(deps: KurashioBillsDeps = DEFAULT_DEPS): Tool {
  return {
    name: "kurashio_get_utility_bill",
    description:
      "kurashioに保存済みの電気・ガスの月次請求を1件読む読み取りツール。種別・契約キーに加えて、請求月（billingMonth）か" +
      "元メールのmessageId（sourceMessageId）のどちらか一方で指定する。" +
      "status は found（保存値・revision・出典を返す）/ not_found（未登録）/ not_configured / unauthorized / unsupported / failed のいずれか。" +
      "kurashio_import_utility_bill が unknown を返したときは、ここで sourceMessageId を指定して保存されたかを確かめる。" +
      "契約キーは kurashio_utility_bill_contracts で調べる。Zaim由来の電気代・ガス代は aide_utility_bills。",
    requiredScopes: KURASHIO_BILLS_READ,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...BILL_KINDS], description: "electricity=電気 / gas=ガス" },
        contractKey: { type: "string", description: "kurashio_utility_bill_contracts が返した契約キー" },
        billingMonth: { type: "string", description: "請求月（YYYY-MM）。sourceMessageId と同時には指定しない" },
        sourceMessageId: { type: "string", description: "登録時に渡した元メール（Gmail）の messageId。billingMonth と同時には指定しない" },
      },
      required: ["kind", "contractKey"],
      additionalProperties: false,
    },
    async handler(args) {
      const kind = parseKind(args["kind"]);
      if (!kind) return invalid("kind は electricity か gas を指定してください");
      const contractKey = parseContractKey(args["contractKey"]);
      if (!contractKey) return invalid("contractKey は kurashio_utility_bill_contracts が返した契約キーを指定してください");
      const month = args["billingMonth"];
      const messageId = args["sourceMessageId"];
      if ((month === undefined) === (messageId === undefined)) {
        return invalid("billingMonth と sourceMessageId のどちらか一方だけを指定してください");
      }
      let lookup: { billingMonth: string } | { sourceMessageId: string };
      if (month !== undefined) {
        if (typeof month !== "string" || !BILLING_MONTH.test(month)) return invalid("billingMonth は YYYY-MM で指定してください");
        lookup = { billingMonth: month };
      } else {
        const id = parseMessageId(messageId);
        if (!id) return invalid("sourceMessageId が不正です");
        lookup = { sourceMessageId: id };
      }

      const config = await deps.readConfig();
      if (!config) return notConfigured("read");
      const fetched = await fetchBill(config, kind, contractKey, lookup, deps.fetchImpl);
      if (!fetched.ok) return failure(fetched);
      if (!fetched.found) return result({ status: "not_found", kind, contractKey, ...lookup });
      return result({ status: "found", record: fetched.record, source: fetched.source });
    },
  };
}

export function createKurashioImportBillTool(deps: KurashioBillsDeps = DEFAULT_DEPS): Tool {
  return {
    name: "kurashio_import_utility_bill",
    description:
      "電気・ガスの月次の確定請求を1件、kurashioへ登録する書き込みツール（関西電力の使用量のお知らせメール等を利用者が確認したもの）。" +
      "**既にある行は書き換えない。** 同じ内容なら duplicate（何もしない）、値が違えば conflict（既存値を返して止まる。訂正の経路は無い）。" +
      "新規なら登録後に読み戻して一致を確かめ、確かめられたときだけ created を返す（確かめられなければ unverified）。" +
      "contractKey は kurashio_utility_bill_contracts の候補から選び、決められなければ推測せず利用者へ確認する。" +
      "候補が無い初回・引越し直後の新契約は、候補に無いキー（default かハッシュ済みの12桁）を利用者に確認してもらったうえで confirmNewContract:true を付けたときだけ登録できる" +
      "（付けなければ contract_unresolved で止まる。既存候補に同じ請求月の行があれば contract_month_conflict で止まる）。" +
      "billingMonth はメールに書かれた「◯月分」で、受信日（receivedAt）とは別。受信日から請求月・検針日を推測しない。" +
      "金額が分からなければ insufficient_data で登録しない。unknown が返ったら再送せず、kurashio_get_utility_bill で sourceMessageId を指定して確かめる。" +
      "dryRun:true で登録せずに、送る内容と同じ月の既存の行を確かめられる。Zaim・Asset Managerへの支出登録ではない（asset_manager_import_payment とは別）。",
    requiredScopes: KURASHIO_BILLS_WRITE,
    inputSchema: {
      type: "object",
      properties: {
        billingMonth: { type: "string", description: "請求月（YYYY-MM）。メールの「◯月分」。受信日・検針日ではない" },
        kind: { type: "string", enum: [...BILL_KINDS], description: "electricity=電気 / gas=ガス" },
        contractKey: { type: "string", description: "kurashio_utility_bill_contracts が返した契約キー" },
        amountYen: { type: "integer", minimum: 0, description: "確定請求額（円）。不明なら省略する（insufficient_data になり登録されない）" },
        usageValue: { type: "number", minimum: 0, description: "使用量。不明なら省略" },
        usageUnit: { type: "string", description: "使用量の単位。電気は kWh、ガスは m3（m³・㎥も可）" },
        planName: { type: "string", description: `契約種別（例: なっトクでんき）。${MAX_LABEL}文字以内` },
        receivedAt: { type: "string", description: "メールの受信日時（タイムゾーン付きISO 8601）" },
        sourceMessageId: { type: "string", description: "元メール（Gmail）の messageId。照会・重複防止に使う" },
        sourceLabel: { type: "string", description: `出典の短い名前（例: はぴeみる電）。${MAX_LABEL}文字以内` },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "メールからの読み取りの確からしさ（0〜1）" },
        confirmNewContract: {
          type: "boolean",
          description:
            "候補に無い初回・新規の契約キーを、利用者が確認済みのときだけ true。推測では付けない。候補にあるキーには不要",
        },
        dryRun: { type: "boolean", description: "true なら登録せず、送る内容と同じ月の既存の行を返す" },
      },
      required: ["billingMonth", "kind", "contractKey", "sourceMessageId", "confidence"],
      additionalProperties: false,
    },
    async handler(args) {
      const parsed = parseImportArgs(args);
      if (!parsed.ok) return parsed.result;
      const payload = parsed.payload;
      const dryRun = args["dryRun"] === true;

      // 読み取り用は、契約キーの確認と登録後の読み戻しに使う。無いまま登録すると確かめようがない。
      const readConfig = await deps.readConfig();
      if (!readConfig) return notConfigured("read");

      const contracts = await fetchBillContracts(readConfig, payload.kind, deps.fetchImpl);
      if (!contracts.ok) return failure(contracts);
      let newContract = false;
      if (!contracts.contracts.some((c) => c.contractKey === payload.contract_key)) {
        const confirm = args["confirmNewContract"];
        if (confirm !== undefined && typeof confirm !== "boolean") return invalid("confirmNewContract は true か false で指定してください");
        if (confirm !== true) {
          return result(
            {
              status: "contract_unresolved",
              reason:
                "contractKey が kurashio の契約候補にありません。新しい契約は推測で作らず、利用者へ確認してください。" +
                "初回・新規の契約だと利用者が確認した場合だけ、confirmNewContract:true を付けて再度呼べます",
              candidates: contracts.contracts,
            },
            true,
          );
        }
        // 確認済みの新規契約でも、既存契約と同じ月・種別の行があるなら取り違えの疑いが強いので止める。
        for (const candidate of contracts.contracts) {
          const sameMonth = await fetchBill(readConfig, payload.kind, candidate.contractKey, { billingMonth: payload.billing_month }, deps.fetchImpl);
          if (!sameMonth.ok) return failure(sameMonth);
          if (sameMonth.found) {
            return result(
              {
                status: "contract_month_conflict",
                reason:
                  "既存の契約候補に同じ請求月の行があるため、新規契約としては登録しません。既存契約のメールではないか、利用者へ確認してください",
                existingContractKey: candidate.contractKey,
                billingMonth: payload.billing_month,
              },
              true,
            );
          }
        }
        newContract = true;
      }

      const writeConfig = await deps.writeConfig();
      if (dryRun) {
        const existing = await fetchBill(readConfig, payload.kind, payload.contract_key, { billingMonth: payload.billing_month }, deps.fetchImpl);
        if (!existing.ok) return failure(existing);
        return result({
          status: "dry_run",
          wouldSend: payload,
          newContract,
          existing: existing.found ? existing.record : null,
          writeConfigured: writeConfig !== null,
        });
      }
      if (!writeConfig) return notConfigured("write");

      const imported = await importBill(writeConfig, payload, deps.fetchImpl);
      if (!imported.ok) {
        return failure(imported, imported.kind === "unknown" ? { lookup: lookupHint(payload) } : {});
      }
      if (imported.status === "duplicate") {
        return result({ status: "duplicate", reason: "同じ内容が既に登録されています。何も変更していません", record: imported.record, source: imported.source });
      }
      if (imported.status === "conflict") {
        return result(
          {
            status: "conflict",
            reason: "既存の行と値が違うため登録しませんでした（上書きしていません）。どちらが正しいか利用者へ確認してください",
            fields: imported.fields ?? [],
            record: imported.record,
            source: imported.source,
          },
          true,
        );
      }

      // created: 正本を読み戻して主要項目の一致まで確かめる。確かめられなければ成功扱いにしない。
      const saved = await fetchBill(readConfig, payload.kind, payload.contract_key, { sourceMessageId: payload.source_message_id }, deps.fetchImpl);
      if (!saved.ok || !saved.found) {
        return result(
          {
            status: "unverified",
            reason: "登録の応答は返りましたが、読み戻して確かめられませんでした",
            lookup: lookupHint(payload),
          },
          true,
        );
      }
      const mismatched = verifyRecord(saved.record, payload, imported.record);
      if (mismatched.length > 0) {
        return result(
          { status: "unverified", reason: "読み戻した値が登録を求めた内容と一致しません", fields: mismatched, record: saved.record },
          true,
        );
      }
      return result({ status: "created", verified: true, newContract, record: saved.record, source: saved.source });
    },
  };
}

export const kurashioBillContractsTool = createKurashioBillContractsTool();
export const kurashioGetBillTool = createKurashioGetBillTool();
export const kurashioImportBillTool = createKurashioImportBillTool();
