import type { IncomingMessage, ServerResponse } from "node:http";
import { TRAVEL_MODES, type TravelMode } from "../core/connectors/dayspan/travels.ts";
import {
  homeProfileStore,
  validateHomeProfile,
  DEFAULT_LABEL,
  MAX_ACCESS_ROUTES,
  type HomeProfile,
  type HomeProfileStore,
} from "../core/home-profile/store.ts";
import { card, escapeHtml, renderPage, siteNav } from "./layout.ts";
import { accountAction, currentSession, handleGatedPage, type LoginOptions } from "./login.ts";

/**
 * 自宅プロフィールの設定画面（`/settings/home`。#911）。**正本を書き換える唯一の口。**
 *
 * - ログインの内側。POSTは同じオリジンから送られたものだけ受ける
 * - 入力欄の初期値は保存済みの値だけで、現在地などから候補を作らない
 * - 住所・座標はログに出さない
 */

export const HOME_SETTINGS_PATH = "/settings/home";

const MAX_FORM_BYTES = 64 * 1024;
/** 登録済みの区間の下に足す空欄の数。続けて足すときは一度保存する。 */
const BLANK_ROUTES = 3;

const MODE_LABELS: Record<TravelMode, string> = {
  CAR: "車",
  PUBLIC_TRANSIT: "公共交通機関",
  WALK: "徒歩",
  OTHER: "その他",
};

const ROUTE_FIELDS = ["to", "mode", "typical", "buffer", "priority"] as const;
const PREFERENCES = [
  ["defaultBufferMinutes", "出発の余裕時間（分）"],
  ["stationArrivalBufferMinutes", "駅に着く余裕時間（分）"],
  ["rainExtraMinutes", "雨の日の追加時間（分）"],
] as const;

/** 保存済みの値をフォームの値へ。画面はフォームの値だけから描き、入力エラー時もそのまま出し直す。 */
export function profileToForm(profile: HomeProfile | null): URLSearchParams {
  const form = new URLSearchParams({ version: String(profile?.version ?? 0), label: profile?.label ?? DEFAULT_LABEL });
  if (!profile) return form;
  const set = (name: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined) form.set(name, String(value));
  };
  for (const [name, value] of Object.entries(profile.area)) set(name, value);
  set("exactAddress", profile.exactAddress);
  set("latitude", profile.coordinates?.latitude);
  set("longitude", profile.coordinates?.longitude);
  profile.accessRoutes.forEach((route, i) => {
    set(`route_${i}_to`, route.to);
    set(`route_${i}_mode`, route.mode);
    set(`route_${i}_typical`, route.typicalMinutes);
    set(`route_${i}_buffer`, route.bufferMinutes);
    set(`route_${i}_priority`, route.priority);
  });
  for (const [name] of PREFERENCES) set(name, profile.departurePreferences[name]);
  return form;
}

/** フォームの値を検査前の形へ。数値として読めない入力は NaN にして検査で落とす。 */
export function formToInput(form: URLSearchParams): Record<string, unknown> {
  const text = (name: string) => form.get(name)?.trim() || null;
  const number = (name: string) => {
    const value = text(name)?.normalize("NFKC");
    return value === undefined ? null : Number(value);
  };

  const accessRoutes = [];
  for (let i = 0; i < MAX_ACCESS_ROUTES; i++) {
    // 行き先と所要時間がどちらも空の行は「無い」（手段や優先順が残っていても削除扱い）。
    if (text(`route_${i}_to`) === null && text(`route_${i}_typical`) === null) continue;
    accessRoutes.push({
      to: text(`route_${i}_to`),
      mode: text(`route_${i}_mode`),
      typicalMinutes: number(`route_${i}_typical`),
      bufferMinutes: number(`route_${i}_buffer`),
      priority: number(`route_${i}_priority`),
    });
  }

  const latitude = number("latitude");
  const longitude = number("longitude");
  return {
    label: text("label"),
    area: {
      prefecture: text("prefecture"),
      city: text("city"),
      town: text("town"),
      postalCode: text("postalCode"),
    },
    exactAddress: text("exactAddress"),
    coordinates: latitude === null && longitude === null ? null : { latitude, longitude },
    accessRoutes,
    departurePreferences: Object.fromEntries(PREFERENCES.map(([name]) => [name, number(name)])),
  };
}

function field(form: URLSearchParams, name: string, label: string, mode: "text" | "numeric" | "decimal" = "text"): string {
  return `<label>${escapeHtml(label)}<input type="text" inputmode="${mode}" name="${name}" value="${escapeHtml(form.get(name) ?? "")}" autocomplete="off"></label>`;
}

function routeRow(form: URLSearchParams, i: number): string {
  const selected = form.get(`route_${i}_mode`) ?? "";
  const options = [["", "選んでください"], ...TRAVEL_MODES.map((mode) => [mode, MODE_LABELS[mode]])]
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
  return `<fieldset class="route"><legend>区間${i + 1}</legend>
${field(form, `route_${i}_to`, "行き先（移動の出発地と同じ表記）")}
<label>移動手段<select name="route_${i}_mode">${options}</select></label>
${field(form, `route_${i}_typical`, "所要時間（分）", "numeric")}
${field(form, `route_${i}_buffer`, "余裕時間（分・任意）", "numeric")}
${field(form, `route_${i}_priority`, "優先順（任意・1が最優先）", "numeric")}
</fieldset>`;
}

export interface HomeSettingsView {
  form: URLSearchParams;
  headerAction?: string;
  updatedAt?: string | null;
  saved?: boolean;
  errors?: string[];
  /** 保存ファイルを読めないとき。上書きしないようフォームを出さない。 */
  unreadable?: boolean;
}

export function renderHomeSettingsPage(view: HomeSettingsView): string {
  const { form } = view;
  const notices = [
    view.saved ? `<p class="saved" role="status">保存しました。</p>` : "",
    ...(view.errors ?? []).map((error) => `<p class="notice" role="alert">${escapeHtml(error)}</p>`),
  ].join("");
  const updated = view.updatedAt
    ? `最終更新 ${new Date(view.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
    : "未設定";
  const hero = `<div class="hero"><div class="hero-top"><h1>自宅プロフィール</h1><span class="sub">${escapeHtml(updated)}</span></div>
<p class="lead">AIが出発時刻を計算するときに使う、自宅の登録情報です。すべて任意で、全部を空にして保存すると未設定に戻ります。</p></div>`;

  let count = 0;
  for (let i = 0; i < MAX_ACCESS_ROUTES; i++) {
    if (ROUTE_FIELDS.some((name) => form.get(`route_${i}_${name}`))) count = i + 1;
  }
  const rows = Array.from({ length: Math.min(count + BLANK_ROUTES, MAX_ACCESS_ROUTES) }, (_, i) => routeRow(form, i)).join("");

  const body = view.unreadable
    ? `${hero}${notices}`
    : `${hero}${notices}<form class="settings" method="post" action="${HOME_SETTINGS_PATH}">
<input type="hidden" name="version" value="${escapeHtml(form.get("version") ?? "0")}">
${card({ title: "エリア", body: `<div class="fields">${field(form, "label", "呼び名")}${field(form, "postalCode", "郵便番号", "numeric")}${field(form, "prefecture", "都道府県")}${field(form, "city", "市区町村")}${field(form, "town", "町域")}</div>` })}
${card({ title: "自宅からの区間", body: `<p class="sub">行き先は、予定の移動の出発地と1文字も違わないように入力してください（例: 「◯◯駅」と「◯◯」は別になります）。行き先と所要時間を消すと、その区間は削除されます。</p>${rows}` })}
${card({ title: "出発の余裕", body: `<div class="fields">${PREFERENCES.map(([name, label]) => field(form, name, label, "numeric")).join("")}</div>` })}
${card({ title: "正確な住所と座標（任意）", body: `<p class="sub">location:read を許可した接続にだけ返ります。出発時刻の計算には通常使いません。</p><div class="fields">${field(form, "exactAddress", "正確な住所")}${field(form, "latitude", "緯度", "decimal")}${field(form, "longitude", "経度", "decimal")}</div>` })}
<button type="submit" class="sync primary">保存する</button>
</form>`;

  return renderPage({
    title: "自宅 - AIDE",
    nav: siteNav("home"),
    headerAction: view.headerAction ?? "",
    body,
  });
}

export interface HomeSettingsDeps {
  store?: () => HomeProfileStore;
  currentSession?: typeof currentSession;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(body);
}

const UNREADABLE = "保存済みの自宅プロフィールを読めません。上書きを避けるため、入力欄は表示しません。";

export async function handleHomeSettingsPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: HomeSettingsDeps = {},
): Promise<void> {
  const saved = new URL(req.url ?? "/", "http://localhost").searchParams.get("saved") === "1";
  await handleGatedPage(req, res, options, HOME_SETTINGS_PATH, async (session) => {
    const headerAction = accountAction(session, options.authConfig.enabled);
    try {
      const profile = await (deps.store ?? homeProfileStore)().read();
      return renderHomeSettingsPage({ form: profileToForm(profile), updatedAt: profile?.updatedAt ?? null, saved, headerAction });
    } catch {
      return renderHomeSettingsPage({ form: profileToForm(null), errors: [UNREADABLE], unreadable: true, headerAction });
    }
  });
}

/**
 * 同じオリジンの画面から送られたPOSTか。CookieはSameSite=Laxだが、同じサイトの別サブドメインからの
 * 送信には付くため、オリジンまで確かめる。
 */
export function isSameOriginPost(req: IncomingMessage, baseUrl: string): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  const origin = req.headers.origin;
  if (!origin || !URL.canParse(origin)) return false;
  return new URL(origin).host === new URL(baseUrl).host;
}

export async function handleHomeSettingsSave(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: HomeSettingsDeps = {},
): Promise<void> {
  const session = await (deps.currentSession ?? currentSession)(req, options);
  if (!session) {
    req.resume();
    res.writeHead(303, { Location: HOME_SETTINGS_PATH, "Cache-Control": "no-store" }).end();
    return;
  }
  if (!isSameOriginPost(req, options.baseUrl)) {
    req.resume();
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden\n");
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) {
      res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" }).end("too large\n");
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const headerAction = accountAction(session, options.authConfig.enabled);
  const again = (status: number, errors: string[]) =>
    html(res, status, renderHomeSettingsPage({ form, errors, headerAction }));

  const validated = validateHomeProfile(formToInput(form));
  if (!validated.ok) return again(400, validated.errors);

  try {
    const outcome = await (deps.store ?? homeProfileStore)().save(validated.input, Number(form.get("version")));
    if (!outcome.ok) {
      return again(409, ["別の画面で先に更新されたため、保存していません。この画面を開き直してから入力してください。"]);
    }
    console.log(`[home-profile] 保存しました（${outcome.profile ? `version ${outcome.profile.version}` : "未設定に戻した"}）`);
  } catch (cause) {
    console.warn(`[home-profile] 保存に失敗しました: ${(cause as NodeJS.ErrnoException).code ?? "unknown"}`);
    return again(500, ["保存できませんでした。時間をおいてもう一度お試しください。"]);
  }
  res.writeHead(303, { Location: `${HOME_SETTINGS_PATH}?saved=1`, "Cache-Control": "no-store" }).end();
}
