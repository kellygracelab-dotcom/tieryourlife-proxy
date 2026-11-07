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

export type UploadVerdict = "keep" | "notAPicture" | "overDailyLimit";

/** [uploadsToday] counts this one; a file that is not a picture is refused before it is counted. */
export function judgeUpload(head: Uint8Array, uploadsToday: () => Promise<number>): Promise<UploadVerdict> {
  if (!looksLikePicture(head)) return Promise.resolve("notAPicture");
  return uploadsToday().then((count) => (count > UPLOADS_PER_DAY ? "overDailyLimit" : "keep"));
}
