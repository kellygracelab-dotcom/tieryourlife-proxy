/**
 * The colours of a section, worked out once by the proxy so every client
 * draws the same thing. Claude Design's derivation: everything comes from the
 * light tint, worked in OKLab and clipped back to what a screen can show.
 * Pure: `sectionPictures.ts` asks Vision for the picture's colours.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** One colour of a picture and how much of it there is. A pixel is a weight of one. */
export interface WeightedColour extends Rgb {
  weight: number;
  /** How strongly Vision thinks the colour speaks for the picture, when it was Vision that saw it. */
  score?: number;
}

export interface ColourPair {
  light: string;
  dark: string;
}

export interface SectionColours {
  tint: ColourPair;
  topicBg: ColourPair;
  topicIcon: ColourPair;
}

interface Lab {
  L: number;
  a: number;
  b: number;
}

/** The app's dark and light surfaces. */
export const DARK_BASE = "#121318";
export const LIGHT_BASE = "#FBF8FF";

/** A tint dark enough to carry white text and light enough to read as a colour. */
export const TINT_MIN_LIGHTNESS = 0.4;
export const TINT_MAX_LIGHTNESS = 0.48;

/** How much of the tint each derived colour keeps, the rest being the surface it sits on. */
export const TINT_DARK_SHARE = 0.78;
export const TOPIC_BG_LIGHT_SHARE = 0.22;
export const TOPIC_BG_DARK_SHARE = 0.32;
export const TOPIC_ICON_DARK_LIGHTNESS = 0.82;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColour(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

export function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fromLinear(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Björn Ottosson's OKLab, in which equal steps of lightness look equal. */
export function toOklab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Back to a colour a screen can show: each channel clipped to its range, then rounded to 8 bits. */
export function fromOklab({ L, a, b }: Lab): string {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const channel = (linear: number) => Math.round(Math.min(1, Math.max(0, fromLinear(linear))) * 255);
  return rgbToHex({
    r: channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  });
}

/** `share` of `colour` and the rest of `base`, on L, a and b separately. */
export function mix(colour: string, base: string, share: number): string {
  const x = toOklab(colour);
  const y = toOklab(base);
  const at = (one: number, other: number) => one * share + other * (1 - share);
  return fromOklab({ L: at(x.L, y.L), a: at(x.a, y.a), b: at(x.b, y.b) });
}

const isNearBlack = ({ r, g, b }: Rgb) => Math.max(r, g, b) < 32;
const isNearWhite = ({ r, g, b }: Rgb) => Math.min(r, g, b) > 223;

/**
 * The picture's colour: colours grouped by 4-bit RGB, the fullest group
 * wins and its mean is the answer. Near-black and near-white sit out unless
 * nothing else is left, or a poster's black border would tint its section.
 */
export function dominantColour(samples: readonly WeightedColour[]): Rgb | null {
  const usable = samples.filter((one) => one.weight > 0);
  const coloured = usable.filter((one) => !isNearBlack(one) && !isNearWhite(one));
  const counted = coloured.length > 0 ? coloured : usable;
  if (counted.length === 0) return null;

  const buckets = new Map<number, { weight: number; r: number; g: number; b: number }>();
  for (const one of counted) {
    const key = ((one.r >> 4) << 8) | ((one.g >> 4) << 4) | (one.b >> 4);
    const bucket = buckets.get(key) ?? { weight: 0, r: 0, g: 0, b: 0 };
    bucket.weight += one.weight;
    bucket.r += one.r * one.weight;
    bucket.g += one.g * one.weight;
    bucket.b += one.b * one.weight;
    buckets.set(key, bucket);
  }

  // Ties go to the lower bucket, so the same picture always gives the same answer.
  const [, fullest] = [...buckets.entries()].sort(
    ([leftKey, left], [rightKey, right]) => right.weight - left.weight || leftKey - rightKey,
  )[0];
  return {
    r: Math.round(fullest.r / fullest.weight),
    g: Math.round(fullest.g / fullest.weight),
    b: Math.round(fullest.b / fullest.weight),
  };
}

/** A user section's light tint: the picture's colour with its lightness held between 0.40 and 0.48. */
export function tintLightFrom(colour: Rgb): string {
  const lab = toOklab(rgbToHex(colour));
  return fromOklab({ ...lab, L: Math.min(TINT_MAX_LIGHTNESS, Math.max(TINT_MIN_LIGHTNESS, lab.L)) });
}

/** Everything else a section draws with, from its light tint. */
export function coloursFromTint(tintLight: string): SectionColours {
  const light = tintLight.toUpperCase();
  return {
    tint: { light, dark: mix(light, DARK_BASE, TINT_DARK_SHARE) },
    topicBg: {
      light: mix(light, LIGHT_BASE, TOPIC_BG_LIGHT_SHARE),
      dark: mix(light, DARK_BASE, TOPIC_BG_DARK_SHARE),
    },
    topicIcon: {
      light,
      dark: fromOklab({ ...toOklab(light), L: TOPIC_ICON_DARK_LIGHTNESS }),
    },
  };
}

/**
 * Colours from a tint somebody chose: held in range like a picture's colour
 * for a user section, taken as given for a built-in.
 */
export function coloursFromChosenTint(tint: string, builtIn: boolean): SectionColours {
  return coloursFromTint(builtIn ? tint : tintLightFrom(hexToRgb(tint)));
}

/** The picture's strongest colours, at most five, each once: what a moderator picks a tint from. */
export function paletteOf(colours: readonly WeightedColour[], size = 5): string[] {
  const strongest = [...colours].sort((left, right) => (right.score ?? right.weight) - (left.score ?? left.weight));
  return [...new Set(strongest.map(rgbToHex))].slice(0, size);
}

/** A user section's colours from what Vision saw in its picture, or `fallback` when it saw nothing usable. */
export function coloursFromPicture(samples: readonly WeightedColour[], fallback: SectionColours): SectionColours {
  const colour = dominantColour(samples);
  return colour === null ? fallback : coloursFromTint(tintLightFrom(colour));
}
