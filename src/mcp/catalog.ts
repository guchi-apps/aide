import { ToolRegistry } from "./registry.ts";
import { airconControlTool } from "./tools/aircon-control.ts";
import { claudeSessionsTool } from "./tools/claude-sessions.ts";
import { createEventTool } from "./tools/create-event.ts";
import { devStatusTool, repoLabelsTool, repoStatusTool } from "./tools/dev.ts";
import { garbageCollectionTool } from "./tools/garbage.ts";
import { issueDeckUploadImageTool } from "./tools/issue-deck.ts";
import { createIssueTool } from "./tools/issue.ts";
import { balancesTool, fixedCostsTool } from "./tools/money.ts";
import {
  createNotificationTool,
  createTaskCandidateTool,
  saveDailyBriefTool,
} from "./tools/notifications.ts";
import { hostStatusTool, serviceQuotasTool, uptimeMonitorsTool } from "./tools/ops.ts";
import { pingTool } from "./tools/ping.ts";
import { printerStatusTool } from "./tools/printer.ts";
import { roomButtonsTool, roomPressTool } from "./tools/room-control.ts";
import { airconStatusTool, roomSensorsTool } from "./tools/room.ts";
import { scheduleTool } from "./tools/schedule.ts";
import { utilityBillsTool } from "./tools/utility-bills.ts";
import { weatherTool } from "./tools/weather.ts";
import { zaimMasterTool, zaimPaymentTool } from "./tools/zaim.ts";
import {
  assetManagerAddSubscriptionPriceTool,
  assetManagerCreateSubscriptionTool,
  assetManagerImportPaymentTool,
  assetManagerSubscriptionsTool,
} from "./tools/asset-manager.ts";
import { researchDeskImportWeeklyReportTool } from "./tools/research-desk.ts";

/**
 * MCPに出すツールの登録簿を組み立てる。**ツールを足すときはここへ足す。**
 *
 * `src/server.ts` のモジュール直下で組み立てていたものを関数へ切り出した（#328）。
 * `server.ts` は読み込んだ時点で認証設定を読み `listen()` まで走るためテストから読み込めず、
 * アプリ連携の図（`src/web/map.ts`）に全ツールが載っているかを本物の登録簿で確かめられなかった。
 *
 * **ツールは「1つの問い」ごとに立てる**（#373）。1本に複数の問いを畳むと、片方だけ
 * 尋ねられたときにも全部が返り、応答がその問いに対して大きすぎる。読み取りと書き込みは
 * 必ず別のツールにする（クライアント側で「常に許可」にしたときに書き込みまで素通しになる）。
 */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(pingTool);
  // お金は「いま持っている額」（ストック）と「毎月出ていく額」（フロー）で分ける（#373）。
  registry.register(balancesTool);
  registry.register(fixedCostsTool);
  // 電気代・ガス代（#324）。種類と期間を取るため固定費・残高へは畳まない。
  registry.register(utilityBillsTool);
  // 運用は区画ごとに分ける（#373）。ホスト指標・外形監視・残枠は別々の問い。
  registry.register(hostStatusTool);
  registry.register(uptimeMonitorsTool);
  registry.register(serviceQuotasTool);
  // 部屋も測定値とエアコンで問いが違う（#373）。
  registry.register(roomSensorsTool);
  registry.register(airconStatusTool);
  // 3Dプリンター（#378）。部屋の測定値とは問いが違う。進捗・完了・エラー・温度は同じ1台の同じ時点の値なので1本。
  registry.register(printerStatusTool);
  // 照明などの操作（#317）。**一覧と押すを分けている**（Zaimと同じ理由）。
  registry.register(roomButtonsTool);
  registry.register(roomPressTool);
  // エアコンの操作（#316）。読み取り（aide_aircon_status）と分けている（照明・Zaimと同じ理由）。
  registry.register(airconControlTool);
  registry.register(weatherTool);
  registry.register(scheduleTool);
  registry.register(garbageCollectionTool);
  // 予定の新規作成（#243）。読み取り（aide_schedule）と書き込みを分けている（Zaimと同じ理由）。
  registry.register(createEventTool);
  // 開発状況は俯瞰・1リポジトリの詳細・起票用ラベルで分ける（#373）。
  registry.register(devStatusTool);
  registry.register(repoStatusTool);
  registry.register(repoLabelsTool);
  registry.register(createIssueTool);
  // IssueDeckへの画像アップロード（#449）。起票（aide_create_issue）とは別ツールにしている。
  registry.register(issueDeckUploadImageTool);
  registry.register(claudeSessionsTool);
  // Zaimへの支出登録（#135）。**読み取り（候補の一覧）と書き込み（登録）を分けている。**
  // 1本に畳むと、Claude Code側で「常に許可」にしたときに書き込みまで素通しになる。
  registry.register(zaimMasterTool);
  registry.register(zaimPaymentTool);
  registry.register(assetManagerImportPaymentTool);
  // サブスクの読み取りと書き込みは、クライアント側の承認を分けるため別ツールにする（#345, #346）。
  registry.register(assetManagerSubscriptionsTool);
  registry.register(assetManagerCreateSubscriptionTool);
  registry.register(assetManagerAddSubscriptionPriceTool);
  registry.register(researchDeskImportWeeklyReportTool);
  registry.register(createNotificationTool);
  registry.register(createTaskCandidateTool);
  registry.register(saveDailyBriefTool);
  return registry;
}
