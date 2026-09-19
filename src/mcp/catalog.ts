import { ToolRegistry } from "./registry.ts";
import { dailyBriefingTool } from "./tools/briefing.ts";
import { claudeSessionsTool } from "./tools/claude-sessions.ts";
import { createEventTool } from "./tools/create-event.ts";
import { devStatusTool } from "./tools/dev.ts";
import { createIssueTool } from "./tools/issue.ts";
import { moneySummaryTool } from "./tools/money.ts";
import {
  createNotificationTool,
  createTaskCandidateTool,
  saveDailyBriefTool,
} from "./tools/notifications.ts";
import { opsStatusTool } from "./tools/ops.ts";
import { pingTool } from "./tools/ping.ts";
import { roomButtonsTool, roomPressTool } from "./tools/room-control.ts";
import { roomStatusTool } from "./tools/room.ts";
import { scheduleTool } from "./tools/schedule.ts";
import { zaimMasterTool, zaimPaymentTool } from "./tools/zaim.ts";
import { assetManagerImportPaymentTool } from "./tools/asset-manager.ts";
import { researchDeskImportWeeklyReportTool } from "./tools/research-desk.ts";

/**
 * MCPに出すツールの登録簿を組み立てる。**ツールを足すときはここへ足す。**
 *
 * `src/server.ts` のモジュール直下で組み立てていたものを関数へ切り出した（#328）。
 * `server.ts` は読み込んだ時点で認証設定を読み `listen()` まで走るためテストから読み込めず、
 * アプリ連携の図（`src/web/map.ts`）に全ツールが載っているかを本物の登録簿で確かめられなかった。
 */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(pingTool);
  registry.register(moneySummaryTool);
  registry.register(opsStatusTool);
  registry.register(roomStatusTool);
  // 照明などの操作（#317）。**一覧と押すを分けている**（Zaimと同じ理由）。
  registry.register(roomButtonsTool);
  registry.register(roomPressTool);
  registry.register(dailyBriefingTool);
  registry.register(scheduleTool);
  // 予定の新規作成（#243）。読み取り（aide_schedule）と書き込みを分けている（Zaimと同じ理由）。
  registry.register(createEventTool);
  registry.register(devStatusTool);
  registry.register(createIssueTool);
  registry.register(claudeSessionsTool);
  // Zaimへの支出登録（#135）。**読み取り（候補の一覧）と書き込み（登録）を分けている。**
  // 1本に畳むと、Claude Code側で「常に許可」にしたときに書き込みまで素通しになる。
  registry.register(zaimMasterTool);
  registry.register(zaimPaymentTool);
  registry.register(assetManagerImportPaymentTool);
  registry.register(researchDeskImportWeeklyReportTool);
  registry.register(createNotificationTool);
  registry.register(createTaskCandidateTool);
  registry.register(saveDailyBriefTool);
  return registry;
}
