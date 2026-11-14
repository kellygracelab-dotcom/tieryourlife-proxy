/**
 * Copies of catalogue pictures after they are made (`pictureCopies.ts`):
 * every copy's file says what it was copied from and when, in its custom
 * metadata `{originalUrl, source, copiedAt}`. Once a day `refreshPictures`
 * copies what a list or a ranking still shows from a catalogue switched on
 * (a catalogue that did not answer at publication is asked again), and fetches
 * again the copies of a catalogue whose terms limit how long a copy is kept
 * (TMDB, six months: again after 90 days). A copy still not fetched again at
 * 150 days is never simply undone, which would show the catalogue's address
 * blind, dead or alive: when its address answers 404 or 410 the catalogue is
 * asked for the card's id (`attribution.id`) and a picture it names now is
 * copied in its place, the card remembering the old address in
 * `attribution.formerUrls`; otherwise the copy stays and a `PICTURE_ALARM`
 * error is logged every day until someone looks (`pictureAlarms.ts`). A copy
 * nothing shows any more goes. The undoing, for a whole catalogue, is still
 * `npm run remove-picture-copies`, run by hand. Boards
 * kept in accounts are looked after too, from their shared copies
 * (`boardPictures.ts`), always in place: a board's revision and fingerprint
 * never move for its pictures.
 */
import { getFirestore, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { SHARED_COPIES, copyToShared, fitsWithCopies } from "./boardPictures";
import { probeVerdict } from "./catalogueRefresh";
import { catalogueCopyTools, copyCataloguePictures, coverCopiesWanted, withCatalogueCopies } from "./cataloguePictures";
import { nextRevision } from "./listRevision";
import { copyMetaFor, realOutsideTools, type OutsideTools } from "./outsidePictures";
import { writeAlarm } from "./pictureAlarms";
import {
  catalogueIdOf,
  catalogueSourceOf,
  copySourceOf,
  idFromAddress,
  isCopyOf,
  MAX_FORMER_URLS,
  type PictureAttribution,
} from "./pictureAttribution";
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

/**
 * What a copy's age asks of it: nothing, fetching again, or, past its
 * catalogue's limit, fetching again and, if that fails, finding the picture
 * again by its id (`afterFailedRefresh`).
 */
export function copyAgeDue(meta: CopyMeta, nowMs: number): "keep" | "refresh" | "refresh-or-rescue" {
  const limit = meta.source ? COPY_LIMITS[meta.source] : undefined;
  if (limit === undefined || meta.copiedAt === undefined || !meta.originalUrl) return "keep";
  const age = nowMs - meta.copiedAt;
  if (age >= limit.dropAfterMs) return "refresh-or-rescue";
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

/**
 * What a copy past its catalogue's limit does when it could not be fetched
 * again. The fetch was the look at its catalogue address; [status] is what that
 * address answers to a HEAD (or one byte) after it failed, not asked when the
 * catalogue said it was busy. Only an address that answers 404 or 410 is dead:
 * then the catalogue is asked for [id], the id a card showing the copy keeps.
 * Anything else (busy, no answer, a refusal, an answer that was no picture)
 * says nothing sure about the picture, and the copy is kept with the reason.
 */
export function afterFailedRefresh(error: string, status: number | null | undefined, id: string | null): { find: string } | { keep: string } {
  if (error === "SOURCE_BUSY") return { keep: "refresh failed: the catalogue is busy" };
  const answered = status === null || status === undefined ? "nothing" : String(status);
  const verdict = probeVerdict(status ?? null);
  if (verdict !== "dead") return { keep: `refresh failed (${error}); the address answers ${answered}` };
  return id === null ? { keep: `the address answers ${answered} and no card showing the copy has a catalogue id` } : { find: id };
}

/** What the catalogue's answer for [id] makes of a dead copy: the picture to copy in its place, or the copy kept, and why. */
export function foundAgain(id: string, found: string | null | undefined, original: string): { move: string } | { keep: string } {
  if (found === undefined) return { keep: `the address is dead and the catalogue could not be asked for ${id}` };
  if (found === null) return { keep: `the address is dead and the catalogue has no picture for ${id} any more` };
  if (found === original || copySourceOf(found) === copySourceOf(original)) return { keep: `the address is dead and the catalogue still names it for ${id}` };
  return { move: found };
}

/** The catalogue id a card showing the copy at [path] keeps, for its picture at [original]; null when none does. */
export function copyIdIn(pictures: ShownPictures, path: string, original: string): string | null {
  const source = catalogueSourceOf(original);
  if (source === null) return null;
  for (const item of pictures.items) {
    if (storedPathOf(item.imageUrl) !== path) continue;
    const id = idFromAddress(original, item.attribution?.link) ?? catalogueIdOf(source, item.attribution?.id);
    if (id !== null) return id;
  }
  return null;
}

/**
 * [pictures] showing [copy], the copy of the catalogue's picture now at
 * [original], wherever they showed the copy at [path]: each such card keeps the
 * address it was copied from before, [former], in `attribution.formerUrls`, as
 * `refreshPictures` does when it moves a card. Null when nothing showed it.
 */
export function withMovedCopy<T extends ShownPictures>(pictures: T, path: string, copy: string, original: string, former: string): T | null {
  let changed = false;
  const swap = (url: string | null): string | null => {
    if (storedPathOf(url) !== path) return url;
    changed = true;
    return copy;
  };
  const items = pictures.items.map((item) => {
    if (storedPathOf(item.imageUrl) !== path) return item;
    changed = true;
    const attribution: PictureAttribution = item.attribution ?? { source: catalogueSourceOf(original) ?? "web" };
    const kept = (attribution.formerUrls ?? []).filter((one) => one !== former && one !== original);
    return { ...item, imageUrl: copy, attribution: { ...attribution, originalUrl: original, formerUrls: [...kept, former].slice(-MAX_FORMER_URLS) } };
  });
  const coverImageUrl = swap(pictures.coverImageUrl);
  const previewImages = pictures.previewImages.map((url) => swap(url) ?? url);
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

/** How the upkeep looks at a catalogue address and asks a catalogue by id; `refreshPictures` hands it its own requests. */
export interface CopyRescue {
  /** The status [url] answers now (HEAD, or one byte), or null when it answers nothing in time. */
  probe(url: string): Promise<number | null>;
  /** [source]'s picture for [id] now: null when it has none, undefined when it could not be asked. */
  findById(source: string, id: string, url: string): Promise<string | null | undefined>;
}

/** Alarm lines one run writes one by one; the rest are counted in one more line. */
const MAX_ALARMS_PER_RUN = 20;

/**
 * The daily upkeep, stopping at [untilMs]: copies still to make, copies due
 * to be fetched again, copies past their time found again or kept with an
 * alarm, and copies nothing shows any more (shared ones after a week) removed.
 */
export async function keepPictureCopies(nowMs: number, untilMs: number, rescue: CopyRescue): Promise<Record<string, number>> {
  const bucket = getStorage().bucket();
  const switches = await copySwitches();
  const tools = catalogueCopyTools(realOutsideTools("catalogue-upkeep"));
  const summary = { copied: 0, docsCopied: 0, boardsCopied: 0, refreshed: 0, refreshFailed: 0, foundAgain: 0, docsFoundAgain: 0, keptPastLimit: 0, dropped: 0, sharedRemoved: 0 };

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

  // Copies whose catalogue limits how long they are kept: fetched again, and past the limit found again or kept.
  const [files] = await bucket.getFiles({ prefix: "published/" });
  const late: { path: string; meta: CopyMeta; error: string }[] = [];
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
    if (due === "refresh-or-rescue") late.push({ path: file.name, meta, error: fetched.error });
  }

  // Past the limit: a dead address's picture found again by its id, else the copy kept and an alarm raised.
  const showing = late.length > 0 ? docsShowing(docs) : new Map<string, QueryDocumentSnapshot[]>();
  const gone = new Set<string>();
  const unaskable = new Set<string>();
  const unwritten = new Set<string>();
  let alarms = 0;
  for (const { path, meta, error } of late) {
    if (Date.now() > untilMs) break;
    const shownBy = showing.get(path) ?? [];
    // Nothing shows it: no card turns into a catalogue address by its going.
    if (shownBy.length === 0) {
      gone.add(path);
      continue;
    }
    const kept = await rescueCopy(path, meta, error, shownBy, { rescue, tools, unaskable });
    if (typeof kept === "number") {
      summary.foundAgain++;
      summary.docsFoundAgain += kept;
      gone.add(path);
      continue;
    }
    summary.keptPastLimit++;
    if (alarms++ < MAX_ALARMS_PER_RUN) writeAlarm({ source: meta.source!, path, docs: shownBy.slice(0, 5).map((doc) => doc.ref.path), reason: kept });
    else unwritten.add(meta.source!);
  }
  if (alarms > MAX_ALARMS_PER_RUN) {
    writeAlarm({ source: [...unwritten].join(","), path: "", docs: [], reason: `${alarms - MAX_ALARMS_PER_RUN} more copies kept past their limit in this run` });
  }
  if (Date.now() > untilMs) return summary;
  const still = shownPaths(await Promise.all(docs.map((doc) => doc.ref.get())));
  // Copies past their limit nothing shows now, and shared copies that no board has shown for a week.
  const sharedUnshown = files.filter((file) => file.name.startsWith(SHARED_COPIES) && !still.has(file.name) &&
    nowMs - (readCopyMeta(file.metadata.metadata as Record<string, unknown> | undefined, file.metadata.timeCreated as string | undefined).copiedAt ?? nowMs) > SHARED_UNSHOWN_MS);
  for (const path of gone) {
    if (still.has(path)) continue;
    await bucket.file(path).delete().catch(() => undefined);
    summary.dropped++;
  }
  for (const file of sharedUnshown) {
    if (gone.has(file.name)) continue;
    await file.delete().then(() => summary.sharedRemoved++, () => undefined);
  }
  return summary;
}

/** Each copy path in our bucket, with the lists, rankings and boards that show it. */
function docsShowing(docs: readonly QueryDocumentSnapshot[]): Map<string, QueryDocumentSnapshot[]> {
  const showing = new Map<string, QueryDocumentSnapshot[]>();
  for (const doc of docs) {
    for (const path of shownPaths([doc])) showing.set(path, [...(showing.get(path) ?? []), doc]);
  }
  return showing;
}

/**
 * One copy past its limit that could not be fetched again: its address looked
 * at, and if it is dead its picture asked for by id and copied into the same
 * folder, every document showing the old copy moved to the new one. The number
 * of documents moved, or why the copy is kept. A catalogue that could not be
 * asked once is not asked again in the same run ([unaskable]).
 */
async function rescueCopy(
  path: string,
  meta: CopyMeta,
  error: string,
  shownBy: readonly QueryDocumentSnapshot[],
  { rescue, tools, unaskable }: { rescue: CopyRescue; tools: OutsideTools; unaskable: Set<string> },
): Promise<number | string> {
  const original = meta.originalUrl!;
  const source = meta.source!;
  const status = error === "SOURCE_BUSY" ? undefined : await rescue.probe(copySourceOf(original) ?? original).catch(() => null);
  const id = shownBy.map((doc) => copyIdIn(shownPictures(doc.data(), pictureDocOf(doc.ref)), path, original)).find((one) => one !== null) ?? null;
  const step = afterFailedRefresh(error, status, id);
  if ("keep" in step) return step.keep;
  if (unaskable.has(source)) return `the address is dead and ${source} could not be asked for ${step.find} in this run`;
  const found = await rescue.findById(source, step.find, original).catch(() => undefined);
  if (found === undefined) unaskable.add(source);
  const next = foundAgain(step.find, found, original);
  if ("keep" in next) return next.keep;
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const copy = (await copyCataloguePictures(folder, [next.move], tools, { withinMs: COPY_WINDOW_MS })).copies.get(next.move);
  if (copy === undefined) return `the address is dead and the picture ${source} names now for ${step.find} could not be copied`;
  let moved = 0;
  for (const doc of shownBy) {
    const written = await rewritePictures(doc.ref, (pictures) => withMovedCopy(pictures, path, copy, next.move, original)).catch((failure) => {
      console.error(`Picture copies: ${doc.ref.path} not moved to a new copy: ${(failure as Error).message}`);
      return false;
    });
    if (written) moved++;
  }
  if (moved > 0) return moved;
  // Nothing took the new copy: it goes, and the old one stays.
  const made = storedPathOf(copy);
  if (made !== null && made !== path) await getStorage().bucket().file(made).delete().catch(() => undefined);
  return `the address is dead and no list, ranking or board took the new copy of ${next.move}`;
}
