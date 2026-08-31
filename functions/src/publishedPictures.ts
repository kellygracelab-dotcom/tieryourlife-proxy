/**
 * Moving somebody's own photographs from their private folder into the feed.
 *
 * The adapter to `safety.ts`, which decides, and to Cloud Vision, which looks.
 * Nothing here judges: it fetches bytes, asks, copies what passed, and hands
 * back addresses.
 *
 * Copies rather than opening the private folder for reading. A published list
 * is a snapshot and has always behaved like one -- editing the board does not
 * edit what the feed shows -- and a copy keeps that true of the pictures as
 * well. It also keeps `storage.rules` closed: the client writes only to its own
 * folder, and the public folder is written by this file alone.
 */
import { getStorage } from "firebase-admin/storage";
import { decideSafe, type Likelihood, type SafeSearchVerdict, type SafetyRefusal } from "./safety";

/** Where a person's own pictures live, readable by them alone. */
function privatePath(uid: string, pictureId: string): string {
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
function addressOf(bucket: string, path: string): string {
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
  const loaded = await Promise.all(
    pictureIds.map(async (id) => {
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
  if (outcomes.some((one) => !one.ok && one.because !== "missing")) return outcomes;

  await Promise.all(
    passed.map((one) =>
      bucket.file(publishedPath(listId, one.id)).save(one.bytes, {
        contentType: "image/jpeg",
        resumable: false,
      }),
    ),
  );

  return [
    ...outcomes,
    ...passed.map((one) => ({
      id: one.id,
      ok: true as const,
      address: addressOf(bucket.name, publishedPath(listId, one.id)),
    })),
  ];
}

/** Everything the feed was holding for this list. Called when it comes down. */
export async function discardPublished(listId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `published/${listId}/`, force: true });
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
