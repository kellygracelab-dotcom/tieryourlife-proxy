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
  const bytesAt = (at: number, ...bytes: number[]) => bytes.every((byte, i) => head[at + i] === byte);
  const textAt = (at: number, text: string) => bytesAt(at, ...[...text].map((c) => c.charCodeAt(0)));
  return bytesAt(0, 0xff, 0xd8, 0xff) ||
    bytesAt(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
    textAt(0, "GIF87a") ||
    textAt(0, "GIF89a") ||
    (textAt(0, "RIFF") && textAt(8, "WEBP"));
}

export type UploadVerdict = "keep" | "notAPicture" | "overDailyLimit" | "accountErased";

/**
 * [uploadsToday] counts this one; a file that is not a picture is refused before it is counted. An erased
 * account's token still passes the Storage rules for up to an hour, and nothing would delete what it uploads.
 */
export async function judgeUpload(
  head: Uint8Array,
  uploadsToday: () => Promise<number>,
  erased: () => Promise<boolean>,
): Promise<UploadVerdict> {
  if (await erased()) return "accountErased";
  if (!looksLikePicture(head)) return "notAPicture";
  return (await uploadsToday()) > UPLOADS_PER_DAY ? "overDailyLimit" : "keep";
}
