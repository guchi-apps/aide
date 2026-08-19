import type { MyRoomSnapshot } from "./types.ts";

/**
 * myroom コネクタ。
 *
 * 部屋の温度・湿度・気圧・CO2・照度とエアコンの状態は
 * [myroom](https://github.com/guchi-apps/myroom) が既に集めている。**AIDEは集め直さず、
 * サーバー間参照用の読み取りAPI（`GET /api/internal/room-state`）を叩くだけにする。**
 *
 * センサーの鮮度判定（`SENSOR_STALE_MINUTES`）・気圧オフセットの適用・デバイスの表示名は
 * 向こうが持っている。こちらで再実装すれば必ずズレるため、**判定済みの値を受け取る**。
 * ops-dashboard・subscription-lists と同じ「既にある集約を横断ビューへ畳む」形。
 *
 * 両方とも同じVPS上で動くため localhost 経由で届き、相手を外部公開する必要がない。
 * `fetch` しか使わないので実行時依存も増えない。
 *
 * **キャッシュを挟まない。** README「取得と提供の分離」が分離を要求しているのは
 * Playwright巡回のような重い取得で、ここは localhost へのHTTP GETだけ。かつ部屋の状態は
 * 鮮度そのものが価値なので、ジョブ間隔ぶん古くなると「いま暑いか」に答えられなくなる。
 */

/** myroom は同じVPS上のPM2プロセス（uvicorn・ポート8000）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

/**
 * 1本あたりの制限時間。
 * MCPの同期リクエストの中で叩くため、相手が落ちていてもツールが固まらないよう短く切る。
 * localhost で数ミリ秒で返るものなので、3秒は十分な余裕にあたる。
 */
const TIMEOUT_MS = 3_000;

export interface MyRoomConfig {
  baseUrl: string;
  token: string;
}

/**
 * 設定を読む。トークンが無ければ null（＝401を叩きに行かない）。
 *
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readMyRoomConfig(): MyRoomConfig | null {
  const token = process.env["AIDE_MYROOM_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_MYROOM_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがあり、URLが出ると内部の構成が漏れる。
 * HTTPステータスと例外の種別だけに落とす。
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof Response) {
    // 401（キー不一致）と503（相手側が未設定）は原因が違うので、意味を添える。
    if (cause.status === 401) return "HTTP 401（トークンが一致しない）";
    if (cause.status === 404) return "HTTP 404（内部APIが未実装のバージョン）";
    if (cause.status === 503) return "HTTP 503（相手側でAPIキーが未設定）";
    return `HTTP ${cause.status}`;
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

/**
 * 部屋の状態を1回で取得する。整形は行わない（`src/core/views/room.ts` の仕事）。
 */
export async function fetchRoomState(config: MyRoomConfig): Promise<MyRoomSnapshot> {
  const res = await fetch(`${config.baseUrl}/api/internal/room-state`, {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
  if (!res.ok) throw res;
  return (await res.json()) as MyRoomSnapshot;
}
