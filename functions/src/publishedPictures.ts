/**
 * Moving somebody's own photographs from their private folder into the feed.
 * The adapter to `safety.ts`, which decides, and to Cloud Vision, which looks.
 * Copies rather than opening the private folder: a published list is a
 * snapshot, and the public folder is written by this file alone.
 */
import { getStorage } from "firebase-admin/storage";
import { decideSafe, type Likelihood, type SafeSearchVerdict, type SafetyRefusal } from "./safety";
import { isDemoEmulator, SAFE_VERDICT } from "./emulator";

/** Where a person's own pictures live, readable by them alone. */
export function privatePath(uid: string, pictureId: string): string {
  return `users/${uid}/pictures/${pictureId}`;
}

/** Where the feed's copies live, readable by everybody, written only here. */
export function publishedPath(listId: string, pictureId: string): string {
  return `published/${listId}/${pictureId}`;
}

/**
 * The address the app will fetch. This endpoint applies `storage.rules`, so
 * the folder being world-readable is what makes it work — no signed URL to
 * expire, and nothing to renew.
 */
export function addressOf(bucket: string, path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}

export type PictureOutcome =
  | { id: string; ok: true; address: string }
  | { id: string; ok: false; because: SafetyRefusal }
  /** Gone, unreadable, or never uploaded. The card simply loses its art. */
  | { id: string; ok: false; because: "missing" };

/**
 * Vision, called once for the whole batch rather than once per picture.
 *
 * Injected so the deciding can be exercised without a network: `community.ts`
 * passes the real one, tests pass whatever verdict they want to reason about.
 */
export type LookAtPictures = (images: Buffer[]) => Promise<SafeSearchVerdict[]>;

export async function realSafeSearch(images: Buffer[]): Promise<SafeSearchVerdict[]> {
  if (isDemoEmulator()) return images.map(() => SAFE_VERDICT);
  // Imported here rather than at the top: a cold start that never publishes
  // anything should not pay to load the Vision client.
  const { ImageAnnotatorClient } = await import("@google-cloud/vision");
  const client = new ImageAnnotatorClient();
  const [response] = await client.batchAnnotateImages({
    requests: images.map((content) => ({
      image: { content },
      features: [{ type: "SAFE_SEARCH_DETECTION" }],
    })),
  });

  return (response.responses ?? []).map((one) => {
    const found = one.safeSearchAnnotation;
    const read = (value: unknown): Likelihood =>
      typeof value === "string" ? (value as Likelihood) : "UNKNOWN";
    return {
      adult: read(found?.adult),
      racy: read(found?.racy),
      violence: read(found?.violence),
    };
  });
}

/**
 * Look at every picture the draft named, and copy the ones that may be seen.
 *
 * All of them are looked at before any of them is copied, so a list that is
 * refused leaves nothing behind in the public folder.
 */
export async function copyForPublication(
  authorUid: string,
  listId: string,
  pictureIds: string[],
  lookAt: LookAtPictures = realSafeSearch,
): Promise<PictureOutcome[]> {
  if (pictureIds.length === 0) return [];

  const bucket = getStorage().bucket();

  // A copy already in this list's folder was looked at when it arrived, and
  // nothing but this function can put one there.
  const [existing] = await bucket.getFiles({ prefix: `published/${listId}/` });
  const alreadyHere = new Set(
    existing.map((file) => file.name.slice(`published/${listId}/`.length)),
  );
  const settled: PictureOutcome[] = pictureIds
    .filter((id) => alreadyHere.has(id))
    .map((id) => ({ id, ok: true as const, address: addressOf(bucket.name, publishedPath(listId, id)) }));

  const fresh = pictureIds.filter((id) => !alreadyHere.has(id));
  if (fresh.length === 0) return settled;

  const loaded = await Promise.all(
    fresh.map(async (id) => {
      try {
        const [bytes] = await bucket.file(privatePath(authorUid, id)).download();
        return { id, bytes };
      } catch {
        return { id, bytes: null };
      }
    }),
  );

  const present = loaded.filter((one): one is { id: string; bytes: Buffer } => one.bytes !== null);
  const verdicts = present.length > 0 ? await lookAt(present.map((one) => one.bytes)) : [];

  const outcomes: PictureOutcome[] = loaded
    .filter((one) => one.bytes === null)
    .map((one) => ({ id: one.id, ok: false, because: "missing" as const }));

  const passed: { id: string; bytes: Buffer }[] = [];
  present.forEach((one, index) => {
    // A verdict that never arrived is not a verdict against. It is the same
    // case as UNKNOWN, and `decideSafe` already says what to do with that.
    const verdict = verdicts[index] ?? { adult: "UNKNOWN", racy: "UNKNOWN", violence: "UNKNOWN" };
    const decision = decideSafe(verdict);
    if (decision.ok) {
      passed.push(one);
    } else {
      outcomes.push({ id: one.id, ok: false, because: decision.because });
    }
  });

  // Nothing is copied while anything is still refused: the caller turns the
  // whole publication down, and a half-copied folder would be litter.
  if (outcomes.some((one) => !one.ok && one.because !== "missing")) return [...settled, ...outcomes];

  await Promise.all(
    passed.map((one) =>
      bucket.file(publishedPath(listId, one.id)).save(one.bytes, {
        contentType: "image/jpeg",
        resumable: false,
      }),
    ),
  );

  return [
    ...settled,
    ...outcomes,
    ...passed.map((one) => ({
      id: one.id,
      ok: true as const,
      address: addressOf(bucket.name, publishedPath(listId, one.id)),
    })),
  ];
}

/**
 * The folders that show a list to the world: the feed's copies of its
 * pictures, and the share cards the site draws for it. A ranking's cards,
 * under `share/r/`, are the site's own to clear.
 */
export function publicFoldersOf(listId: string): string[] {
  return [`published/${listId}/`, `share/l/${listId}/`];
}

/** Only what `discardPublished` asks of a bucket, so a test can hand it another. */
export interface FolderDeleter {
  deleteFiles(options: { prefix: string; force: boolean }): Promise<unknown>;
}

/** Everything the feed and the site were holding for this list. Called when it comes down. */
export async function discardPublished(listId: string, bucket: FolderDeleter = getStorage().bucket()): Promise<void> {
  await Promise.all(publicFoldersOf(listId).map((prefix) => bucket.deleteFiles({ prefix, force: true })));
}

const PUBLISHED_FILE = /\/o\/published%2F([^/?#%]+)%2F([^/?#]+)/i;

/**
 * Where a copy in another list's folder should live in this one's. A list made
 * from somebody else's keeps their pictures only while their list does, so it
 * takes copies of its own: `{otherList}-{name}`.
 */
export function foreignCopyOf(listId: string, url: string | null): { from: string; to: string } | null {
  const match = url === null ? null : PUBLISHED_FILE.exec(url);
  if (match === null) return null;
  let other: string;
  let name: string;
  try {
    other = decodeURIComponent(match[1]);
    name = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (other === listId || name.includes("/")) return null;
  return { from: publishedPath(other, name), to: publishedPath(listId, `${other}-${name}`) };
}

interface PictureAddresses {
  items: { imageUrl: string | null }[];
  coverImageUrl: string | null;
  previewImages: string[];
}

const COPYING_AT_ONCE = 20;

/**
 * Copies every picture the list shows from another list's folder into its own
 * and points at the copy. One whose original is already gone is left out.
 */
export async function adoptForeignCopies<T extends PictureAddresses>(listId: string, list: T): Promise<T> {
  const urls = [...list.items.map((item) => item.imageUrl), list.coverImageUrl, ...list.previewImages];
  const wanted = new Map<string, { from: string; to: string }>();
  for (const url of urls) {
    const copy = foreignCopyOf(listId, url);
    if (copy !== null && url !== null) wanted.set(url, copy);
  }
  if (wanted.size === 0) return list;

  const bucket = getStorage().bucket();
  const moved = new Map<string, string | null>();
  const pending = [...wanted.entries()];
  for (let at = 0; at < pending.length; at += COPYING_AT_ONCE) {
    await Promise.all(
      pending.slice(at, at + COPYING_AT_ONCE).map(async ([url, copy]) => {
        try {
          await bucket.file(copy.from).copy(bucket.file(copy.to));
          moved.set(url, addressOf(bucket.name, copy.to));
        } catch {
          moved.set(url, null);
        }
      }),
    );
  }
  const swap = (url: string | null): string | null => (url !== null && moved.has(url) ? moved.get(url) ?? null : url);
  return {
    ...list,
    items: list.items.map((item) => ({ ...item, imageUrl: swap(item.imageUrl) })),
    coverImageUrl: swap(list.coverImageUrl),
    previewImages: list.previewImages.map(swap).filter((url): url is string => url !== null),
  };
}

/**
 * The files of `published/{listId}/` these addresses point at. A replaced
 * snapshot names the copies it keeps by their address, not by a pictureId.
 */
export function publishedNamesIn(listId: string, urls: readonly (string | null | undefined)[]): string[] {
  const marker = `/o/${encodeURIComponent(`published/${listId}/`)}`;
  return urls.flatMap((url) => {
    if (typeof url !== "string") return [];
    const at = url.indexOf(marker);
    if (at < 0) return [];
    const rest = url.slice(at + marker.length).split(/[?#]/)[0];
    try {
      return [decodeURIComponent(rest)];
    } catch {
      return [];
    }
  });
}

/**
 * The copies this list no longer names, after a republish.
 *
 * A board somebody edited for a month can leave a great many behind, and they
 * are nobody's: the snapshot that pointed at them has been replaced.
 */
export async function discardUnusedPublished(listId: string, keeping: string[]): Promise<void> {
  const kept = new Set(keeping);
  const [files] = await getStorage()
    .bucket()
    .getFiles({ prefix: `published/${listId}/` });
  await Promise.all(
    files
      .filter((file) => !kept.has(file.name.slice(`published/${listId}/`.length)))
      .map((file) => file.delete().catch(() => undefined)),
  );
}

/**
 * The same shape as publishing a board's pictures: a face is shown next to
 * every list they publish, so it is copied somewhere everybody may read, and
 * looked at first. Null when the picture is missing or Vision objected.
 */
export async function copyAsFace(uid: string, pictureId: string): Promise<string | null> {
  const bucket = getStorage().bucket();
  let bytes: Buffer;
  try {
    [bytes] = await bucket.file(privatePath(uid, pictureId)).download();
  } catch {
    return null;
  }

  const [verdict] = await realSafeSearch([bytes]);
  if (!verdict || !decideSafe(verdict).ok) return null;

  const path = `avatars/${uid}/${pictureId}`;
  await bucket.file(path).save(bytes, { contentType: "image/jpeg", resumable: false });
  return addressOf(bucket.name, path);
}
