/**
 * Moving somebody's own photographs from their private folder into the feed.
 * The adapter to `safety.ts`, which decides, and to Cloud Vision, which looks.
 * Copies rather than opening the private folder: a published list is a
 * snapshot, and the public folder is written by this file alone.
 */
import { getStorage } from "firebase-admin/storage";
import { storageMediaUrl } from "./publicMedia";
import { isAnimated } from "./pictureBytes";
import { chargeVision } from "./visionBudget";
import { decideSafe, type Likelihood, type SafeSearchVerdict, type SafetyDecision, type SafetyRefusal } from "./safety";
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
 * Canonical stored address. Community serializes public image fields through
 * the site's existing /img/original route so old image loaders also survive
 * Storage App Check enforcement; matching and stored snapshots keep this form.
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
  {
    nameSuffix = "",
    onSaved = () => undefined,
    charge = async () => undefined,
  }: { nameSuffix?: string; onSaved?: (path: string) => void; charge?: (looks: number) => Promise<void> } = {},
): Promise<PictureOutcome[]> {
  if (pictureIds.length === 0) return [];

  const bucket = getStorage().bucket();

  // A copy already in this list's folder was looked at when it arrived, and
  // nothing but this function can put one there. A name with this attempt's own
  // suffix cannot be there yet, so a publication does not ask.
  const [existing] = nameSuffix === "" ? await bucket.getFiles({ prefix: `published/${listId}/` }) : [[]];
  const alreadyHere = new Set(
    existing.map((file) => file.name.slice(`published/${listId}/`.length)),
  );
  const settled: PictureOutcome[] = pictureIds
    .filter((id) => alreadyHere.has(id + nameSuffix))
    .map((id) => ({ id, ok: true as const, address: addressOf(bucket.name, publishedPath(listId, id + nameSuffix)) }));

  const fresh = pictureIds.filter((id) => !alreadyHere.has(id + nameSuffix));
  if (fresh.length === 0) return settled;

  // Looked at a few at a time, never all held at once: two hundred photographs of 4 MB are more than an
  // instance has (QA, 19.11.2026). Each is pinned to the version looked at, so one replaced in the
  // folder meanwhile is not the one copied: its copy fails and the publication with it.
  const outcomes: PictureOutcome[] = [];
  // Pictures that all fit in one look are saved from the bytes looked at: they are that pinned
  // version already, and a second download would only fetch them again.
  const oneLook = fresh.length <= LOOKING_AT_ONCE;
  const passed: { id: string; generation: string | number; bytes?: Buffer }[] = [];
  for (let at = 0; at < fresh.length; at += LOOKING_AT_ONCE) {
    const loaded = await Promise.all(fresh.slice(at, at + LOOKING_AT_ONCE).map((id) => downloadPinned(authorUid, id)));
    for (const one of loaded) if (one.bytes === null) outcomes.push({ id: one.id, ok: false, because: "missing" });
    const present = loaded.filter((one): one is Pinned & { bytes: Buffer } => one.bytes !== null);
    // Counted against the account's day before Vision is asked (src/visionBudget.ts); over it, this throws.
    if (present.length > 0) await charge(present.length);
    const verdicts = present.length > 0 ? await lookAt(present.map((one) => one.bytes)) : [];
    present.forEach((one, index) => {
      const decision = decideOwnPicture(one.bytes, verdicts[index] ?? null);
      if (decision.ok) passed.push({ id: one.id, generation: one.generation, ...(oneLook ? { bytes: one.bytes } : {}) });
      else outcomes.push({ id: one.id, ok: false, because: decision.because });
    });
    // Nothing is copied while anything is refused: the caller turns the whole publication down, and a
    // half-copied folder would be litter. The rest need not be looked at.
    if (outcomes.some((one) => !one.ok && one.because !== "missing")) return [...settled, ...outcomes];
  }

  // Read again (unless kept from one look), the version looked at, and saved as a new file: a copy
  // would carry the private file's own metadata, its download token among it.
  for (let at = 0; at < passed.length; at += LOOKING_AT_ONCE) {
    const saved = await Promise.allSettled(
      passed.slice(at, at + LOOKING_AT_ONCE).map(async (one) => {
        const path = publishedPath(listId, one.id + nameSuffix);
        const bytes = one.bytes ?? (await bucket.file(privatePath(authorUid, one.id), { generation: one.generation }).download())[0];
        await bucket.file(path).save(bytes, { contentType: "image/jpeg", resumable: false });
        onSaved(path);
      }),
    );
    const failed = saved.find((one): one is PromiseRejectedResult => one.status === "rejected");
    if (failed) throw failed.reason;
  }

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

/** Own photographs downloaded and looked at together: one Vision call's worth, at most 64 MB held. */
const LOOKING_AT_ONCE = 16;

interface Pinned {
  id: string;
  bytes: Buffer | null;
  generation: string | number;
}

/** A photograph's bytes and the version they are, or no bytes when it is gone or unreadable. */
async function downloadPinned(uid: string, id: string): Promise<Pinned> {
  const bucket = getStorage().bucket();
  try {
    const [metadata] = await bucket.file(privatePath(uid, id)).getMetadata();
    const generation = metadata.generation;
    if (generation === undefined) return { id, bytes: null, generation: 0 };
    const [bytes] = await bucket.file(privatePath(uid, id), { generation }).download();
    return { id, bytes, generation };
  } catch {
    return { id, bytes: null, generation: 0 };
  }
}

/**
 * Whether somebody's own photograph may be shown to everybody (QA, 19.11.2026). Vision sees an
 * animation's first frame only, so an animation is not shown; and a photograph Vision could not
 * read, or say anything about, is not taken as safe: it is refused as "unchecked", to be sent as a still.
 * A Vision that is out of reach throws instead, and the publication is asked again.
 */
export function decideOwnPicture(bytes: Uint8Array, verdict: SafeSearchVerdict | null): SafetyDecision {
  if (isAnimated(bytes)) return { ok: false, because: "unchecked" };
  if (verdict === null || verdict.adult === "UNKNOWN" || verdict.violence === "UNKNOWN") return { ok: false, because: "unchecked" };
  return decideSafe(verdict);
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
  url = url === null ? null : storageMediaUrl(url);
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
  copied: (fileName: string, originalListId: string) => boolean = isCopiedFrom,
): Promise<void> {
  await Promise.all(
    copyListIds.map(async (id) => {
      const prefix = `published/${id}/`;
      const [files] = await bucket.getFiles({ prefix });
      await Promise.all(
        files
          .filter((file) => copied(file.name.slice(prefix.length), originalListId))
          .map((file) => file.delete().catch(() => undefined)),
      );
    }),
  );
}

/**
 * Whether a copy's file is of a photograph the original's author put in
 * (a picture of their own folder, named by its id there), rather than of a
 * picture from a catalogue or another site, which are named `w-…` and are
 * nobody's own (`outsideName`).
 */
export function isPhotoCopiedFrom(fileName: string, originalListId: string): boolean {
  if (!isCopiedFrom(fileName, originalListId)) return false;
  const at = fileName.startsWith(`${originalListId}-`) ? 0 : fileName.indexOf(`-${originalListId}-`) + 1;
  return !fileName.slice(at + originalListId.length + 1).startsWith("w-");
}

/**
 * [list] without the copies, in its own folder [folderId], of the photographs
 * the author of [originalListId] put in (`isPhotoCopiedFrom`): a card that
 * showed one shows no picture, and the collage leaves it out. Null when it
 * held none. For a list whose original goes with its author's account.
 */
export function withoutPhotosFrom<T extends PictureAddresses>(list: T, folderId: string, originalListId: string): T | null {
  let changed = false;
  const keep = (url: string | null): string | null => {
    const [name] = publishedNamesIn(folderId, [url]);
    if (name === undefined || !isPhotoCopiedFrom(name, originalListId)) return url;
    changed = true;
    return null;
  };
  const items = list.items.map((item) => {
    const imageUrl = keep(item.imageUrl);
    return imageUrl === item.imageUrl ? item : { ...item, imageUrl };
  });
  const coverImageUrl = keep(list.coverImageUrl);
  const previewImages = list.previewImages.filter((url) => keep(url) !== null);
  return changed ? { ...list, items, coverImageUrl, previewImages } : null;
}

/**
 * The files of `published/{listId}/` these addresses point at. A replaced
 * snapshot names the copies it keeps by their address, not by a pictureId.
 */
export function publishedNamesIn(listId: string, urls: readonly (string | null | undefined)[]): string[] {
  const marker = `/o/${encodeURIComponent(`published/${listId}/`)}`;
  return urls.flatMap((url) => {
    if (typeof url !== "string") return [];
    url = storageMediaUrl(url);
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
 * How long a copy its list or ranking no longer names stays at least (20.11.2026). Other people's
 * boards, rankings and Continue entries keep a published list's picture addresses, and a guest's
 * board on a device the server never sees: a copy the author replaced used to go at once and
 * leave their cards empty. It goes after this long, and only when nothing the server keeps names
 * it any more (`retiredToRemove`, run by the daily upkeep).
 */
export const RETIRED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The custom metadata key that says when a copy stopped being named by its own list, epoch ms. */
export const RETIRED_AT = "retiredAt";

/** When a file was retired, from its custom metadata; null when it is not. */
export function retiredAtOf(custom: Record<string, unknown> | undefined | null): number | null {
  const at = Number(custom?.[RETIRED_AT]);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** The retired files to remove now: retired at least [RETIRED_KEEP_MS] ago, and named by nothing in [named]. */
export function retiredToRemove(files: readonly { name: string; retiredAt: number | null }[], named: ReadonlySet<string>, nowMs: number): string[] {
  return files.filter((file) => file.retiredAt !== null && nowMs - file.retiredAt >= RETIRED_KEEP_MS && !named.has(file.name)).map((file) => file.name);
}

/** Every path in our bucket that any string in [data] names, however deep: the most careful reading of what a document shows. */
export function namedPaths(data: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof data === "string") {
    if (!data.includes("/o/") && !data.includes("/img/original/")) return into;
    const match = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?#]+)/.exec(storageMediaUrl(data));
    if (match) {
      try {
        into.add(decodeURIComponent(match[1]!));
      } catch {
        // An address that does not decode names nothing of ours.
      }
    }
  } else if (Array.isArray(data)) {
    for (const one of data) namedPaths(one, into);
  } else if (data !== null && typeof data === "object") {
    if (typeof (data as { toDate?: unknown }).toDate === "function") return into;
    for (const one of Object.values(data as Record<string, unknown>)) namedPaths(one, into);
  }
  return into;
}

/**
 * The copies this list (or ranking) no longer names, after a republish: marked retired, not removed.
 * A copy it names again loses the mark. The daily upkeep removes them once nothing names them
 * (`RETIRED_KEEP_MS`).
 */
export async function retireUnusedPublished(listId: string, keeping: string[], candidates?: readonly string[], nowMs: number = Date.now()): Promise<void> {
  const kept = new Set(keeping);
  const eligible = candidates === undefined ? null : new Set(candidates);
  const [files] = await getStorage()
    .bucket()
    .getFiles({ prefix: `published/${listId}/` });
  // A mark that fails to land leaves the copy unmarked: kept, the safe side.
  const mark = (file: (typeof files)[number], value: string | null) =>
    Promise.resolve()
      .then(() => file.setMetadata({ metadata: { [RETIRED_AT]: value } }))
      .catch(() => undefined);
  await Promise.all(
    files.map((file) => {
      const name = file.name.slice(`published/${listId}/`.length);
      const retired = retiredAtOf((file.metadata?.metadata ?? null) as Record<string, unknown> | null);
      if (kept.has(name)) return retired === null ? undefined : mark(file, null);
      if (retired !== null || (eligible !== null && !eligible.has(name))) return undefined;
      return mark(file, String(nowMs));
    }),
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

  await chargeVision(uid, "faces", 1);
  const [verdict] = await safeSearchOrNothing([bytes]);
  if (!decideOwnPicture(bytes, verdict ?? null).ok) return null;

  const path = `avatars/${uid}/${pictureId}`;
  await bucket.file(path).save(bytes, { contentType: "image/jpeg", resumable: false });
  return addressOf(bucket.name, path);
}
