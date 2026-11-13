/**
 * Pictures from other sites, on a published list or on an author's face.
 * Catalogue art is shown where the catalogue keeps it. Anything else is
 * fetched once, looked at by SafeSearch and shown from a copy of ours, so a
 * reader's browser never asks a stranger's server for it.
 */
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { storageMediaUrl } from "./publicMedia";
import { isDemoEmulator, STUB_PICTURE } from "./emulator";
import { isAnimated, pictureTypeOf } from "./pictureBytes";
import { CATALOGUE_HOSTS, catalogueSourceOf, outsideName } from "./pictureAttribution";
import { downloadPicture } from "./pictureSearch";
import { addressOf, foreignCopyOf, safeSearchOrNothing } from "./publishedPictures";
import { dayKey } from "./quota";
import { decideSafe, type SafeSearchVerdict, type SafetyRefusal } from "./safety";

// Kept beside each catalogue's attribution; still exported from here.
export { CATALOGUE_HOSTS, outsideName };

/** A Google account's photo: on this host Drive, Photos and Blogger serve other paths, anybody's pictures. */
export function isAccountPhoto(url: string): boolean {
  try {
    const parsed = new URL(url);
    return hostOf(url) === "lh3.googleusercontent.com" && /^\/a-?\/./.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Distinct pictures from other sites one list may bring, like `MAX_OWN_PICTURES_PER_LIST`. */
export const MAX_OUTSIDE_PICTURES_PER_LIST = 200;
/** Fetches of other sites' pictures per account per UTC day, faces included; reused copies cost nothing. */
export const OUTSIDE_PICTURES_PER_DAY = 400;
/** DNS lookups run on libuv's pool of four threads; more at once only queue there. */
const FETCHING_AT_ONCE = 4;
const LIST_WINDOW_MS = 12_000;
const FACE_WINDOW_MS = 6_000;

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.port === "" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** A catalogue's own address, kept as it is; Wikipedia's local uploads are not one (`catalogueSourceOf`). */
export function isCatalogueAddress(url: string): boolean {
  return catalogueSourceOf(url) !== null;
}

/** A file directly in [folder] of our own bucket, by the address `addressOf` gives it. */
export function isOurCopy(url: string, bucket: string, folder: string): boolean {
  url = storageMediaUrl(url);
  const prefix = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(folder)}`;
  if (!url.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]+$/.test(url.slice(prefix.length).split(/[?#]/)[0] ?? "");
}

interface PictureAddresses {
  items: { imageUrl: string | null }[];
  coverImageUrl: string | null;
  previewImages: string[];
}

/** Reuse only names referenced by the committed snapshot, never another attempt's pending files. */
export function committedOutsideCopies(list: PictureAddresses, urls: readonly string[], folder: string, bucket: string): Map<string, string> {
  const held = [...list.items.map((item) => item.imageUrl), list.coverImageUrl, ...list.previewImages]
    .filter((url): url is string => url !== null && isOurCopy(url, bucket, folder))
    .map(storageMediaUrl);
  const copies = new Map<string, string>();
  for (const url of urls) {
    const stem = addressOf(bucket, folder + outsideName(url)).split("?")[0];
    const existing = held.find((address) => {
      const path = address.split(/[?#]/)[0];
      return path === stem || (path.startsWith(stem + "_p_") && /^_p_[a-f0-9-]{36}$/.test(path.slice(stem.length)));
    });
    if (existing) copies.set(url, existing);
  }
  return copies;
}

/**
 * The addresses of a list that must be fetched and looked at: not catalogue
 * art, not already this list's copy, and not another list's copy, which
 * `adoptForeignCopies` takes from our own bucket.
 */
export function outsideAddressesIn(list: PictureAddresses, listId: string, bucket: string): string[] {
  const urls = [...list.items.map((item) => item.imageUrl), list.coverImageUrl, ...list.previewImages];
  return [...new Set(urls.filter((url): url is string =>
    url !== null &&
    !isCatalogueAddress(url) &&
    !isOurCopy(url, bucket, `published/${listId}/`) &&
    foreignCopyOf(listId, url) === null))];
}

/** The list pointing at the copies; an address copied to null leaves its card without art. */
export function withCopies<T extends PictureAddresses>(list: T, copies: ReadonlyMap<string, string | null>): T {
  const swap = (url: string | null): string | null => (url !== null && copies.has(url) ? copies.get(url) ?? null : url);
  return {
    ...list,
    items: list.items.map((item) => ({ ...item, imageUrl: swap(item.imageUrl) })),
    coverImageUrl: swap(list.coverImageUrl),
    previewImages: list.previewImages.map(swap).filter((url): url is string => url !== null),
  };
}

export type FetchedPicture = { bytes: Buffer; type: string } | { error: string };

/** What copying needs from the world, so a test can hand it another. */
export interface OutsideTools {
  bucket: string;
  namesIn(folder: string): Promise<Set<string>>;
  /** [meta]: the file's custom metadata, what it was copied from and when (`copyMetaFor`). */
  save(path: string, bytes: Buffer, type: string, meta?: Record<string, string>): Promise<void>;
  remove(path: string): Promise<void>;
  fetch(url: string, stop: AbortSignal): Promise<FetchedPicture>;
  lookAt(bytes: Buffer): Promise<SafeSearchVerdict | null>;
  /** Takes [count] fetches from the account's day; false, taking none, when fewer are left. */
  reserve(count: number): Promise<boolean>;
  giveBack(count: number): Promise<void>;
}

type Copied = { ok: true; copies: Map<string, string | null>; saved: string[] };

export type OutsideCopies =
  /** `dropped`: how many of the addresses copied to null. */
  | (Copied & { dropped: number })
  | { ok: false; refused: { url: string; because: SafetyRefusal } }
  | { ok: false; overDailyLimit: true };

/**
 * Copies each address into [folder] once it has passed SafeSearch. One that
 * cannot be fetched, is not a JPEG, PNG, GIF or WebP, is animated, or that
 * Vision says nothing about, copies to null, and so does every one not done
 * when [until] or [withinMs] runs out: the answer never waits past it. One
 * Vision refuses refuses them all, and whatever this call saved is removed.
 */
/** The custom metadata a copy of [url] is saved with: what it was copied from, and when (`pictureCopyUpkeep.ts`). */
export function copyMetaFor(url: string, nowMs: number): Record<string, string> {
  return { originalUrl: url, source: catalogueSourceOf(url) ?? "web", copiedAt: String(nowMs) };
}

export async function copyOutside(
  folder: string,
  urls: readonly string[],
  tools: OutsideTools,
  { atOnce = FETCHING_AT_ONCE, withinMs = LIST_WINDOW_MS, until, nameSuffix = "", committed = new Map<string, string>() }: { atOnce?: number; withinMs?: number; until?: AbortSignal; nameSuffix?: string; committed?: ReadonlyMap<string, string> } = {},
): Promise<OutsideCopies> {
  if (urls.length === 0) return { ok: true, copies: new Map(), saved: [], dropped: 0 };
  const stop = until ?? AbortSignal.timeout(withinMs);
  const run: Run = { copies: new Map(urls.flatMap((url) => committed.has(url) ? [[url, committed.get(url)!] as [string, string]] : [])), saved: [], refused: null, fresh: [], next: 0, reserved: false, late: false, nameSuffix };
  const timeUp = new Promise<"late">((resolve) => {
    if (stop.aborted) resolve("late");
    else stop.addEventListener("abort", () => resolve("late"), { once: true });
  });
  const finished = await Promise.race([copyWithin(folder, urls, tools, atOnce, stop, run), timeUp]);
  if (finished !== "late") return finished.ok ? counted(finished) : finished;

  run.late = true;
  const neverTried = run.fresh.length - run.next;
  if (run.reserved && neverTried > 0) void tools.giveBack(neverTried).catch(() => undefined);
  if (run.refused !== null) {
    for (const path of run.saved) void tools.remove(path).catch(() => undefined);
    return { ok: false, refused: run.refused };
  }
  const copies = new Map(urls.map((url) => [url, run.copies.get(url) ?? null]));
  return counted({ ok: true, copies, saved: [...run.saved] });
}

function counted(done: Copied): OutsideCopies {
  return { ...done, dropped: [...done.copies.values()].filter((address) => address === null).length };
}

interface Run {
  nameSuffix: string;
  copies: Map<string, string | null>;
  saved: string[];
  refused: { url: string; because: SafetyRefusal } | null;
  fresh: string[];
  next: number;
  reserved: boolean;
  /** The deadline answered for this run: whatever is still going on keeps nothing. */
  late: boolean;
}

async function copyWithin(
  folder: string,
  urls: readonly string[],
  tools: OutsideTools,
  atOnce: number,
  stop: AbortSignal,
  run: Run,
): Promise<Copied | Exclude<OutsideCopies, { ok: true }>> {
  const here = await tools.namesIn(folder);
  for (const url of urls) {
    if (run.copies.has(url)) continue;
    if (here.has(outsideName(url) + run.nameSuffix)) run.copies.set(url, addressOf(tools.bucket, folder + outsideName(url) + run.nameSuffix));
    else run.fresh.push(url);
  }
  if (run.fresh.length === 0) return { ok: true, copies: run.copies, saved: [] };
  if (!(await tools.reserve(run.fresh.length))) return { ok: false, overDailyLimit: true };
  if (run.late) {
    await tools.giveBack(run.fresh.length).catch(() => undefined);
    return { ok: true, copies: run.copies, saved: [] };
  }
  run.reserved = true;

  const copyOne = async (url: string): Promise<string | null> => {
    const fetched = await tools.fetch(url, stop).catch((): FetchedPicture => ({ error: "UNREACHABLE" }));
    if ("error" in fetched) return null;
    const type = pictureTypeOf(fetched.bytes);
    if (type === null || isAnimated(fetched.bytes) || stop.aborted || run.refused !== null) return null;
    const verdict = await tools.lookAt(fetched.bytes).catch(() => null);
    if (verdict === null || stop.aborted) return null;
    const decision = decideSafe(verdict);
    if (!decision.ok) {
      run.refused ??= { url, because: decision.because };
      return null;
    }
    const path = folder + outsideName(url) + run.nameSuffix;
    try {
      await tools.save(path, fetched.bytes, type, copyMetaFor(url, Date.now()));
    } catch {
      return null;
    }
    if (run.late) {
      await tools.remove(path).catch(() => undefined);
      return null;
    }
    run.saved.push(path);
    return addressOf(tools.bucket, path);
  };

  const worker = async (): Promise<void> => {
    while (run.refused === null && !stop.aborted && run.next < run.fresh.length) {
      const url = run.fresh[run.next++] as string;
      run.copies.set(url, await copyOne(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, run.fresh.length) }, worker));
  if (run.late) return { ok: true, copies: run.copies, saved: [] };

  const neverTried = run.fresh.length - run.next;
  if (neverTried > 0) await tools.giveBack(neverTried).catch(() => undefined);
  if (run.refused !== null) {
    await Promise.all(run.saved.map((path) => tools.remove(path).catch(() => undefined)));
    return { ok: false, refused: run.refused };
  }
  for (const url of run.fresh) if (!run.copies.has(url)) run.copies.set(url, null);
  return { ok: true, copies: run.copies, saved: run.saved };
}

/** Runs [publish]; unless it answers what it wrote, the copies [saved] are removed, whether it answered or threw. */
export async function removeUnlessWritten<T>(
  saved: readonly string[],
  remove: (path: string) => Promise<void>,
  publish: () => Promise<T | null>,
): Promise<T | null> {
  let written: T | null = null;
  try {
    written = await publish();
    return written;
  } finally {
    if (written === null) await Promise.all(saved.map((path) => remove(path).catch(() => undefined)));
  }
}

/**
 * The face an author is shown with: a Google account photo or a copy in their
 * own `avatars/` stays as it is; any other picture is copied there and looked
 * at, and one that cannot be is no face at all.
 */
export async function checkedFace(
  uid: string,
  url: string | null,
  tools: OutsideTools,
  { until }: { until?: AbortSignal } = {},
): Promise<string | null> {
  if (url === null) return null;
  url = storageMediaUrl(url);
  const host = hostOf(url);
  if (host === null) return null;
  const folder = `avatars/${uid}/`;
  if (isAccountPhoto(url) || isOurCopy(url, tools.bucket, folder)) return url;
  const done = await copyOutside(folder, [url], tools, { atOnce: 1, withinMs: FACE_WINDOW_MS, until });
  return done.ok ? done.copies.get(url) ?? null : null;
}

async function fetchOutside(url: string, stop: AbortSignal): Promise<FetchedPicture> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "BAD_URL" };
  }
  return downloadPicture(parsed, stop);
}

export function realOutsideTools(uid: string): OutsideTools {
  const bucket = getStorage().bucket();
  const db = getFirestore();
  const usage = db.doc(`pictureWeb/${dayKey(Date.now())}/outside/${uid}`);
  return {
    bucket: bucket.name,
    namesIn: async (folder) => {
      const [files] = await bucket.getFiles({ prefix: folder });
      return new Set(files.map((file) => file.name.slice(folder.length)));
    },
    save: async (path, bytes, type, meta) => {
      await bucket.file(path).save(bytes, { contentType: type, resumable: false, ...(meta ? { metadata: { metadata: meta } } : {}) });
    },
    remove: async (path) => {
      await bucket.file(path).delete();
    },
    fetch: (url, stop) => (isDemoEmulator() ? Promise.resolve({ bytes: STUB_PICTURE, type: "image/png" }) : fetchOutside(url, stop)),
    lookAt: async (bytes) => (await safeSearchOrNothing([bytes]))[0] ?? null,
    reserve: (count) =>
      db.runTransaction(async (transaction) => {
        const used = ((await transaction.get(usage)).get("count") as number | undefined) ?? 0;
        if (used + count > OUTSIDE_PICTURES_PER_DAY) return false;
        transaction.set(usage, { count: used + count }, { merge: true });
        return true;
      }),
    giveBack: async (count) => {
      await usage.set({ count: FieldValue.increment(-count) }, { merge: true });
    },
  };
}
