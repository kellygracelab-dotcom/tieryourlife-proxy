/**
 * Which part of a cover picture shows (Danylo's request of 15.11.2026, spec in
 * `_coordination/cover-focus-2026-11-15/SPEC.md`): the point of the picture
 * that sits in the middle of the frame, as fractions of its width and height,
 * and how far in it is zoomed past the largest crop the frame allows. Every
 * place that shows a cover cuts it by `cropOf` for its own shape, so the same
 * point shows in a wide header and a square tile alike. None kept means
 * `defaultFocus`: the centre, unzoomed, or for a tall picture a point higher
 * up, where a portrait's face and a poster's title usually are (second round,
 * 15.11.2026). The same holds for a card's picture (`pictureFocus` on an item).
 */

export interface CoverFocus {
  /** 0 (left edge) to 1 (right edge). */
  x: number;
  /** 0 (top edge) to 1 (bottom edge). */
  y: number;
  /** 1 (the largest crop) to 4. */
  zoom: number;
}

export const MIN_FOCUS_ZOOM = 1;
export const MAX_FOCUS_ZOOM = 4;
export const FOCUS_RANGE = "A focus is {x, y, zoom}: x and y from 0 to 1, zoom from 1 to 4";

/** The centre, unzoomed: what no focus means for a picture that is not tall. */
export const CENTRE: CoverFocus = { x: 0.5, y: 0.5, zoom: 1 };
/** A picture is tall when its height over its width is more than this. */
export const TALL_RATIO = 1.2;
/** What no focus means for a tall picture: a third of the way down, unzoomed. */
export const TALL_DEFAULT: CoverFocus = { x: 0.5, y: 0.35, zoom: 1 };

/** The focus a [width] x [height] picture without one is shown with. */
export function defaultFocus(width: number, height: number): CoverFocus {
  return height / width > TALL_RATIO ? TALL_DEFAULT : CENTRE;
}

/**
 * [raw] as a focus, kept as sent: null for none (absent or null, the centre),
 * "invalid" for anything that is not three finite numbers in range. Other
 * keys are left out.
 */
export function readFocus(raw: unknown): CoverFocus | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const { x, y, zoom } = raw as Record<string, unknown>;
  const within = (value: unknown, low: number, high: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
  if (!within(x, 0, 1) || !within(y, 0, 1) || !within(zoom, MIN_FOCUS_ZOOM, MAX_FOCUS_ZOOM)) return "invalid";
  return { x, y, zoom };
}

/** A part of a picture, in its own pixels: left, top, width, height. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a [width] x [height] picture a frame of [aspect] (its width over
 * its height) shows for [focus]: the largest crop of that shape, made [zoom]
 * times smaller, centred on the focus point as far as the picture's edges let
 * it. The one formula every client draws a cover with (`cover-crop-vectors.json`).
 */
export function cropOf(width: number, height: number, aspect: number, focus: CoverFocus | null): Crop {
  const { x: fx, y: fy, zoom } = focus ?? defaultFocus(width, height);
  let cropWidth: number;
  let cropHeight: number;
  if (width / height > aspect) {
    cropHeight = height;
    cropWidth = height * aspect;
  } else {
    cropWidth = width;
    cropHeight = width / aspect;
  }
  cropWidth /= zoom;
  cropHeight /= zoom;
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  return {
    x: clamp(fx * width - cropWidth / 2, 0, width - cropWidth),
    y: clamp(fy * height - cropHeight / 2, 0, height - cropHeight),
    width: cropWidth,
    height: cropHeight,
  };
}
