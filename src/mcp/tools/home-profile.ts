import { homeProfileStore, DEFAULT_LABEL, type HomeProfile, type HomeProfileStore } from "../../core/home-profile/store.ts";
import { buildSchedule, type ScheduleSummary } from "../../core/views/schedule.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 自宅プロフィールの読み取り（#911）。
 *
 * **登録された値だけを返す。** 未設定でも現在地の逆引きや過去の移動から推測しない。
 * 座標と正確な住所は `location:read` もある接続にだけ返す。
 */

export const HOME_READ = ["home:read"] as const;

/** 移動の出発地と照合する日数（今日を含む）。 */
const CHECK_DAYS = 7;

export type ScheduleReader = (options: { days: number }) => Promise<ScheduleSummary>;

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** 登録の不足。空なら `complete`。 */
export function missingFields(profile: HomeProfile): string[] {
  const missing: string[] = [];
  if (!profile.area.prefecture || !profile.area.city) missing.push("エリア（都道府県と市区町村）が未登録です");
  if (profile.accessRoutes.length === 0) missing.push("自宅からの区間（accessRoutes）が1件もありません");
  if (profile.departurePreferences.defaultBufferMinutes === null) {
    missing.push("出発の余裕時間（defaultBufferMinutes）が未登録です");
  }
  return missing;
}

/** 表記の揺れを見つけるためだけの正規化。**区間を引くときの一致には使わない**（完全一致のみ）。 */
function loose(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/駅$/, "");
}

/**
 * 各日の最初の移動の出発地から、自宅発の区間が引けるかを確かめる。**純粋関数。**
 * 2件目以降の移動は前の移動の続きなので見ない。
 */
export function routeProblems(profile: HomeProfile, schedule: ScheduleSummary): string[] {
  const problems: string[] = [];
  const home = new Set([DEFAULT_LABEL, profile.label, profile.exactAddress]);

  for (const day of schedule.days) {
    const first = [...day.travels].sort((a, b) => (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99"))[0];
    if (!first) continue;
    const { origin } = first;
    if (!origin) {
      problems.push(`${day.date} の最初の移動に出発地（origin）が無く、区間を引けません`);
      continue;
    }
    if (home.has(origin) || profile.accessRoutes.some((route) => route.to === origin)) continue;

    const near = profile.accessRoutes.find((route) => loose(route.to) === loose(origin));
    problems.push(
      near
        ? `${day.date} の最初の移動の出発地「${origin}」は、登録区間の「${near.to}」と表記が違うため区間を引けません（完全一致が必要）`
        : `${day.date} の最初の移動の出発地「${origin}」に一致する accessRoutes[].to が無く、自宅からの区間を引けません`,
    );
  }
  return problems;
}

async function checkTravels(profile: HomeProfile, readSchedule: ScheduleReader): Promise<string[]> {
  const unchecked = ["移動を取得できなかったため、出発地と区間の照合はしていません（一致しているという意味ではありません）"];
  try {
    const schedule = await readSchedule({ days: CHECK_DAYS });
    if (!schedule.configured || schedule.days.length === 0) return unchecked;
    return routeProblems(profile, schedule);
  } catch {
    return unchecked;
  }
}

export function createHomeProfileTool(
  store: () => HomeProfileStore = homeProfileStore,
  clock: () => Date = () => new Date(),
  readSchedule: ScheduleReader = buildSchedule,
): Tool {
  return {
    name: "aide_home_profile",
    description:
      "利用者が設定画面で登録した自宅プロフィール（エリア・自宅から駅などへの区間と所要時間・出発の余裕時間）を読む読み取りツール。" +
      "「何時に家を出ればいい」「最寄り駅は」のように自宅を起点にする問いでは、現在地から推測せず必ずこれを呼ぶ。" +
      "configured が false は**未設定**で「自宅が無い」ではない。そのときは aide_current_location の座標や過去の移動から" +
      "自宅のエリア・住所を推測せず、設定画面（/settings/home）で登録してもらうよう伝える。" +
      "accessRoutes[].to は移動の origin と完全一致で引く（priority は小さいほど優先）。" +
      "complete が false のとき、または problems があるときは、その内容を伝えて不足分を推測で埋めない。" +
      `problems には今後${CHECK_DAYS}日の各日の最初の移動で区間が引けないものも含む。` +
      "exactAddress と coordinates は location:read もある接続にだけ返す（省かれていても未登録とは限らない）。" +
      "住所と座標は、通知・日次ブリーフ・Issueなどへ書き写さない。",
    requiredScopes: HOME_READ,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const checkedAt = clock().toISOString();
      let profile: HomeProfile | null;
      try {
        profile = await store().read();
      } catch {
        // 失敗を「未設定」と取り違えないようエラーで返す。内容（住所・座標）は含めない。
        return result({ ok: false, kind: "read_failed", reason: "保存済みの自宅プロフィールを読めませんでした（未設定ではなく取得失敗）" }, true);
      }
      if (!profile) {
        return result({
          checkedAt,
          configured: false,
          complete: false,
          problems: ["自宅プロフィールが未設定です。設定画面（/settings/home）で登録してください"],
          profile: null,
          updatedAt: null,
          note: "未設定であって「自宅が無い」という意味ではありません。エリアや住所を推測しないでください。",
        });
      }

      const precise = ctx.scopes?.includes("location:read") === true;
      const { exactAddress, coordinates, updatedAt, ...coarse } = profile;
      const missing = missingFields(profile);
      return result({
        checkedAt,
        configured: true,
        complete: missing.length === 0,
        problems: [...missing, ...(await checkTravels(profile, readSchedule))],
        profile: precise ? { ...coarse, exactAddress, coordinates } : coarse,
        updatedAt,
        note: precise
          ? "住所と座標は、通知・日次ブリーフ・Issueなどへ書き写さないでください。"
          : "この接続に location:read が無いため、exactAddress と coordinates は省いています（未登録とは限りません）。",
      });
    },
  };
}

export const homeProfileTool = createHomeProfileTool();
