import sharp from 'sharp';
import { CANVAS, type Rect, type Targets } from './blueRidge.js';

/**
 * Sample #3, stage 2 — turn a clean render into a bad scan.
 *
 * THE DESIGN RULE HERE: degradation is targeted, not uniform.
 *
 * A uniformly mushy page produces a uniformly useless extraction, which
 * demonstrates nothing except that blurry documents are blurry. What we want
 * is a document where MOST fields are recoverable and THREE specific values
 * are genuinely ambiguous — so the flags land precisely, and the reviewer can
 * see the system drawing a line between what it knows and what it doesn't.
 *
 * Target: roughly 60-70% of fields recovered, with all three planted values
 * either null or flagged. Calibrate by tuning the constants in this file —
 * NEVER by tuning the extraction prompt. Tuning a prompt to pass a test you
 * wrote yourself is the exact self-deception this whole project is about
 * avoiding.
 */

/** Every knob in one place, so calibration is editing numbers, not logic. */
export const DEGRADE = {
  /** Skew, as if hand-fed into a sheet scanner. */
  rotationDeg: -2.4,
  /** Global softness. */
  blurSigma: 1.35,
  /** Gaussian grain. Dominant effect once contrast is crushed. */
  noiseSigma: 30,
  /**
   * Faded photocopy. Gain 0.52 / offset 72 maps black to ~#48 and white to
   * ~#dc, so the whole page lives in a ~145-level band instead of 255. After
   * JPEG this is what makes thin strokes merge.
   */
  contrastGain: 0.52,
  contrastOffset: 72,
  /**
   * Resample down to this fraction and back. THE most important knob: it is
   * the only step that destroys information irreversibly, and it is what
   * decides whether 8pt body text stays readable.
   *
   * Calibration notes (17px body text on a 1240px-wide canvas):
   *   0.73 — everything readable, useless as a test
   *   0.55 — body text marginal, headings fine   <- we want this
   *   0.42 — body text gone, so is the whole document
   */
  resampleFactor: 0.55,
  /** Ringing artifacts around every glyph edge. */
  jpegQuality: 20,
  /**
   * Extra local blur on the two planted text regions.
   *
   * Calibrated DOWN from 3.4/2.8: at those values both fields were erased
   * rather than ambiguous, and an erased field is the easy case — the model
   * reports it as illegible and everyone agrees. The interesting case is a
   * field the model can ALMOST read, because that is where it is tempted to
   * guess. We want the three extraction passes to disagree, not to agree on
   * "unreadable".
   */
  localBlurUnitPrice: 2.6,
  localBlurDate: 2.0,
  /** Ink bleed under the coffee ring. Lower than the others: the total is
   *  large and bold, and the stain does most of the work here. */
  localBlurGrandTotal: 2.2,
  /** How dark the uneven-lamp band gets at its centre. */
  bandColor: '#9d9d94',
} as const;

const clampRect = (r: Rect): Rect => {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  return {
    x,
    y,
    w: Math.min(Math.round(r.w), CANVAS.width - x),
    h: Math.min(Math.round(r.h), CANVAS.height - y),
  };
};

/** Blur one rectangle in place, leaving the rest of the page untouched. */
const blurRegion = async (base: Buffer, rect: Rect, sigma: number): Promise<Buffer> => {
  const r = clampRect(rect);
  const patch = await sharp(base)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .blur(sigma)
    .toBuffer();
  return sharp(base).composite([{ input: patch, left: r.x, top: r.y }]).toBuffer();
};

/**
 * A coffee ring: darker at the rim than the centre, because that is how a
 * drying droplet deposits. Multiplied over the page so the digits underneath
 * survive as ghosts rather than being painted out — the goal is "genuinely
 * hard to read", not "erased", which would be a different and easier problem.
 */
const coffeeRing = (cx: number, cy: number, radius: number): Buffer => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">
    <defs>
      <radialGradient id="ring" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stop-color="#8f6a44" stop-opacity="0.62"/>
        <stop offset="45%"  stop-color="#875f38" stop-opacity="0.68"/>
        <stop offset="68%"  stop-color="#7c5228" stop-opacity="0.66"/>
        <stop offset="84%"  stop-color="#63401b" stop-opacity="0.78"/>
        <stop offset="94%"  stop-color="#573a17" stop-opacity="0.62"/>
        <stop offset="100%" stop-color="#7a5730" stop-opacity="0.06"/>
      </radialGradient>
      <radialGradient id="splash" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stop-color="#8a6135" stop-opacity="0.10"/>
        <stop offset="70%"  stop-color="#7a5228" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="#6d4820" stop-opacity="0.44"/>
      </radialGradient>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${radius * 0.66}" fill="url(#ring)"/>
    <ellipse cx="${cx + radius * 0.72}" cy="${cy + radius * 0.42}"
             rx="${radius * 0.38}" ry="${radius * 0.28}" fill="url(#splash)"/>
    <ellipse cx="${cx - radius * 0.58}" cy="${cy - radius * 0.34}"
             rx="${radius * 0.22}" ry="${radius * 0.17}" fill="url(#splash)"/>
  </svg>`;
  return Buffer.from(svg);
};

/** Uneven scan lamp: a horizontal band of darkness across the page. */
const lampGradient = (bandY: number): Buffer => {
  const centre = Math.round((bandY / CANVAS.height) * 100);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">
    <defs>
      <linearGradient id="lamp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"                     stop-color="#ffffff"/>
        <stop offset="${Math.max(centre - 16, 2)}%"  stop-color="#e8e8e4"/>
        <stop offset="${centre}%"             stop-color="${DEGRADE.bandColor}"/>
        <stop offset="${Math.min(centre + 18, 98)}%" stop-color="#e4e4e0"/>
        <stop offset="100%"                   stop-color="#f6f6f2"/>
      </linearGradient>
    </defs>
    <rect width="${CANVAS.width}" height="${CANVAS.height}" fill="url(#lamp)"/>
  </svg>`;
  return Buffer.from(svg);
};

export const degrade = async (clean: Buffer, targets: Targets): Promise<Buffer> => {
  let img = clean;

  // ── 1. Planted difficulty, applied BEFORE the global pass so the two
  //       compound rather than the local blur being washed out by it. ──────

  // (a) Row 3's unit price. Combined with the lamp band centred on the same
  //     row, this value is the hardest number on the page.
  img = await blurRegion(img, targets.unitPriceRow3, DEGRADE.localBlurUnitPrice);

  // (b) The date. "08/03/2025" is already ambiguous as MM/DD vs DD/MM; the
  //     extra blur plus JPEG ringing at q35 makes the leading 8 degrade
  //     toward a 3 or a 6, so the samples disagree on the value as well as
  //     on the interpretation.
  img = await blurRegion(img, targets.invoiceDate, DEGRADE.localBlurDate);

  // (c) The coffee ring, centred on the MIDDLE digits of the grand total so
  //     the currency symbol and the last digits survive. A total that is
  //     entirely gone is a missing field; a total that is half-legible is a
  //     field the model will be tempted to guess at, which is the behaviour
  //     we actually want to catch.
  const gt = targets.grandTotal;
  // Ink bleed under the stain. The grand total is 24px bold — the densest
  // stain that still looks like a stain rather than a sticker does not hide
  // strokes that heavy. Wetting paper makes ink spread, so blurring under the
  // ring is both the physically honest model and the one that actually works.
  img = await blurRegion(img, gt, DEGRADE.localBlurGrandTotal);
  img = await sharp(img)
    .composite([
      // Centre biased right and slightly up: the digits sit in the upper-right
      // of the target rect, and an earlier pass put the dense rim below-left of
      // them, leaving "$4,179.05" perfectly readable underneath a decorative
      // smudge. The stain has to land ON the numerals to be a test at all.
      { input: coffeeRing(gt.x + gt.w * 0.62, gt.y + gt.h * 0.42, 86), blend: 'multiply' },
    ])
    .toBuffer();

  // ── 2. Uneven lamp ────────────────────────────────────────────────────
  img = await sharp(img)
    .composite([{ input: lampGradient(targets.darkBandY), blend: 'multiply' }])
    .toBuffer();

  // ── 3. Grain ──────────────────────────────────────────────────────────
  const noise = await sharp({
    create: {
      width: CANVAS.width,
      height: CANVAS.height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: DEGRADE.noiseSigma },
    },
  })
    .png()
    .toBuffer();
  img = await sharp(img).composite([{ input: noise, blend: 'overlay' }]).toBuffer();

  // ── 4. Skew, softness, faded contrast ─────────────────────────────────
  img = await sharp(img)
    .rotate(DEGRADE.rotationDeg, { background: '#efefe9' })
    .blur(DEGRADE.blurSigma)
    .linear(DEGRADE.contrastGain, DEGRADE.contrastOffset)
    .toBuffer();

  // ── 5. Resample round-trip: throw detail away for real ────────────────
  const meta = await sharp(img).metadata();
  const w = meta.width ?? CANVAS.width;
  const h = meta.height ?? CANVAS.height;
  const small = await sharp(img)
    .resize(Math.round(w * DEGRADE.resampleFactor), Math.round(h * DEGRADE.resampleFactor), {
      kernel: 'cubic',
    })
    .toBuffer();

  // ── 6. JPEG ringing ───────────────────────────────────────────────────
  return sharp(small)
    .resize(w, h, { kernel: 'cubic' })
    .jpeg({ quality: DEGRADE.jpegQuality, chromaSubsampling: '4:2:0' })
    .toBuffer();
};
