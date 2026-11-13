/**
 * Keeping catalogue pictures alive and fresh (`refreshPictures.ts`), the parts
 * that decide: which addresses a run looks at, what each catalogue answers
 * about an id, and a list moved from a dead or replaced address to the new one.
 *
 * - IGDB's covers are asked again every day: the Twitch developer agreement
 *   lets data be kept for 24 hours without IGDB's written authorization.
 * - TMDB's are asked again every 90 days: its terms (§1.C) allow nothing
 *   obtained from TMDB to be kept longer than six months.
 * - Every other catalogue address is looked at once a week. One that answers
 *   404 or 410 is looked up by its catalogue id and moved to the new address.
 *
 * A moved card keeps where it was in `attribution.formerUrls`: nothing is
 * deleted, and a board that still shows the old address shows the same card.
 */
import {
  catalogueIdOf,
  catalogueSourceOf,
  idFromAddress,
  MAX_FORMER_URLS,
  type AttributionSource,
} from "./pictureAttribution";
import { IGDB_COVERS, steamHits, TMDB_IMAGES } from "./pictureSources";

const DAY_MS = 24 * 60 * 60 * 1000;
export const PICTURE_CHECKS = "pictureChecks";
/** Well inside TMDB's six months, so a run that fails for weeks still keeps to it. */
export const TMDB_REFRESH_MS = 90 * DAY_MS;
export const PROBE_EVERY_MS = 7 * DAY_MS;
export const TMDB_PER_RUN = 150;
export const PROBES_PER_RUN = 300;
/** Ids of one catalogue asked in one request, where the catalogue takes several. */
export const IDS_PER_ASK = 50;

export interface CataloguePicture {
  url: string;
  source: AttributionSource;
  id: string | null;
}

/** What a run last learnt about one address, in `pictureChecks/{key}`. */
export interface PictureCheck {
  url: string;
  /** When it was last fetched or asked about, in ms since the epoch. */
  checkedAt?: number;
  /** When its catalogue was last asked for it by id. */
  refreshedAt?: number;
  status?: "ok" | "moved" | "dead" | "gone";
  movedTo?: string;
}

type Json = Record<string, unknown>;

function cardsOf(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((one): one is Json => one !== null && typeof one === "object" && !Array.isArray(one)) : [];
}

/** The catalogue pictures on the cards of published lists and ranking snapshots, each address once, with its id where known. */
export function picturesIn(docs: readonly unknown[]): CataloguePicture[] {
  const found = new Map<string, CataloguePicture>();
  for (const doc of docs) {
    const data = (doc ?? {}) as Json;
    const cards = [...cardsOf(data.items), ...cardsOf((data.snapshot as Json | undefined)?.items)];
    for (const card of cards) {
      const url = card.imageUrl;
      if (typeof url !== "string") continue;
      const source = catalogueSourceOf(url);
      if (source === null) continue;
      const attribution = (card.attribution ?? {}) as Json;
      const link = typeof attribution.link === "string" ? attribution.link : null;
      const id = idFromAddress(url, link) ?? catalogueIdOf(source, attribution.id);
      const known = found.get(url);
      if (!known || (known.id === null && id !== null)) found.set(url, { url, source, id });
    }
  }
  return [...found.values()];
}

export interface RunPlan {
  /** Every IGDB cover with its id: asked again each day. */
  igdb: CataloguePicture[];
  /** TMDB pictures with an id not asked for in 90 days, oldest first. */
  tmdb: CataloguePicture[];
  /** Everything else not looked at this week, oldest first. */
  probe: CataloguePicture[];
}

export function planRun(pictures: readonly CataloguePicture[], checks: ReadonlyMap<string, PictureCheck>, nowMs: number): RunPlan {
  const igdb = pictures.filter((one) => one.source === "igdb" && one.id !== null);
  const oldest = (field: "checkedAt" | "refreshedAt") => (a: CataloguePicture, b: CataloguePicture) =>
    (checks.get(a.url)?.[field] ?? 0) - (checks.get(b.url)?.[field] ?? 0);
  const tmdb = pictures
    .filter((one) => one.source === "tmdb" && one.id !== null && (checks.get(one.url)?.refreshedAt ?? 0) <= nowMs - TMDB_REFRESH_MS)
    .sort(oldest("refreshedAt"))
    .slice(0, TMDB_PER_RUN);
  const asked = new Set([...igdb, ...tmdb].map((one) => one.url));
  const probe = pictures
    .filter((one) => !asked.has(one.url) && (checks.get(one.url)?.checkedAt ?? 0) <= nowMs - PROBE_EVERY_MS)
    .sort(oldest("checkedAt"))
    .slice(0, PROBES_PER_RUN);
  return { igdb, tmdb, probe };
}

/** What an address answering [status] says of the picture: there, gone for good, or nothing sure. */
export function probeVerdict(status: number | null): "ok" | "dead" | "unsure" {
  if (status === null) return "unsure";
  if (status === 404 || status === 410) return "dead";
  return status >= 200 && status < 400 ? "ok" : "unsure";
}

// What each catalogue answers about its ids: the picture's address now, or null when it has none any more.

export function tmdbPictureOf(id: string, body: unknown): string | null {
  const kind = id.split(":")[1];
  const path = ((body ?? {}) as Json)[kind === "person" ? "profile_path" : "poster_path"];
  return typeof path === "string" && /^\/[A-Za-z0-9._-]+$/.test(path) ? `${TMDB_IMAGES}w500${path}` : null;
}

/** `fields cover.image_id; where id = (…)`: each game's cover, by `igdb:{id}`. */
export function igdbCovers(body: unknown): Map<string, string | null> {
  const covers = new Map<string, string | null>();
  for (const row of cardsOf(body)) {
    if (typeof row.id !== "number") continue;
    const image = ((row.cover ?? {}) as Json).image_id;
    covers.set(`igdb:${row.id}`, typeof image === "string" && /^[a-z0-9]+$/.test(image) ? `${IGDB_COVERS}${image}.jpg` : null);
  }
  return covers;
}

/** One AniList request for several ids at once, each under an alias of its own. */
export function anilistQuery(ids: readonly string[]): string {
  const parts = ids.map((id, at) => {
    const number = id.slice("anilist:".length);
    return number.startsWith("c")
      ? `a${at}: Character(id: ${Number(number.slice(1))}) { image { large } }`
      : `a${at}: Media(id: ${Number(number)}) { isAdult coverImage { extraLarge large } }`;
  });
  return `query { ${parts.join(" ")} }`;
}

export function anilistPictures(ids: readonly string[], body: unknown): Map<string, string | null> {
  const data = (((body ?? {}) as Json).data ?? {}) as Json;
  const pictures = new Map<string, string | null>();
  ids.forEach((id, at) => {
    const row = data[`a${at}`] as Json | null | undefined;
    if (row === undefined) return;
    const cover = (row?.coverImage ?? {}) as Json;
    const image = (row?.image ?? {}) as Json;
    const url = row?.isAdult === true ? null : [cover.extraLarge, cover.large, image.large].find((one): one is string => typeof one === "string") ?? null;
    pictures.set(id, url !== null && !url.includes("/default.jpg") && catalogueSourceOf(url) === "anilist" ? url : null);
  });
  return pictures;
}

export function steamPictures(ids: readonly string[], body: unknown): Map<string, string | null> {
  const numbers = ids.map((id) => Number(id.slice("steam:".length)));
  const hits = new Map(steamHits(numbers, body).map((hit) => [hit.id, hit.imageUrl]));
  return new Map(ids.map((id) => [id, hits.get(id) ?? null]));
}

export function openLibraryCover(body: unknown): string | null {
  const covers = ((body ?? {}) as Json).covers;
  const first = Array.isArray(covers) ? covers.find((one) => typeof one === "number" && one > 0) : undefined;
  return typeof first === "number" ? `https://covers.openlibrary.org/b/id/${first}-L.jpg` : null;
}

/** [items] with each card shown at a moved address at the new one, remembering the old; null when none moved. */
export function movedItems(items: unknown, moves: ReadonlyMap<string, string>): Json[] | null {
  if (!Array.isArray(items)) return null;
  let changed = false;
  const next = items.map((raw) => {
    const card = (raw ?? {}) as Json;
    const now = typeof card.imageUrl === "string" ? moves.get(card.imageUrl) : undefined;
    if (now === undefined || typeof raw !== "object" || raw === null) return raw as Json;
    changed = true;
    const old = card.imageUrl as string;
    const attribution = (card.attribution ?? { source: catalogueSourceOf(old) ?? "web" }) as Json;
    const former = Array.isArray(attribution.formerUrls) ? (attribution.formerUrls as unknown[]).filter((one): one is string => typeof one === "string") : [];
    const formerUrls = [...former.filter((one) => one !== old && one !== now), old].slice(-MAX_FORMER_URLS);
    return { ...card, imageUrl: now, attribution: { ...attribution, formerUrls } };
  });
  return changed ? next : null;
}

function movedList(urls: unknown, moves: ReadonlyMap<string, string>): string[] | null {
  if (!Array.isArray(urls) || !urls.some((url) => typeof url === "string" && moves.has(url))) return null;
  return urls.map((url) => (typeof url === "string" ? moves.get(url) ?? url : url));
}

/**
 * The fields of a published list, or of a ranking's snapshot under [prefix],
 * that change when its pictures move: its cards, cover and collage. Empty when
 * nothing on it moved. `updatedAt` is never among them: the list did not change.
 */
export function movedFields(data: unknown, moves: ReadonlyMap<string, string>, prefix = ""): Record<string, unknown> {
  const value = (data ?? {}) as Json;
  const fields: Record<string, unknown> = {};
  const items = movedItems(value.items, moves);
  if (items !== null) fields[`${prefix}items`] = items;
  if (typeof value.coverImageUrl === "string" && moves.has(value.coverImageUrl)) fields[`${prefix}coverImageUrl`] = moves.get(value.coverImageUrl);
  const preview = movedList(value.previewImages, moves);
  if (preview !== null) fields[`${prefix}previewImages`] = preview;
  return fields;
}

/** A card address's key in `pictureChecks`: Firestore ids cannot hold a URL. */
export function checkKey(url: string, hash: (text: string) => string): string {
  return hash(url).slice(0, 40);
}
