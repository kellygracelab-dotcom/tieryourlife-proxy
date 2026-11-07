/**
 * What a file in somebody's own picture folder has to be. Storage rules only
 * see the type the client declares, so `checkUpload` reads the first bytes
 * once the file has landed and removes what these refuse.
 */

/** A person importing a big library uploads hundreds in a day; a script hosting files on us, far more. */
export const UPLOADS_PER_DAY = 2000;

/** Enough of the head for every signature below; WebP's is the longest. */
export const HEAD_BYTES = 12;

/** The owner of `users/{uid}/pictures/{id}`, the one folder a client writes; null for any other path. */
export function ownPictureOwner(name: string): string | null {
  return /^users\/([^/]+)\/pictures\/[^/]+$/.exec(name)?.[1] ?? null;
}

/** JPEG, PNG, GIF or WebP by their signatures: what the app, the site and `keep` ever store. */
export function looksLikePicture(head: Uint8Array): boolean {
  return pictureTypeOf(head) !== null;
}

/** The type the bytes really are, whatever a server declared. */
export function pictureTypeOf(head: Uint8Array): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const bytesAt = (at: number, ...bytes: number[]) => bytes.every((byte, i) => head[at + i] === byte);
  const textAt = (at: number, text: string) => bytesAt(at, ...[...text].map((c) => c.charCodeAt(0)));
  if (bytesAt(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytesAt(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (textAt(0, "GIF87a") || textAt(0, "GIF89a")) return "image/gif";
  if (textAt(0, "RIFF") && textAt(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * A GIF of more than one image, or a WebP flagged or chunked as an animation.
 * Vision looks at the first frame only, so these never go out from another site.
 */
export function isAnimated(bytes: Uint8Array): boolean {
  const type = pictureTypeOf(bytes);
  if (type === "image/gif") return gifImages(bytes) > 1;
  if (type === "image/webp") return webpAnimated(bytes);
  return false;
}

function gifImages(bytes: Uint8Array): number {
  const tableSize = (packed: number) => ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1));
  const skipSubBlocks = (from: number): number => {
    let at = from;
    while (at < bytes.length && bytes[at] !== 0) at += (bytes[at] as number) + 1;
    return at + 1;
  };
  let at = 13 + tableSize(bytes[10] ?? 0);
  let images = 0;
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x2c) {
      images++;
      at = skipSubBlocks(at + 10 + tableSize(bytes[at + 9] ?? 0) + 1);
    } else if (block === 0x21) {
      at = skipSubBlocks(at + 2);
    } else {
      break;
    }
  }
  return images;
}

function webpAnimated(bytes: Uint8Array): boolean {
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  let at = 12;
  while (at + 8 <= bytes.length) {
    const name = text(at);
    const size = ((bytes[at + 4] ?? 0) | ((bytes[at + 5] ?? 0) << 8) | ((bytes[at + 6] ?? 0) << 16) | ((bytes[at + 7] ?? 0) << 24)) >>> 0;
    if (name === "ANIM" || name === "ANMF") return true;
    if (name === "VP8X" && ((bytes[at + 8] ?? 0) & 0x02) !== 0) return true;
    at += 8 + size + (size % 2);
  }
  return false;
}

export type UploadVerdict = "keep" | "notAPicture" | "overDailyLimit";

/** [uploadsToday] counts this one; a file that is not a picture is refused before it is counted. */
export function judgeUpload(head: Uint8Array, uploadsToday: () => Promise<number>): Promise<UploadVerdict> {
  if (!looksLikePicture(head)) return Promise.resolve("notAPicture");
  return uploadsToday().then((count) => (count > UPLOADS_PER_DAY ? "overDailyLimit" : "keep"));
}
