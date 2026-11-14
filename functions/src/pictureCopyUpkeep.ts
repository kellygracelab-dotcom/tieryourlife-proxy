/**
 * Copies of catalogue pictures after they are made (`pictureCopies.ts`):
 * every copy's file says what it was copied from and when, in its custom
 * metadata `{originalUrl, source, copiedAt}`. Once a day `refreshPictures`
 * copies what a list or a ranking still shows from a catalogue switched on
 * (a catalogue that did not answer at publication is asked again), and fetches
 * again the copies of a catalogue whose terms limit how long a copy is kept
 * (TMDB, six months: again after 90 days; a copy not fetched again within 150
 * days goes, and its cards show the catalogue's own address again). The same
 * undoing, for a whole catalogue, is `npm run remove-picture-copies`. Boards
 * kept in accounts are looked after too, from their shared copies
 * (`boardPictures.ts`), always in place: a board's revision and fingerprint
 * never move for its pictures.
 */
import { getFirestore, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { SHARED_COPIES, copyToShared, fitsWithCopies } from "./boardPictures";
import { catalogueCopyTools, copyCataloguePictures, coverCopiesWanted, withCatalogueCopies } from "./cataloguePictures";
import { nextRevision } from "./listRevision";
import { copyMetaFor, realOutsideTools } from "./outsidePictures";
import { copySourceOf, isCopyOf, type PictureAttribution } from "./pictureAttribution";
import { COPY_LIMITS, copySwitches, wantsCopy, type CopySwitches } from "./pictureCopies";
import { storageMediaUrl } from "./publicMedia";

/** What a copy's file says of itself; absent fields for a file copied before files said so. */
export interface CopyMeta {
  originalUrl?: string;
  source?: string;
  copiedAt?: number;
}

/** A stored file's own metadata read as a copy's, its upload time when it says no copy time. */
export function readCopyMeta(custom: Record<string, unknown> | undefined, timeCreated: string | undefined): CopyMeta {
  const copiedAt = Number(custom?.copiedAt);
  const created = timeCreated ? Date.parse(timeCreated) : NaN;
  return {
    ...(typeof custom?.originalUrl === "string" ? { originalUrl: custom.originalUrl } : {}),
    ...(typeof custom?.source === "string" ? { source: custom.source } : {}),
    ...(Number.isFinite(copiedAt) && copiedAt > 0 ? { copiedAt } : Number.isFinite(created) ? { copiedAt: created } : {}),
  };
}

/** What a copy's age asks of it: nothing, fetching again, or going if fetching again fails. */
export function copyAgeDue(meta: CopyMeta, nowMs: number): "keep" | "refresh" | "refresh-or-drop" {
  const limit = meta.source ? COPY_LIMITS[meta.source] : undefined;
  if (limit === undefined || meta.copiedAt === undefined || !meta.originalUrl) return "keep";
  const age = nowMs - meta.copiedAt;
  if (age >= limit.dropAfterMs) return "refresh-or-drop";
  return age >= limit.refreshAfterMs ? "refresh" : "keep";
}

/** A picture address's path in our bucket, or null when it is not one of ours. */
export function storedPathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?#]+)/.exec(storageMediaUrl(url));
  return match ? decodeURIComponent(match[1]!) : null;
}

type Card = { imageUrl?: string | null; attribution?: PictureAttribution } & Record<string, unknown>;

export interface ShownPictures {
  items: Card[];
  coverImageUrl: string | null;
  previewImages: string[];
  /** Where a ranking keeps [items]: a signed-in reader's added cards, rather than a website ranking's snapshot. */
  itemsField?: "addedCards";
}

/**
 * The copies a list or a snapshot shows that are to go, by their path in our
 * bucket, with the catalogue address each was made from: the ones [files]
 * names (a file's own word), and the cards of [sources] whose attribution
 * keeps the address their copy was made from.
 */
export function copiesToUndo(pictures: ShownPictures, files: ReadonlyMap<string, CopyMeta>, sources: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>();
  const look = (url: unknown) => {
    const path = storedPathOf(url);
    const meta = path === null ? undefined : files.get(path);
    if (path !== null && meta?.originalUrl && meta.source && sources.has(meta.source)) found.set(path, meta.originalUrl);
  };
  for (const item of pictures.items) {
    look(item.imageUrl);
    const original = item.attribution?.originalUrl;
    const path = storedPathOf(item.imageUrl);
    if (path !== null && original && sources.has(item.attribution!.source) && isCopyOf(item.imageUrl!, original)) found.set(path, original);
  }
  look(pictures.coverImageUrl);
  pictures.previewImages.forEach(look);
  return found;
}

/** [pictures] showing the catalogue's own address again for each copy in [originals]; null when none of them is shown. */
export function withoutCopies<T extends ShownPictures>(pictures: T, originals: ReadonlyMap<string, string>): T | null {
  let changed = false;
  const back = (url: string | null): string | null => {
    const path = storedPathOf(url);
    const original = path === null ? undefined : originals.get(path);
    if (original === undefined) return url;
    changed = true;
    return original;
  };
  const items = pictures.items.map((item) => {
    const path = storedPathOf(item.imageUrl);
    const original = path === null ? undefined : originals.get(path);
    if (original === undefined) return item;
    changed = true;
    const { originalUrl: _copied, ...attribution } = item.attribution ?? ({} as PictureAttribution);
    return { ...item, imageUrl: original, ...(item.attribution ? { attribution } : {}) };
  });
  const coverImageUrl = back(pictures.coverImageUrl);
  const previewImages = pictures.previewImages.map((url) => back(url) ?? url);
  return changed ? { ...pictures, items, coverImageUrl, previewImages } : null;
}

/** What holds pictures: a published list, a ranking's snapshot, or a board kept in an account. */
export type PictureDoc = "list" | "ranking" | "board";

export function pictureDocOf(ref: DocumentReference): PictureDoc {
  return ref.parent.id === "rankings" ? "ranking" : ref.parent.id === "boards" ? "board" : "list";
}

/**
 * The pictures of a list, of a ranking (a website ranking's snapshot, or the
 * cards a signed-in reader added to theirs), or of a board (its collage as
 * `previewImages`).
 */
export function shownPictures(data: Record<string, unknown> | undefined, kind: PictureDoc): ShownPictures {
  if (kind === "ranking" && data?.snapshot === undefined && Array.isArray(data?.addedCards)) {
    return { items: data.addedCards as Card[], coverImageUrl: null, previewImages: [], itemsField: "addedCards" };
  }
  const from = (kind === "ranking" ? (data?.snapshot as Record<string, unknown> | undefined) : data) ?? {};
  const collage = kind === "board" ? from.coverImageUrls : from.previewImages;
  return {
    items: Array.isArray(from.items) ? (from.items as Card[]) : [],
    coverImageUrl: kind === "ranking" || typeof from.coverImageUrl !== "string" ? null : from.coverImageUrl,
    previewImages: kind === "ranking" || !Array.isArray(collage) ? [] : collage.filter((url): url is string => typeof url === "string"),
  };
}

/** The fields of a list, a ranking's snapshot or a board that hold [after]'s pictures where they differ from [before]. */
export function pictureFields(before: ShownPictures, after: ShownPictures, kind: PictureDoc): Record<string, unknown> {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (kind === "ranking") return same(before.items, after.items) ? {} : { [before.itemsField === "addedCards" ? "addedCards" : "snapshot.items"]: after.items };
  const fields: Record<string, unknown> = {};
  if (!same(before.items, after.items)) fields.items = after.items;
  if (before.coverImageUrl !== after.coverImageUrl) fields.coverImageUrl = after.coverImageUrl;
  if (!same(before.previewImages, after.previewImages)) fields[kind === "board" ? "coverImageUrls" : "previewImages"] = after.previewImages;
  return fields;
}

/** A list's or a ranking's folder of copies; boards share one. */
export function copyFolderOf(ref: DocumentReference): string {
  const kind = pictureDocOf(ref);
  return kind === "ranking" ? `published/ranking-${ref.id}/` : kind === "board" ? SHARED_COPIES : `published/${ref.id}/`;
}

/**
 * Applies [change] to a list, a ranking or a board as it is now, in a
 * transaction of its own: a list's revision moves; a board's never does (nor
 * its fingerprint), and a board that would not fit with the change, or that
 * was thrown away, is left as it is. Nothing is written when nothing changes.
 */
export async function rewritePictures(ref: DocumentReference, change: (pictures: ShownPictures) => ShownPictures | null): Promise<boolean> {
  const kind = pictureDocOf(ref);
  return getFirestore().runTransaction(async (transaction) => {
    const fresh = await transaction.get(ref);
    if (!fresh.exists || (kind === "board" && fresh.get("deleted") === true)) return false;
    const before = shownPictures(fresh.data(), kind);
    const after = change(before);
    if (after === null) return false;
    const fields = pictureFields(before, after, kind);
    if (Object.keys(fields).length === 0) return false;
    if (kind === "board" && !fitsWithCopies({ ...fresh.data(), ...fields })) return false;
    transaction.update(ref, kind === "list" ? { ...fields, ...nextRevision() } : fields);
    return true;
  });
}

/** Every copy path a list or a ranking shows. */
export function shownPaths(docs: readonly DocumentSnapshot[]): Set<string> {
  const paths = new Set<string>();
  for (const doc of docs) {
    const pictures = shownPictures(doc.data(), pictureDocOf(doc.ref));
    for (const url of [...pictures.items.map((item) => item.imageUrl), pictures.coverImageUrl, ...pictures.previewImages]) {
      const path = storedPathOf(url);
      if (path !== null) paths.add(path);
    }
  }
  return paths;
}

/** The catalogue pictures a list or a snapshot still shows that the switches want copied. */
export function stillToCopy(pictures: ShownPictures, switches: CopySwitches): string[] {
  const cards = pictures.items.flatMap((item) => (typeof item.imageUrl === "string" && wantsCopy(item.imageUrl, item.attribution ?? null, switches) ? [item.imageUrl] : []));
  return [...new Set([...cards, ...coverCopiesWanted([pictures.coverImageUrl, ...pictures.previewImages], switches)])];
}

const COPY_WINDOW_MS = 60_000;
const MAX_COPIES_PER_RUN = 2000;
const MAX_REFRESHES_PER_RUN = 2000;
/** A shared copy no board shows any more goes after this long: time enough for a board on its way to name it. */
const SHARED_UNSHOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Every document that shows pictures: published lists, ranking snapshots, and the boards accounts keep (not thrown away). */
export async function picturedDocs(): Promise<QueryDocumentSnapshot[]> {
  const db = getFirestore();
  const [lists, rankings, boards] = await Promise.all([db.collection("publishedLists").get(), db.collection("rankings").get(), db.collectionGroup("boards").get()]);
  return [...lists.docs, ...rankings.docs, ...boards.docs.filter((doc) => doc.get("deleted") !== true)];
}

/**
 * The daily upkeep, stopping at [untilMs]: copies still to make, copies due
 * to be fetched again, copies past their time undone, and shared copies no
 * board shows any more removed.
 */
export async function keepPictureCopies(nowMs: number, untilMs: number): Promise<Record<string, number>> {
  const bucket = getStorage().bucket();
  const switches = await copySwitches();
  const tools = catalogueCopyTools(realOutsideTools("catalogue-upkeep"));
  const summary = { copied: 0, docsCopied: 0, boardsCopied: 0, refreshed: 0, refreshFailed: 0, dropped: 0, docsUndone: 0, sharedRemoved: 0 };

  const docs = await picturedDocs();
  for (const doc of docs) {
    if (Date.now() > untilMs || summary.copied >= MAX_COPIES_PER_RUN) break;
    const board = pictureDocOf(doc.ref) === "board";
    const wanted = stillToCopy(shownPictures(doc.data(), pictureDocOf(doc.ref)), switches);
    if (wanted.length === 0) continue;
    const copies = board
      ? await copyToShared(wanted, tools, COPY_WINDOW_MS)
      : (await copyCataloguePictures(copyFolderOf(doc.ref), wanted, tools, { withinMs: COPY_WINDOW_MS })).copies;
    if (copies.size === 0) continue;
    summary.copied += copies.size;
    const written = await rewritePictures(doc.ref, (pictures) => withCatalogueCopies(pictures as ShownPictures & Parameters<typeof withCatalogueCopies>[0], copies)).catch((error) => {
      console.error(`Picture copies: ${doc.ref.path} not written: ${(error as Error).message}`);
      return false;
    });
    if (written) summary[board ? "boardsCopied" : "docsCopied"]++;
  }

  // Copies whose catalogue limits how long they are kept: fetched again, or undone.
  const [files] = await bucket.getFiles({ prefix: "published/" });
  const undo = new Map<string, string>();
  for (const file of files) {
    if (Date.now() > untilMs || summary.refreshed + summary.refreshFailed >= MAX_REFRESHES_PER_RUN) break;
    const meta = readCopyMeta(file.metadata.metadata as Record<string, unknown> | undefined, file.metadata.timeCreated as string | undefined);
    const due = copyAgeDue(meta, nowMs);
    if (due === "keep") continue;
    const from = copySourceOf(meta.originalUrl!);
    const fetched = from === null ? { error: "NOT_ALLOWED" } : await tools.fetch(meta.originalUrl!, AbortSignal.timeout(20_000)).catch(() => ({ error: "UNREACHABLE" }));
    if (!("error" in fetched)) {
      await file.save(fetched.bytes, { contentType: fetched.type, resumable: false, metadata: { metadata: copyMetaFor(meta.originalUrl!, Date.now()) } });
      summary.refreshed++;
      continue;
    }
    summary.refreshFailed++;
    if (due === "refresh-or-drop") undo.set(file.name, meta.originalUrl!);
  }
  for (const doc of undo.size > 0 ? docs : []) {
    const written = await rewritePictures(doc.ref, (pictures) => withoutCopies(pictures, undo)).catch(() => false);
    if (written) summary.docsUndone++;
  }
  if (Date.now() > untilMs) return summary;
  const still = shownPaths(await Promise.all(docs.map((doc) => doc.ref.get())));
  // Undone copies nothing shows now, and shared copies that no board has shown for a week.
  const sharedUnshown = files.filter((file) => file.name.startsWith(SHARED_COPIES) && !still.has(file.name) &&
    nowMs - (readCopyMeta(file.metadata.metadata as Record<string, unknown> | undefined, file.metadata.timeCreated as string | undefined).copiedAt ?? nowMs) > SHARED_UNSHOWN_MS);
  for (const path of undo.keys()) {
    if (still.has(path)) continue;
    await bucket.file(path).delete().catch(() => undefined);
    summary.dropped++;
  }
  for (const file of sharedUnshown) {
    if (undo.has(file.name)) continue;
    await file.delete().then(() => summary.sharedRemoved++, () => undefined);
  }
  return summary;
}
