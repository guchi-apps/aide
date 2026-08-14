import { keepZaimSessionAlive } from "../../core/connectors/zaim/session.ts";

/**
 * Zaimのセッションを延長するだけのジョブ。
 * Cookieの有効期間（約2時間）より短い間隔で回す。巡回は行わない。
 */
export async function runZaimKeepAlive(): Promise<string> {
  await keepZaimSessionAlive();
  return "Zaimのセッションを延長した";
}
