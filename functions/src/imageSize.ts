/**
 * How big a picture is, read from its first bytes rather than by decoding it:
 * a section's picture only has to be wide enough and the right shape, and
 * the header says both. JPEG, PNG and WebP, which is what phones upload.
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageSize {
  format: ImageFormat;
  width: number;
  height: number;
}

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** A section's picture is drawn full width on a tablet, sixteen by ten. */
export const MIN_PICTURE_WIDTH = 960;
export const PICTURE_ASPECT = 16 / 10;
export const ASPECT_TOLERANCE = 0.02;

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const u16le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { format: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** The frame header is somewhere after the metadata; every segment before it says how long it is. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan or end of image before any frame: nothing here says how big it is.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(bytes, at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return null;
      return { format: "jpeg", height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return { format: "webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { format: "webp", width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return {
      format: "webp",
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return pngSize(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes);
  return null;
}

export type PictureRefusal = "missing" | "not_image" | "too_small" | "not_16_10";

export type PictureJudgement = { ok: true; size: ImageSize } | { ok: false; why: PictureRefusal };

/** Whether an upload can be a section's picture. The client crops; this only checks it did. */
export function judgePicture(bytes: Uint8Array | null): PictureJudgement {
  if (bytes === null) return { ok: false, why: "missing" };
  const size = imageSize(bytes);
  if (size === null || size.width === 0 || size.height === 0) return { ok: false, why: "not_image" };
  if (size.width < MIN_PICTURE_WIDTH) return { ok: false, why: "too_small" };
  const off = Math.abs(size.width / size.height / PICTURE_ASPECT - 1);
  if (off > ASPECT_TOLERANCE) return { ok: false, why: "not_16_10" };
  return { ok: true, size };
}
