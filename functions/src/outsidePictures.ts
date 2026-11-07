/**
 * Pictures from other sites, on a published list or on an author's face.
 * Catalogue art is shown where the catalogue keeps it. Anything else is
 * fetched once, looked at by SafeSearch and shown from a copy of ours, so a
 * reader's browser never asks a stranger's server for it.
 */
import { createHash } from "node:crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { isDemoEmulator, STUB_PICTURE } from "./emulator";
import { pictureTypeOf } from "./pictureBytes";
import { downloadPicture } from "./pictureSearch";
import { addressOf, foreignCopyOf, safeSearchOrNothing } from "./publishedPictures";
import { dayKey } from "./quota";
import { decideSafe, type SafeSearchVerdict, type SafetyRefusal } from "./safety";

/**
 * Where the catalogues the app and the site search keep their art
 * (`pictureSources.ts`, the app's TMDB and Wikidata, the site's share cards).
 * Exact hosts: a lookalike or another subdomain is copied like any other site.
 */
export const CATALOGUE_HOSTS: ReadonlySet<string> = new Set([
  "image.tmdb.org",
  "s4.anilist.co",
  "images.igdb.com",
  "shared.akamai.steamstatic.com",
  "cdn-images.dzcdn.net",
  "e-cdns-images.dzcdn.net",
  "covers.openlibrary.org",
  "inaturalist-open-data.s3.amazonaws.com",
  "static.inaturalist.org",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
]);

/** Where Google keeps the photo of a Google account. */
export const ACCOUNT_PHOTO_HOSTS: ReadonlySet<string> = new Set(["lh3.googleusercontent.com"]);

/** Distinct pictures from other sites one list may bring, like `MAX_OWN_PICTURES_PER_LIST`. */
export const MAX_OUTSIDE_PICTURES_PER_LIST = 200;
/** Fetches of other sites' pictures per account per UTC day, faces included; reused copies cost nothing. */
export const OUTSIDE_PICTURES_PER_DAY = 400;
const FETCHING_AT_ONCE = 8;
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

export function isCatalogueAddress(url: string): boolean {
  const host = hostOf(url);
  return host !== null && CATALOGUE_HOSTS.has(host);
}

/** A file directly in [folder] of our own bucket, by the address `addressOf` gives it. */
export function isOurCopy(url: string, bucket: string, folder: string): boolean {
  const prefix = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(folder)}`;
  if (!url.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]+$/.test(url.slice(prefix.length).split(/[?#]/)[0] ?? "");
}

/** The file a picture from [url] is kept under: the same address always lands on the same copy. */
export function outsideName(url: string): string {
  return `w-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

interface PictureAddresses {
  items: { imageUrl: string | null }[];
  coverImageUrl: string | null;
  previewImages: string[];
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
  save(path: string, bytes: Buffer, type: string): Promise<void>;
  remove(path: string): Promise<void>;
  fetch(url: string, stop: AbortSignal): Promise<FetchedPicture>;
  lookAt(bytes: Buffer): Promise<SafeSearchVerdict | null>;
  /** Takes [count] fetches from the account's day; false, taking none, when fewer are left. */
  reserve(count: number): Promise<boolean>;
  giveBack(count: number): Promise<void>;
}

export type OutsideCopies =
  | { ok: true; copies: Map<string, string | null>; saved: string[] }
  | { ok: false; refused: { url: string; because: SafetyRefusal } }
  | { ok: false; overDailyLimit: true };

/**
 * Copies each address into [folder] once it has passed SafeSearch. One that
 * cannot be fetched, is not a JPEG, PNG, GIF or WebP, or that Vision says
 * nothing about, copies to null. One Vision refuses refuses them all, and
 * whatever this call saved is removed again.
 */
export async function copyOutside(
  folder: string,
  urls: readonly string[],
  tools: OutsideTools,
  { atOnce = FETCHING_AT_ONCE, withinMs = LIST_WINDOW_MS, until }: { atOnce?: number; withinMs?: number; until?: AbortSignal } = {},
): Promise<OutsideCopies> {
  const copies = new Map<string, string | null>();
  if (urls.length === 0) return { ok: true, copies, saved: [] };
  const here = await tools.namesIn(folder);
  const fresh: string[] = [];
  for (const url of urls) {
    if (here.has(outsideName(url))) copies.set(url, addressOf(tools.bucket, folder + outsideName(url)));
    else fresh.push(url);
  }
  if (fresh.length === 0) return { ok: true, copies, saved: [] };
  if (!(await tools.reserve(fresh.length))) return { ok: false, overDailyLimit: true };

  const stop = until ?? AbortSignal.timeout(withinMs);
  const saved: string[] = [];
  const state: { refused: { url: string; because: SafetyRefusal } | null } = { refused: null };
  let next = 0;

  const copyOne = async (url: string): Promise<string | null> => {
    const fetched = await tools.fetch(url, stop).catch((): FetchedPicture => ({ error: "UNREACHABLE" }));
    if ("error" in fetched) return null;
    const type = pictureTypeOf(fetched.bytes);
    if (type === null || stop.aborted || state.refused !== null) return null;
    const verdict = await tools.lookAt(fetched.bytes).catch(() => null);
    if (verdict === null) return null;
    const decision = decideSafe(verdict);
    if (!decision.ok) {
      state.refused ??= { url, because: decision.because };
      return null;
    }
    const path = folder + outsideName(url);
    try {
      await tools.save(path, fetched.bytes, type);
    } catch {
      return null;
    }
    saved.push(path);
    return addressOf(tools.bucket, path);
  };

  const worker = async (): Promise<void> => {
    while (state.refused === null && !stop.aborted && next < fresh.length) {
      const url = fresh[next++] as string;
      copies.set(url, await copyOne(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, fresh.length) }, worker));

  const neverTried = fresh.length - next;
  if (neverTried > 0) await tools.giveBack(neverTried).catch(() => undefined);
  if (state.refused !== null) {
    await Promise.all(saved.map((path) => tools.remove(path).catch(() => undefined)));
    return { ok: false, refused: state.refused };
  }
  for (const url of fresh) if (!copies.has(url)) copies.set(url, null);
  return { ok: true, copies, saved };
}

/**
 * The face an author is shown with: a Google account photo or a copy in their
 * own `avatars/` stays as it is; any other picture is copied there and looked
 * at, and one that cannot be is no face at all.
 */
export async function checkedFace(uid: string, url: string | null, tools: OutsideTools): Promise<string | null> {
  if (url === null) return null;
  const host = hostOf(url);
  if (host === null) return null;
  const folder = `avatars/${uid}/`;
  if (ACCOUNT_PHOTO_HOSTS.has(host) || isOurCopy(url, tools.bucket, folder)) return url;
  const done = await copyOutside(folder, [url], tools, { atOnce: 1, withinMs: FACE_WINDOW_MS });
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
    save: async (path, bytes, type) => {
      await bucket.file(path).save(bytes, { contentType: type, resumable: false });
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
