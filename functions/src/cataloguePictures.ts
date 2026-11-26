/**
 * A list's catalogue pictures at publish, and in the backfill of lists
 * published before: each card's attribution as fields, and a copy of ours for
 * each picture whose licence lets us keep one (`pictureAttribution.ts`). The
 * copy is the catalogue's own smaller picture, about 500 px, kept in the
 * list's folder under the name every copy of that address gets. The card's
 * `imageUrl` points at the copy, and its `attribution.originalUrl` keeps the
 * catalogue address. A picture not copied in time keeps its catalogue address;
 * the next publication copies it. The house's publications do not: they wait
 * until Commons has answered and every copy is made (`community.ts`).
 */
import { getStorage } from "firebase-admin/storage";
import { E2E_NOT_COPIED_PHOTO, isDemoEmulator, SAFE_VERDICT } from "./emulator";
import { copyOutside, outsideName, type FetchedPicture, type OutsideTools } from "./outsidePictures";
import {
  attributionOf,
  catalogueSourceOf,
  cleanAttribution,
  commonsDirectThumb,
  commonsFileOf,
  copyNameOf,
  copySourceOf,
  isCopyOf,
  manualOf,
  pageLink,
  withManual,
  type CommonsDetails,
  type ManualAttribution,
  type PictureAttribution,
} from "./pictureAttribution";
import { commonsDetails } from "./pictureCredit";
import { DEFAULT_COPY_SWITCHES, wantsCopy, type CopySwitches } from "./pictureCopies";
import { CatalogueRefusal, downloadPicture, getJson } from "./pictureSearch";
import { storageMediaUrl } from "./publicMedia";

/** A card as far as its picture goes. */
export interface CardPicture {
  imageUrl: string | null;
  credit?: string;
  /** What the client sent back of the card's attribution; `web` on a picture of its own folder that it says came from another site. */
  sent?: { link?: string; originalUrl?: string; web?: true; id?: string };
  /** The attribution the same picture had in the list's previous snapshot, if any. */
  previous?: PictureAttribution;
  /**
   * The house editor's credit for this card, decided (`manualAttribution.ts`), or
   * "cleared" when the editor took theirs off. Absent: the previous one stays.
   */
  manual?: ManualAttribution | "cleared";
}

/** The catalogue address a card's picture stands for: its own, or the one its copy was made from. */
export function originalOf(card: CardPicture): string | null {
  if (card.imageUrl === null) return null;
  if (catalogueSourceOf(card.imageUrl) !== null) return card.imageUrl;
  for (const claimed of [card.sent?.originalUrl, card.previous?.originalUrl]) {
    if (claimed && isCopyOf(card.imageUrl, claimed)) return claimed;
  }
  return null;
}

/** The Commons files whose details a list's attribution needs. */
export function commonsFilesOf(cards: readonly CardPicture[]): string[] {
  return [...new Set(cards.flatMap((card) => {
    const original = originalOf(card);
    const file = original === null ? null : commonsFileOf(original);
    return file === null ? [] : [file];
  }))];
}

/**
 * What Commons said about the files the list's last snapshot already showed with their licence:
 * an Update asks Commons only about the others (26.11.2026: every Commons card was asked again on
 * each Update, a second or more of a big list's). A card whose attribution was dropped for weight,
 * or that has no licence, is asked as before.
 */
export function commonsKnownBefore(cards: readonly CardPicture[]): Map<string, CommonsDetails> {
  const known = new Map<string, CommonsDetails>();
  for (const card of cards) {
    const before = card.previous;
    if (before?.source !== "wikimedia" || !before.license || !before.link) continue;
    const original = originalOf(card);
    const file = original === null ? null : commonsFileOf(original);
    if (file === null || known.has(file)) continue;
    known.set(file, {
      ...(before.author ? { author: before.author } : {}),
      license: before.license,
      ...(before.licenseUrl ? { licenseUrl: before.licenseUrl } : {}),
      link: before.link,
    });
  }
  return known;
}

/**
 * Each card's attribution: the catalogue's, worked out from its original
 * address, or `web` for a picture from another site and our copy of one.
 * A person's own photograph, and a card without art, have none.
 */
export function attributionsOf(cards: readonly CardPicture[], commons: ReadonlyMap<string, CommonsDetails>): (PictureAttribution | null)[] {
  return cards.map((card) => {
    const derived = derivedAttribution(card, commons);
    // The house editor's credit: the one sent now (also for an own photo, which has no address
    // until it is copied), or the one this picture had.
    const manual = card.manual === "cleared" ? null : card.manual ?? (card.imageUrl === null ? null : manualOf(card.previous));
    return manual === null ? derived : cleanAttribution(withManual(derived, manual));
  });
}

/** What the server works out itself for a card's picture. */
function derivedAttribution(card: CardPicture, commons: ReadonlyMap<string, CommonsDetails>): PictureAttribution | null {
  if (card.imageUrl === null) return card.sent?.web ? webAttribution(card) : null;
  const original = originalOf(card);
  if (original !== null) {
    const found = attributionOf(original, { credit: card.credit, sentLink: card.sent?.link ?? card.previous?.link, sentId: card.sent?.id ?? card.previous?.id, commons });
    if (found === null) return null;
    // Only the server moves a card to a catalogue's new address, and the snapshot remembers where it was.
    const formerUrls = card.previous?.formerUrls;
    return cleanAttribution({ ...found, ...(original === card.imageUrl ? {} : { originalUrl: original }), ...(formerUrls ? { formerUrls } : {}) });
  }
  const stored = storageMediaUrl(card.imageUrl);
  if (copyNameOf(stored) !== null || !stored.startsWith("https://firebasestorage.googleapis.com/")) return webAttribution(card);
  return card.sent?.web ? webAttribution(card) : null;
}

/**
 * A picture from another site, with the page it was found on: the one the
 * client sends, or, from a client that sends no attribution, the one the
 * same picture had before.
 */
function webAttribution(card: CardPicture): PictureAttribution {
  const link = card.sent ? pageLink(card.sent.link) : card.previous?.source === "web" ? card.previous.link : undefined;
  return link ? { source: "web", link } : { source: "web" };
}

/**
 * The first card a house publication may not carry: a picture from another
 * site, new to this list, without the page it was found on. Null when none.
 */
export function firstWithoutPage(cards: readonly CardPicture[], attributions: readonly (PictureAttribution | null)[]): number | null {
  const at = attributions.findIndex((one, index) => one?.source === "web" && !one.link && cards[index]?.previous === undefined);
  return at < 0 ? null : at;
}

/** The catalogue addresses to copy: on a card as they are, and with a licence that lets us keep them. */
export function copiesWanted(
  cards: readonly CardPicture[],
  attributions: readonly (PictureAttribution | null)[],
  switches: CopySwitches = DEFAULT_COPY_SWITCHES,
): string[] {
  return [...new Set(cards.flatMap((card, at) => (wantsCopy(card.imageUrl, attributions[at] ?? null, switches) ? [card.imageUrl!] : [])))];
}

/**
 * The cover's and the collage's catalogue pictures to copy as well: those of a
 * catalogue switched on that needs no licence read. A Commons file or an
 * iNaturalist photo there is copied when a card shows it.
 */
export function coverCopiesWanted(urls: readonly (string | null)[], switches: CopySwitches = DEFAULT_COPY_SWITCHES): string[] {
  return [...new Set(urls.filter((url): url is string => wantsCopy(url, null, switches)))];
}

const COMMONS_TITLES_PER_ASK = 50;

/** What Commons says about each file, by its Commons name; a file it says nothing about, or an answer that fails, is left out. */
export async function askCommons(files: readonly string[]): Promise<Map<string, CommonsDetails>> {
  return (await askCommonsFully(files)).found;
}

/**
 * As `askCommons`, and how many files could not be asked about because Commons
 * failed or was busy (`unasked`), with how long it asked us to wait when it said.
 */
export async function askCommonsFully(files: readonly string[]): Promise<{ found: Map<string, CommonsDetails>; unasked: number; retryAfterMs: number | null }> {
  const found = new Map<string, CommonsDetails>();
  let unasked = 0;
  let retryAfterMs: number | null = null;
  for (let at = 0; at < files.length; at += COMMONS_TITLES_PER_ASK) {
    const params = new URLSearchParams({
      action: "query",
      prop: "imageinfo",
      iiprop: "extmetadata",
      iiextmetadatafilter: "Artist|Credit|Attribution|LicenseShortName|LicenseUrl|UsageTerms",
      iiextmetadatalanguage: "en",
      titles: files.slice(at, at + COMMONS_TITLES_PER_ASK).map((file) => `File:${file}`).join("|"),
      format: "json",
    });
    try {
      const body = (await getJson(`https://commons.wikimedia.org/w/api.php?${params}`)) as { query?: { pages?: Record<string, { title?: unknown; imageinfo?: unknown[] }> } };
      for (const page of Object.values(body?.query?.pages ?? {})) {
        const title = typeof page.title === "string" ? page.title.replace(/^File:/, "") : null;
        const details = title === null ? undefined : commonsDetails(page, page.imageinfo?.[0]);
        if (title !== null && details) found.set(title.charAt(0).toUpperCase() + title.slice(1), details);
      }
    } catch (error) {
      // Without Commons' word a file is credited by its page alone and not copied.
      const asked = files.slice(at, at + COMMONS_TITLES_PER_ASK).length;
      unasked += asked;
      const seconds = error instanceof CatalogueRefusal ? Number(error.retryAfter) : NaN;
      if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.max(retryAfterMs ?? 0, seconds * 1000);
      console.warn(`Commons not asked about ${asked} files: ${(error as Error).message}`);
    }
  }
  return { found, unasked, retryAfterMs };
}

/**
 * One folder of catalogue copies shared by everybody, `published/catalogue/`,
 * each named by its catalogue address (`outsideName`): the boards' copies
 * (`boardPictures.ts`), and the copies a house publication made in an attempt
 * that did not go through, kept for the next. One that no board shows is
 * removed by the daily upkeep after a week (`pictureCopyUpkeep.ts`).
 */
export const SHARED_COPIES = "published/catalogue/";

/** The shared folder as copying uses it, so a test can hand it another. */
export interface SharedCopies {
  /** The picture kept under [name], or null when there is none. */
  read(name: string): Promise<{ bytes: Buffer; type: string } | null>;
  /** Moves the file at [path] to [name] in the shared folder; when one is there already, [path] is only removed. */
  keep(path: string, name: string): Promise<void>;
}

export function storageShared(): SharedCopies {
  const bucket = () => getStorage().bucket();
  return {
    read: async (name) => {
      const file = bucket().file(SHARED_COPIES + name);
      const [there] = await file.exists();
      if (!there) return null;
      const [[bytes], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
      return { bytes, type: String(meta.contentType ?? "") };
    },
    keep: async (path, name) => {
      const [there] = await bucket().file(SHARED_COPIES + name).exists();
      if (there) await bucket().file(path).delete();
      else await bucket().file(path).move(SHARED_COPIES + name);
    },
  };
}

/** Wikimedia's pictures copied at once by one publication: a burst of 16 got 429s (15.11.2026). */
export const WIKIMEDIA_AT_ONCE = 4;
/** The first wait after a 429 that names no time; each next one twice as long, up to the last. */
const WIKIMEDIA_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
/** The catalogues whose licence lets a copy be kept without a time limit, so one made earlier serves as well as a new one. */
const OPENLY_LICENSED: ReadonlySet<string> = new Set(["wikimedia", "inaturalist"]);
const WIKIMEDIA_HOSTS: ReadonlySet<string> =new Set(["commons.wikimedia.org", "upload.wikimedia.org", "thumb.wikimedia.org"]);

/** At most [atOnce] of the jobs run at a time; the others wait their turn. */
export function oneAtATime(atOnce: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (running >= atOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** Waits [ms]; false as soon as [stop] says the time is up. */
function pause(ms: number, stop: AbortSignal): Promise<boolean> {
  if (stop.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (waited: boolean) => {
      clearTimeout(timer);
      stop.removeEventListener("abort", aborted);
      resolve(waited);
    };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(true), Math.max(0, ms));
    stop.addEventListener("abort", aborted, { once: true });
  });
}

export type Download = (url: URL, stop: AbortSignal) => Promise<FetchedPicture & { retryAtMs?: number }>;

/** Where a catalogue picture is copied from: Commons at its 500 px thumbnail directly, then through `Special:FilePath`. */
export function copySourcesOf(original: string): string[] {
  const from = copySourceOf(original);
  if (from === null) return [];
  const file = commonsFileOf(original);
  const direct = file === null ? null : commonsDirectThumb(file, 500);
  return direct === null ? [from] : [direct, from];
}

/**
 * Copying as for pictures from other sites, but from the catalogue's smaller
 * picture, without SafeSearch (catalogue art was shown as it is before) and
 * outside the person's daily count of pictures from other sites.
 *
 * A copy already in the shared folder is taken from there, and Wikimedia is
 * asked [WIKIMEDIA_AT_ONCE] pictures at a time: a 429 is waited out (its
 * Retry-After, or else one, two, four, eight seconds) while the window lasts.
 */
export function catalogueCopyTools(
  base: OutsideTools,
  { shared = storageShared(), download = downloadPicture as Download }: { shared?: SharedCopies; download?: Download } = {},
): OutsideTools {
  const wikimedia = oneAtATime(WIKIMEDIA_AT_ONCE);
  const politely = (source: string, stop: AbortSignal) => wikimedia(async () => {
    for (let tries = 0; ; tries++) {
      const got = await download(new URL(source), stop);
      if (!("error" in got) || got.error !== "SOURCE_BUSY") return got;
      const backoff = WIKIMEDIA_BACKOFF_MS[Math.min(tries, WIKIMEDIA_BACKOFF_MS.length - 1)]!;
      if (!(await pause(Math.max(backoff, (got.retryAtMs ?? 0) - Date.now()), stop))) return got;
    }
  });
  return {
    ...base,
    fetch: async (url, stop) => {
      if (isDemoEmulator()) return url === E2E_NOT_COPIED_PHOTO ? { error: "UNREACHABLE" } : base.fetch(url, stop);
      const sources = copySourcesOf(url);
      if (sources.length === 0) return { error: "NOT_ALLOWED" };
      // Only an openly licensed picture is taken from a copy made before: a TMDB copy's days are counted from its own fetch.
      const kept = OPENLY_LICENSED.has(catalogueSourceOf(url) ?? "") ? await shared.read(outsideName(url)).catch(() => null) : null;
      if (kept !== null) return kept;
      let got: FetchedPicture = { error: "UNREACHABLE" };
      for (const source of sources) {
        got = WIKIMEDIA_HOSTS.has(new URL(source).hostname) ? await politely(source, stop) : await download(new URL(source), stop);
        // A busy Wikimedia is busy by either way in; only a picture not found one way is looked for the other.
        if (!("error" in got) || got.error === "SOURCE_BUSY" || stop.aborted) return got;
      }
      return got;
    },
    lookAt: async () => SAFE_VERDICT,
    reserve: async () => true,
    giveBack: async () => undefined,
  };
}

/**
 * The copies a house publication made in an attempt that did not go through,
 * moved to the shared folder for the next attempt, which takes them from there
 * instead of asking the catalogue again. A file that cannot be moved is removed.
 */
export async function keepCopiesForLater(saved: readonly string[], shared: SharedCopies = storageShared(), remove: (path: string) => Promise<void> = (path) => getStorage().bucket().file(path).delete().then(() => undefined)): Promise<void> {
  await Promise.all(saved.map(async (path) => {
    const name = /\/(w-[0-9a-f]{32})(?:_p_[a-f0-9-]{36})?$/.exec(path)?.[1];
    if (name !== undefined && await shared.keep(path, name).then(() => true, () => false)) return;
    await remove(path).catch(() => undefined);
  }));
}

// Open Library takes a few seconds a cover from here: a house list of 33 books did not fit 15 s eight at a time (14.11.2026).
const CATALOGUE_COPYING_AT_ONCE = 16;
const CATALOGUE_WINDOW_MS = 15_000;

/** The copies made, by catalogue address; one not made is not there. `saved` are the files this attempt wrote. */
export async function copyCataloguePictures(
  folder: string,
  urls: readonly string[],
  tools: OutsideTools,
  options: { nameSuffix?: string; committed?: ReadonlyMap<string, string>; withinMs?: number } = {},
): Promise<{ copies: Map<string, string>; saved: string[] }> {
  if (urls.length === 0) return { copies: new Map(), saved: [] };
  const done = await copyOutside(folder, urls, tools, {
    atOnce: CATALOGUE_COPYING_AT_ONCE,
    withinMs: options.withinMs ?? CATALOGUE_WINDOW_MS,
    nameSuffix: options.nameSuffix,
    committed: options.committed,
  });
  if (!done.ok) return { copies: new Map(), saved: [] };
  const copies = new Map([...done.copies].filter((entry): entry is [string, string] => entry[1] !== null));
  return { copies, saved: done.saved };
}

interface Pictured {
  items: { imageUrl: string | null; attribution?: PictureAttribution }[];
  coverImageUrl: string | null;
  previewImages: string[];
}

/** The list pointing at the copies made, each copied card remembering its catalogue address. */
export function withCatalogueCopies<T extends Pictured>(list: T, copies: ReadonlyMap<string, string>): T {
  const swap = (url: string | null): string | null => (url !== null ? copies.get(url) ?? url : null);
  return {
    ...list,
    items: list.items.map((item) => {
      const copy = item.imageUrl === null ? undefined : copies.get(item.imageUrl);
      if (copy === undefined || item.imageUrl === null) return item;
      // The catalogue address is kept with the copy, under the catalogue's name when the card had no credit.
      const source = catalogueSourceOf(item.imageUrl);
      const attribution = item.attribution
        ? { ...item.attribution, originalUrl: item.imageUrl }
        : source !== null ? { source, originalUrl: item.imageUrl } : undefined;
      return { ...item, imageUrl: copy, ...(attribution ? { attribution } : {}) };
    }),
    coverImageUrl: swap(list.coverImageUrl),
    previewImages: list.previewImages.map((url) => swap(url) ?? url),
  };
}

/** The attribution each picture had in a stored list, by its address in our bucket's form and by its catalogue address. */
export function attributionsByPicture(items: unknown): Map<string, PictureAttribution> {
  const found = new Map<string, PictureAttribution>();
  for (const item of Array.isArray(items) ? items : []) {
    const { imageUrl, attribution } = (item ?? {}) as { imageUrl?: unknown; attribution?: unknown };
    if (typeof imageUrl !== "string" || attribution === null || typeof attribution !== "object") continue;
    const source = (attribution as { source?: unknown }).source;
    if (typeof source !== "string") continue;
    found.set(storageMediaUrl(imageUrl), attribution as PictureAttribution);
    const original = (attribution as { originalUrl?: unknown }).originalUrl;
    if (typeof original === "string") found.set(original, attribution as PictureAttribution);
  }
  return found;
}
