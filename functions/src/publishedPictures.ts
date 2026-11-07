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
 * Vision for a list's photographs, in as few calls as it takes.
 *
 * Injected so the deciding can be exercised without a network: `community.ts`
 * passes the real one, tests pass whatever verdict they want to reason about.
 */
export type LookAtPictures = (images: Buffer[]) => Promise<SafeSearchVerdict[]>;

/** One call to Vision: at most sixteen images, as many verdicts back, null where it answered nothing. */
export type Annotate = (images: Buffer[]) => Promise<(SafeSearchVerdict | null)[]>;

/** Vision takes sixteen images a call, and a request of about ten megabytes; images travel as base64. */
const IMAGES_PER_CALL = 16;
const BASE64_PER_CALL = 8_000_000;

export function visionBatches(images: readonly Buffer[]): Buffer[][] {
  const batches: Buffer[][] = [];
  let weight = 0;
  for (const image of images) {
    const size = 4 * Math.ceil(image.length / 3);
    const last = batches[batches.length - 1];
    if (last === undefined || last.length >= IMAGES_PER_CALL || weight + size > BASE64_PER_CALL) {
      batches.push([image]);
      weight = size;
    } else {
      last.push(image);
      weight += size;
    }
  }
  return batches;
}

export async function realSafeSearch(images: Buffer[], annotate: Annotate = visionAnnotate): Promise<SafeSearchVerdict[]> {
  const unknown: SafeSearchVerdict = { adult: "UNKNOWN", racy: "UNKNOWN", violence: "UNKNOWN" };
  return (await safeSearchOrNothing(images, annotate)).map((verdict) => verdict ?? unknown);
}

/** Null for a picture Vision answered nothing about, which a picture from another site is not published on. */
export async function safeSearchOrNothing(images: Buffer[], annotate: Annotate = visionAnnotate): Promise<(SafeSearchVerdict | null)[]> {
  if (isDemoEmulator()) return images.map(() => SAFE_VERDICT);
  const verdicts: (SafeSearchVerdict | null)[] = [];
  for (const batch of visionBatches(images)) {
    const answered = await annotate(batch);
    verdicts.push(...batch.map((_, at) => answered[at] ?? null));
  }
  return verdicts;
}

async function visionAnnotate(images: Buffer[]): Promise<(SafeSearchVerdict | null)[]> {
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
    if (!found) return null;
    const read = (value: unknown): Likelihood =>
      typeof value === "string" ? (value as Likelihood) : "UNKNOWN";
    return {
      adult: read(found.adult),
      racy: read(found.racy),
      violence: read(found.violence),
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
  { nameSuffix = "", onSaved = () => undefined }: { nameSuffix?: string; onSaved?: (path: string) => void } = {},
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
    .filter((id) => alreadyHere.has(id + nameSuffix))
    .map((id) => ({ id, ok: true as const, address: addressOf(bucket.name, publishedPath(listId, id + nameSuffix)) }));

  const fresh = pictureIds.filter((id) => !alreadyHere.has(id + nameSuffix));
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

  const saved = await Promise.allSettled(
    passed.map(async (one) => {
      const path = publishedPath(listId, one.id + nameSuffix);
      await bucket.file(path).save(one.bytes, {
        contentType: "image/jpeg",
        resumable: false,
      });
      onSaved(path);
    }),
  );
  const failed = saved.find((one): one is PromiseRejectedResult => one.status === "rejected");
  if (failed) throw failed.reason;

  return [
    ...settled,
    ...outcomes,
    ...passed.map((one) => ({
      id: one.id,
      ok: true as const,
      address: addressOf(bucket.name, publishedPath(listId, one.id + nameSuffix)),
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
export function foreignCopyOf(listId: string, url: string | null): { from: string; to: string; list: string } | null {
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
  return { from: publishedPath(other, name), to: publishedPath(listId, `${other}-${name}`), list: other };
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
export async function adoptForeignCopies<T extends PictureAddresses>(
  listId: string,
  list: T,
  { nameSuffix = "", onSaved = () => undefined }: { nameSuffix?: string; onSaved?: (path: string) => void } = {},
): Promise<{ list: T; picturesFrom: string[] }> {
  const urls = [...list.items.map((item) => item.imageUrl), list.coverImageUrl, ...list.previewImages];
  const wanted = new Map<string, { from: string; to: string; list: string }>();
  for (const url of urls) {
    const copy = foreignCopyOf(listId, url);
    if (copy !== null && url !== null) wanted.set(url, { ...copy, to: copy.to + nameSuffix });
  }
  if (wanted.size === 0) return { list, picturesFrom: [] };

  const bucket = getStorage().bucket();
  const moved = new Map<string, string | null>();
  const pending = [...wanted.entries()];
  for (let at = 0; at < pending.length; at += COPYING_AT_ONCE) {
    await Promise.all(
      pending.slice(at, at + COPYING_AT_ONCE).map(async ([url, copy]) => {
        try {
          await bucket.file(copy.from).copy(bucket.file(copy.to));
          onSaved(copy.to);
          moved.set(url, addressOf(bucket.name, copy.to));
        } catch {
          moved.set(url, null);
        }
      }),
    );
  }
  const swap = (url: string | null): string | null => (url !== null && moved.has(url) ? moved.get(url) ?? null : url);
  const picturesFrom = [...new Set([...wanted.entries()].filter(([url]) => moved.get(url)).map(([, copy]) => copy.list))];
  return {
    list: {
      ...list,
      items: list.items.map((item) => ({ ...item, imageUrl: swap(item.imageUrl) })),
      coverImageUrl: swap(list.coverImageUrl),
      previewImages: list.previewImages.map(swap).filter((url): url is string => url !== null),
    },
    picturesFrom,
  };
}

/**
 * Whether a copy's file came from that list, however many copies away: a copy
 * of a copy is named `{copy}-{original}-{name}`. List ids hold no `-`.
 */
export function isCopiedFrom(fileName: string, originalListId: string): boolean {
  return fileName.startsWith(`${originalListId}-`) || fileName.includes(`-${originalListId}-`);
}

const LIST_ID = /^[A-Za-z0-9]{20}$/;

/**
 * The lists a copy's own files came from, read off their names: a snapshot
 * sent again with the copy's own addresses still holds `{original}-{name}`.
 */
export function sourcesInNames(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const parts = name.split("-");
    for (let at = 0; at < parts.length - 1 && LIST_ID.test(parts[at]); at++) found.add(parts[at]);
  }
  return [...found];
}

/** Only what `discardCopiesIn` asks of a bucket. */
export interface FolderLister {
  getFiles(options: { prefix: string }): Promise<[{ name: string; delete(): Promise<unknown> }[], ...unknown[]]>;
}

export async function discardCopiesIn(
  copyListIds: string[],
  originalListId: string,
  bucket: FolderLister = getStorage().bucket(),
): Promise<void> {
  await Promise.all(
    copyListIds.map(async (id) => {
      const prefix = `published/${id}/`;
      const [files] = await bucket.getFiles({ prefix });
      await Promise.all(
        files
          .filter((file) => isCopiedFrom(file.name.slice(prefix.length), originalListId))
          .map((file) => file.delete().catch(() => undefined)),
      );
    }),
  );
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
export async function discardUnusedPublished(listId: string, keeping: string[], candidates?: readonly string[]): Promise<void> {
  const kept = new Set(keeping);
  const eligible = candidates === undefined ? null : new Set(candidates);
  const [files] = await getStorage()
    .bucket()
    .getFiles({ prefix: `published/${listId}/` });
  await Promise.all(
    files
      .filter((file) => {
        const name = file.name.slice(`published/${listId}/`.length);
        return !kept.has(name) && (eligible === null || eligible.has(name));
      })
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
