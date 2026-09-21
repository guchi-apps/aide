/**
 * AIDEのブランド表示（横長ワードマーク「AIde」）。
 *
 * 画面左上・アプリ連携の図の中央・ログイン画面は**すべてここの1つのデータ**から描く。別の
 * デザインを増やさないための置き場で、絵を直すときはここだけを直す。アイコン
 * （`src/web/icons/icon.svg`）は同じ「A＋開いたコンパスリング＋針」の字形を使い、パスの
 * 文字列が食い違っていないことを `brand.test.ts` が確かめる。
 *
 * 表記は `AIde`。`AI`（人工知能）と英語の `aide`（補佐役）のダブルミーニングで、
 * コンパスは「案内する」役割を表す。ロボットは含めない（ロボットの絵柄が変わっても
 * ブランドが動かないようにするため）。
 *
 * 字形はすべて手で描いたパスにしていて、書体には頼らない。**ウェブフォントを読み込まない**
 * 方針（`layout.ts`）と、端末ごとの字形の差でロゴが変わらないようにするため。
 * 色はCSS変数で持つので、ダークモードでも同じ要素が切り替わる（`BRAND_STYLE`）。
 */

/** ワードマークの座標系。 */
export const LOGO_WIDTH = 1105;
export const LOGO_HEIGHT = 457;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * `A` の字形。頂点は丸めた平らな面で、左の脚は斜めに、右の脚は縦に切る。
 * 上半分は塗りつぶしで、ここへ針を白く抜いて「Aの内側に針がある」形にしている。
 */
export const MARK_A_PATH =
  "M225 108 Q232 98 245 98 L283 98 Q296 98 302 108 L398 362 L398 443 L345 443 " +
  "L302 337 L165 337 L107 433 L60 380 Z";

/** 針を置く中心（`A` の中の空き）。針はここを軸にした北東向きの菱形で、先端が脚の際まで届く。 */
export const MARK_NEEDLE_PATH = "M305 190 L259 291 L160 338 L205 237 Z";
export const MARK_PIVOT = { cx: 232, cy: 264, r: 20 } as const;

/**
 * `A` を囲む開いたコンパスリング。**塗りの図形として計算で作る。**
 * 左下の端は左の脚の外縁と平行に、`RING_GAP` だけ間をあけて切る（線の端を丸めたり重ねたり
 * すると、脚とリングがつながって「ひとつの字形」に見えなくなる）。右上の端は放射状に切る。
 */
const RING = { cx: 255, cy: 255, radius: 217, width: 54, gap: 16, endAngle: 313 } as const;

function ringPath(): string {
  const outer = RING.radius + RING.width / 2;
  const inner = RING.radius - RING.width / 2;
  // 左の脚の外縁（頂点の左肩 → 左足の外側の角）。方向ベクトルと、外向き（左上）の法線。
  const [x0, y0, x1, y1] = [225, 108, 60, 380];
  const length = Math.hypot(x1 - x0, y1 - y0);
  const ux = (x1 - x0) / length;
  const uy = (y1 - y0) / length;
  const px = x0 - RING.gap * uy;
  const py = y0 + RING.gap * ux;
  // その平行線と、リングの外縁・内縁の円との交点（下側のもの）。
  const cut = (radius: number): [number, number] => {
    const dx = px - RING.cx;
    const dy = py - RING.cy;
    const b = dx * ux + dy * uy;
    const t = -b + Math.sqrt(b * b - (dx * dx + dy * dy - radius * radius));
    return [round1(px + t * ux), round1(py + t * uy)];
  };
  const point = (radius: number): [number, number] => {
    const angle = (RING.endAngle * Math.PI) / 180;
    return [round1(RING.cx + radius * Math.cos(angle)), round1(RING.cy + radius * Math.sin(angle))];
  };
  const [ox, oy] = cut(outer);
  const [ix, iy] = cut(inner);
  const [ex, ey] = point(outer);
  const [fx, fy] = point(inner);
  return `M${ex} ${ey} A${outer} ${outer} 0 0 0 ${ox} ${oy} L${ix} ${iy} A${inner} ${inner} 0 0 1 ${fx} ${fy} Z`;
}

export const MARK_RING_PATH = ringPath();

/** `I`（縦棒）。 */
const LETTER_I = { x: 418, y: 100, width: 80, height: 345, radius: 28 } as const;

/** `d`：輪と縦棒。 */
const LETTER_D_BOWL = { cx: 651, cy: 311, r: 102, width: 67 } as const;
const LETTER_D_STEM = { x: 723, y: 77, width: 74, height: 368, radius: 30 } as const;

/** `e`：輪と横棒。輪は右下が開いていて、端は丸める。 */
const LETTER_E = { cx: 955, cy: 312, r: 102, width: 67, barWidth: 48, openAngle: 40 } as const;

/** 見た目を決めるCSS（ロゴの色・向き）。`layout.ts` の共通CSSへ差し込む。 */
export const BRAND_STYLE = `
:root{--logo-ai:#0b5075;--logo-de:#3aa8e6;--logo-needle:#fff}
@media (prefers-color-scheme:dark){:root{--logo-ai:#dcecf5;--logo-de:#5cc4f7;--logo-needle:#141d24}}
.logo{display:block}
.logo .ai{fill:var(--logo-ai)}
.logo .de{fill:var(--logo-de)}
.logo .needle{fill:var(--logo-needle)}
.logo .de-line{fill:none;stroke:var(--logo-de)}
`;

/**
 * ワードマークのSVG。`attrs` はそのまま `<svg>` の属性になる（大きさや、図の中へ置くときの
 * `x`・`y`）。**`AIde` の読み上げ用に `role="img"` と `aria-label` を付ける。**
 * IDを持たないので、同じページへ何度置いても衝突しない。
 */
export function logoSvg(attrs = ""): string {
  const i = LETTER_I;
  const bowl = LETTER_D_BOWL;
  const stem = LETTER_D_STEM;
  const e = LETTER_E;
  const open = (e.openAngle * Math.PI) / 180;
  const end = { x: round1(e.cx + e.r * Math.cos(open)), y: round1(e.cy + e.r * Math.sin(open)) };
  return (
    `<svg class="logo" ${attrs} viewBox="0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}" role="img" aria-label="AIde" focusable="false">` +
    `<path class="ai" d="${MARK_RING_PATH}"/>` +
    `<path class="ai" d="${MARK_A_PATH}"/>` +
    `<path class="needle" d="${MARK_NEEDLE_PATH}"/>` +
    `<circle class="ai" cx="${MARK_PIVOT.cx}" cy="${MARK_PIVOT.cy}" r="${MARK_PIVOT.r}"/>` +
    `<rect class="ai" x="${i.x}" y="${i.y}" width="${i.width}" height="${i.height}" rx="${i.radius}"/>` +
    `<circle class="de-line" cx="${bowl.cx}" cy="${bowl.cy}" r="${bowl.r}" stroke-width="${bowl.width}"/>` +
    `<rect class="de" x="${stem.x}" y="${stem.y}" width="${stem.width}" height="${stem.height}" rx="${stem.radius}"/>` +
    `<path class="de-line" d="M${e.cx - e.r - 10} ${e.cy} H${e.cx + e.r + 32}" stroke-width="${e.barWidth}"/>` +
    `<path class="de-line" d="M${e.cx + e.r} ${e.cy} A${e.r} ${e.r} 0 1 0 ${end.x} ${end.y}" stroke-width="${e.width}"/>` +
    `<circle class="de" cx="${end.x}" cy="${end.y}" r="${e.width / 2}"/>` +
    `</svg>`
  );
}

/** 高さに対する幅。縦横比を崩さないため、大きさは必ずこれで両方を決める。 */
export function logoWidth(height: number): number {
  return Math.round((height * LOGO_WIDTH) / LOGO_HEIGHT);
}

/** `<svg>` の `width` と `height` の属性。 */
export function logoSize(height: number): string {
  return `width="${logoWidth(height)}" height="${height}"`;
}
