/**
 * Picture search for cards: which catalogues a scope asks, how each one's
 * answer becomes a hit, and how the hits are ranked together. Pure: the
 * requests are in src/pictureSearch.ts.
 */
import { fold, wordsOf } from "./search";

export const PICTURE_SCOPES = ["all", "film_tv", "anime", "games", "music", "books", "people", "animals"] as const;
export type PictureScope = (typeof PICTURE_SCOPES)[number];

export type PictureSource = "tmdb" | "anilist" | "igdb" | "steam" | "deezer" | "openlibrary" | "inaturalist" | "wikidata" | "web";

/** What a card's picture can be: the chip a client draws under a result is its own business. */
export type PictureKind = "movie" | "tv" | "person" | "anime" | "manga" | "character" | "game" | "artist" | "album" | "book" | "animal" | "thing" | "web";

export interface PictureHit {
  /** `source:id`, stable across searches, so a client can drop what it already shows. */
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  /** A smaller copy for the grid, never narrower than a tile (about 320 px on a phone); null when [imageUrl] is the only one that wide. */
  thumbUrl: string | null;
  source: PictureSource;
  kind: PictureKind;
  /** Who the picture's license asks to be named beside it; absent when it asks for nobody or the source does not say. */
  credit?: string;
}

/** A scope from what a client sent: a known scope, or a section id that means one; anything else is all. */
export function pictureScopeOf(raw: unknown): PictureScope {
  if (typeof raw !== "string") return "all";
  return (PICTURE_SCOPES as readonly string[]).includes(raw) ? (raw as PictureScope) : "all";
}

/** The catalogues a scope asks, best first; the order also breaks ties between equally good titles. */
export function sourcesFor(scope: PictureScope): PictureSource[] {
  switch (scope) {
    case "film_tv":
      return ["tmdb", "wikidata"];
    case "people":
      return ["tmdb", "wikidata"];
    case "anime":
      return ["anilist", "wikidata"];
    case "games":
      return ["igdb", "steam", "wikidata"];
    case "music":
      return ["deezer", "wikidata"];
    case "books":
      return ["openlibrary", "wikidata"];
    case "animals":
      return ["inaturalist", "wikidata"];
    case "all":
      return ["tmdb", "anilist", "igdb", "steam", "deezer", "openlibrary", "inaturalist", "wikidata"];
  }
}

/** Scopes whose tiles are covers and posters, where anything wider than tall looks broken; the others hold photos. */
export function wantsCovers(scope: PictureScope): boolean {
  return scope !== "all" && scope !== "animals";
}

/** Below this on its short side a picture is soft in a grid tile. */
export const MIN_SHORT_SIDE = 300;
/** A photo may be cropped into a tile; past this it is a banner or a screenshot. */
const WIDEST_PHOTO = 1.5;

/** Whether a picture this size makes a good tile: big enough, and upright where covers are wanted. */
export function fitsTile(width: number, height: number, covers: boolean): boolean {
  if (!(width > 0 && height > 0) || Math.min(width, height) < MIN_SHORT_SIDE) return false;
  return covers ? width <= height : width <= height * WIDEST_PHOTO;
}

/** Fewer good matches than this from the catalogues, and "all" asks the web too. */
export const WEB_WHEN_FEWER_THAN = 6;
export const WEB_DAILY_PER_USER = 30;
/** About fifty dollars of web searches; past it the web drops out for everyone until the month turns. */
export const WEB_MONTHLY_CEILING = 50_000;

export type WebDecision = "ask" | "skip" | "dailyLimit" | "off";

export function decideWeb(input: {
  scope: PictureScope;
  forced: boolean;
  goodMatches: number;
  configured: boolean;
  offUntilMs: number;
  nowMs: number;
  usedToday: number;
  usedThisMonth: number;
}): WebDecision {
  if (input.scope !== "all" && !input.forced) return "skip";
  if (!input.forced && input.goodMatches >= WEB_WHEN_FEWER_THAN) return "skip";
  if (!input.configured || input.offUntilMs > input.nowMs || input.usedThisMonth >= WEB_MONTHLY_CEILING) return "off";
  if (input.usedToday >= WEB_DAILY_PER_USER) return "dailyLimit";
  return "ask";
}

/** 0 the title is what was typed, 1 it starts so, 2 it holds every typed word, 3 the catalogue thought it close. */
export function matchScore(title: string, typed: string): number {
  const wanted = fold(typed).trim();
  const have = fold(title).trim();
  if (wanted.length === 0) return 3;
  if (have === wanted) return 0;
  if (have.startsWith(wanted)) return 1;
  const words = wordsOf(title);
  return wordsOf(typed).every((word) => words.some((held) => held.startsWith(word))) ? 2 : 3;
}

/**
 * One list from many: each catalogue's answer in its own order, taken in
 * turn, then the best titles first. A picture already shown by an earlier
 * source, or the same title of the same kind, is dropped.
 */
export function mergeHits(typed: string, answers: readonly (readonly PictureHit[])[]): PictureHit[] {
  const interleaved: PictureHit[] = [];
  const longest = Math.max(0, ...answers.map((answer) => answer.length));
  for (let index = 0; index < longest; index++) {
    for (const answer of answers) {
      const hit = answer[index];
      if (hit) interleaved.push(hit);
    }
  }
  const seen = new Set<string>();
  const kept = interleaved.filter((hit) => {
    // Two catalogues of games write the year differently or not at all; the title is enough.
    const keys = [hit.imageUrl, `${hit.kind}|${fold(hit.title)}|${hit.kind === "game" ? "" : hit.subtitle ?? ""}`];
    if (keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
    return true;
  });
  return kept
    .map((hit, order) => ({ hit, order, score: matchScore(hit.title, typed) }))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ hit }) => hit);
}

export function goodMatches(typed: string, hits: readonly PictureHit[]): number {
  return hits.filter((hit) => matchScore(hit.title, typed) < 3).length;
}

// What each catalogue answers, as hits. Each takes the parsed JSON and trusts nothing in it.

type Json = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => typeof row === "object" && row !== null) : [];
}

const TMDB_IMAGES = "https://image.tmdb.org/t/p/";

export function tmdbHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.results).flatMap((row): PictureHit[] => {
    const type = row.media_type;
    const kind: PictureKind | null = type === "movie" ? "movie" : type === "tv" ? "tv" : type === "person" ? "person" : null;
    const path = text(kind === "person" ? row.profile_path : row.poster_path);
    const title = text(row.title) ?? text(row.name);
    if (!kind || !path || !title || typeof row.id !== "number") return [];
    const date = text(row.release_date) ?? text(row.first_air_date);
    const subtitle = kind === "person" ? text(row.known_for_department) : date?.slice(0, 4) ?? null;
    return [{ id: `tmdb:${row.id}`, title, subtitle, imageUrl: `${TMDB_IMAGES}w500${path}`, thumbUrl: `${TMDB_IMAGES}w342${path}`, source: "tmdb", kind }];
  });
}

export function anilistHits(body: unknown): PictureHit[] {
  const data = ((body as Json | null)?.data ?? {}) as Json;
  const media = rows((data.media as Json | undefined)?.media).flatMap((row): PictureHit[] => {
    const titles = (row.title ?? {}) as Json;
    const title = text(titles.english) ?? text(titles.romaji) ?? text(titles.native);
    const cover = (row.coverImage ?? {}) as Json;
    const imageUrl = text(cover.extraLarge) ?? text(cover.large);
    if (!title || !imageUrl || imageUrl.includes("/default.jpg") || typeof row.id !== "number" || row.isAdult === true) return [];
    const kind: PictureKind = row.type === "MANGA" ? "manga" : "anime";
    const year = typeof row.seasonYear === "number" ? String(row.seasonYear) : typeof (row.startDate as Json | undefined)?.year === "number" ? String((row.startDate as Json).year) : null;
    return [{ id: `anilist:${row.id}`, title, subtitle: year, imageUrl, thumbUrl: null, source: "anilist", kind }];
  });
  const characters = rows((data.characters as Json | undefined)?.characters).flatMap((row): PictureHit[] => {
    const title = text((row.name as Json | undefined)?.full);
    const image = (row.image ?? {}) as Json;
    const imageUrl = text(image.large);
    if (!title || !imageUrl || imageUrl.includes("/default.jpg") || typeof row.id !== "number") return [];
    const from = rows((row.media as Json | undefined)?.nodes)[0];
    const subtitle = from ? text((from.title as Json | undefined)?.english) ?? text((from.title as Json | undefined)?.romaji) : null;
    return [{ id: `anilist:c${row.id}`, title, subtitle, imageUrl, thumbUrl: null, source: "anilist", kind: "character" }];
  });
  return [...media, ...characters];
}

export const ANILIST_QUERY = `query ($q: String, $page: Int) {
  media: Page(page: $page, perPage: 15) { pageInfo { hasNextPage } media(search: $q, sort: SEARCH_MATCH, isAdult: false) {
    id type isAdult seasonYear startDate { year } title { english romaji native } coverImage { extraLarge large } } }
  characters: Page(page: $page, perPage: 10) { characters(search: $q, sort: SEARCH_MATCH) {
    id name { full } image { large } media(perPage: 1) { nodes { title { english romaji } } } } }
}`;

const IGDB_COVERS = "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/";

/** IGDB's games: its cover is always upright, and a game without one is not asked for. */
export const IGDB_QUERY_FIELDS = "name,first_release_date,cover.image_id,cover.width,cover.height";

export function igdbHits(body: unknown): PictureHit[] {
  return rows(body).flatMap((row): PictureHit[] => {
    const title = text(row.name);
    const cover = (row.cover ?? {}) as Json;
    const image = text(cover.image_id);
    if (!title || !image || typeof row.id !== "number" || !/^[a-z0-9]+$/.test(image)) return [];
    if (typeof cover.width === "number" && typeof cover.height === "number" && !fitsTile(cover.width, cover.height, true)) return [];
    const year = typeof row.first_release_date === "number" ? String(new Date(row.first_release_date * 1000).getUTCFullYear()) : null;
    return [{ id: `igdb:${row.id}`, title, subtitle: year, imageUrl: `${IGDB_COVERS}${image}.jpg`, thumbUrl: null, source: "igdb", kind: "game" }];
  });
}

const STEAM_ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/";

/** The ids of the apps a Steam store search found, in its order. */
export function steamAppIds(body: unknown): number[] {
  return rows((body as Json | null)?.items).flatMap((row) => (row.type === "app" && typeof row.id === "number" ? [row.id] : []));
}

/**
 * `IStoreBrowseService/GetItems` with assets: each game's tall library cover at the address Steam keeps it,
 * which for newer games sits under a hash. A game with no tall cover is left out, never shown by its wide banner.
 */
export function steamHits(ids: readonly number[], body: unknown): PictureHit[] {
  const items = new Map(rows(((body as Json | null)?.response as Json | undefined)?.store_items).map((row) => [row.appid, row]));
  return ids.flatMap((id): PictureHit[] => {
    const row = items.get(id);
    const title = text(row?.name);
    const assets = (row?.assets ?? {}) as Json;
    const format = text(assets.asset_url_format);
    const cover = text(assets.library_capsule_2x) ?? text(assets.library_capsule);
    if (!title || !format || !cover) return [];
    return [{
      id: `steam:${id}`,
      title,
      subtitle: null,
      imageUrl: STEAM_ASSETS + format.replace("${FILENAME}", cover),
      thumbUrl: null,
      source: "steam",
      kind: "game",
    }];
  });
}

/** Deezer gives a grey silhouette to an artist with no photo; its address has no picture id. */
function deezerPicture(value: unknown): string | null {
  const url = text(value);
  return url && !/\/images\/(artist|cover)\/\//.test(url) ? url : null;
}

export function deezerArtistHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.data).flatMap((row): PictureHit[] => {
    const title = text(row.name);
    const imageUrl = deezerPicture(row.picture_xl) ?? deezerPicture(row.picture_big);
    if (!title || !imageUrl || typeof row.id !== "number") return [];
    return [{ id: `deezer:a${row.id}`, title, subtitle: null, imageUrl, thumbUrl: deezerPicture(row.picture_big), source: "deezer", kind: "artist" }];
  });
}

export function deezerAlbumHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.data).flatMap((row): PictureHit[] => {
    const title = text(row.title);
    const imageUrl = deezerPicture(row.cover_xl) ?? deezerPicture(row.cover_big);
    if (!title || !imageUrl || typeof row.id !== "number") return [];
    return [{
      id: `deezer:${row.id}`,
      title,
      subtitle: text((row.artist as Json | undefined)?.name),
      imageUrl,
      thumbUrl: deezerPicture(row.cover_big),
      source: "deezer",
      kind: "album",
    }];
  });
}

export function openLibraryHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.docs).flatMap((row): PictureHit[] => {
    const title = text(row.title);
    const key = text(row.key);
    if (!title || !key || typeof row.cover_i !== "number" || row.cover_i <= 0) return [];
    const author = Array.isArray(row.author_name) ? text(row.author_name[0]) : null;
    const year = typeof row.first_publish_year === "number" ? String(row.first_publish_year) : null;
    const covers = `https://covers.openlibrary.org/b/id/${row.cover_i}`;
    return [{
      id: `openlibrary:${key.replace(/^\/works\//, "")}`,
      title,
      subtitle: [author, year].filter(Boolean).join(" · ") || null,
      imageUrl: `${covers}-L.jpg`,
      thumbUrl: null,
      source: "openlibrary",
      kind: "book",
    }];
  });
}

/** The properties a Wikidata item's picture can be in, the most telling first: a poster, a cover, a logo, a photo. */
/** Licenses that let anybody show and keep a photo, a commercial app included: no NC, no ND, not "all rights reserved". */
const OPEN_LICENSES = new Set(["cc0", "cc-by", "cc-by-sa", "pd"]);

/** An openly licensed photo a tile can be cut from, or null. */
function inaturalistPhoto(raw: unknown): { medium: string; credit: string | null } | null {
  const photo = (raw ?? {}) as Json;
  const medium = text(photo.medium_url);
  const size = (photo.original_dimensions ?? {}) as Json;
  if (typeof photo.license_code !== "string" || !OPEN_LICENSES.has(photo.license_code)) return null;
  if (!medium || !medium.startsWith("https://")) return null;
  if (typeof size.width !== "number" || typeof size.height !== "number" || !fitsTile(size.width, size.height, false)) return null;
  return { medium, credit: text(photo.attribution) };
}

/** Taxa whose default photo will not do, so their other photos are worth asking for. */
export function inaturalistWithoutPhoto(body: unknown): number[] {
  return rows((body as Json | null)?.results)
    .filter((row) => typeof row.id === "number" && inaturalistPhoto(row.default_photo) === null)
    .map((row) => row.id as number);
}

/** Every photo of each taxon in a /v1/taxa/{ids} answer, by taxon id. */
export function inaturalistPhotos(body: unknown): Map<number, unknown[]> {
  const photos = new Map<number, unknown[]>();
  for (const row of rows((body as Json | null)?.results)) {
    if (typeof row.id === "number") photos.set(row.id, rows(row.taxon_photos).map((one) => one.photo));
  }
  return photos;
}

/**
 * iNaturalist's animals: the common name in the reader's language over the Latin one,
 * which then stands under it. The default photo when its license is open, else the
 * taxon's first open one; a taxon with none is left out, as is a wide photo.
 */
export function inaturalistHits(body: unknown, others: Map<number, unknown[]> = new Map()): PictureHit[] {
  return rows((body as Json | null)?.results).flatMap((row): PictureHit[] => {
    const latin = text(row.name);
    if (!latin || typeof row.id !== "number" || row.is_active === false) return [];
    const photo = [row.default_photo, ...(others.get(row.id) ?? [])].map(inaturalistPhoto).find((one) => one !== null);
    if (!photo) return [];
    const common = text(row.preferred_common_name);
    const title = common ? common.charAt(0).toLocaleUpperCase() + common.slice(1) : latin;
    return [{
      id: `inaturalist:${row.id}`,
      title,
      subtitle: common ? latin : null,
      imageUrl: photo.medium.replace(/\/medium\.(\w+)$/, "/large.$1"),
      thumbUrl: photo.medium,
      source: "inaturalist",
      kind: "animal",
      ...(photo.credit ? { credit: photo.credit } : {}),
    }];
  });
}

const WIKIDATA_PICTURES = ["P3383", "P18", "P154", "P2716"];
/** Where an item says what it is on TMDB, so the same film is not shown twice. */
const WIKIDATA_TMDB = { P4947: "movie", P4983: "tv", P4985: "person" } as const;

export interface WikidataCandidate {
  hit: PictureHit;
  file: string;
  tmdbIds: string[];
}

/** How Commons names a file: spaces, not underscores, and a capital first letter. */
export function commonsName(file: string): string {
  const spaced = file.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Commons `imageinfo` sizes: the files that make good tiles, by their Commons names. */
export function commonsFitting(body: unknown, covers: boolean): Set<string> {
  const pages = ((((body as Json | null)?.query as Json | undefined)?.pages ?? {}) as Record<string, Json>);
  return new Set(Object.values(pages).flatMap((page) => {
    const info = rows(page.imageinfo)[0];
    const title = text(page.title);
    if (!title || typeof info?.width !== "number" || typeof info?.height !== "number" || !fitsTile(info.width, info.height, covers)) return [];
    return [commonsName(title.replace(/^File:/, ""))];
  }));
}

export function commonsThumb(file: string, width: number): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=${width}`;
}

/** `wbgetentities` with labels, descriptions and claims, in the order `wbsearchentities` found the ids. */
export function wikidataCandidates(ids: readonly string[], body: unknown, language: string): WikidataCandidate[] {
  const entities = ((body as Json | null)?.entities ?? {}) as Record<string, Json>;
  return ids.flatMap((id): WikidataCandidate[] => {
    const entity = entities[id];
    if (!entity) return [];
    const claims = (entity.claims ?? {}) as Record<string, unknown>;
    const file = WIKIDATA_PICTURES.map((property) => firstStringClaim(claims[property])).find((value) => value !== null) ?? null;
    const title = labelIn(entity.labels, language);
    if (!file || !title) return [];
    const tmdbIds = Object.entries(WIKIDATA_TMDB).flatMap(([property, kind]) => {
      const value = firstStringClaim(claims[property]);
      return value ? [`${kind}:${value}`] : [];
    });
    return [{
      hit: {
        id: `wikidata:${id}`,
        title,
        subtitle: labelIn(entity.descriptions, language),
        imageUrl: commonsThumb(file, 600),
        thumbUrl: commonsThumb(file, 400),
        source: "wikidata",
        kind: "thing",
      },
      file,
      tmdbIds,
    }];
  });
}

function labelIn(labels: unknown, language: string): string | null {
  const byLanguage = (labels ?? {}) as Record<string, Json>;
  const base = language.split("-")[0] ?? language;
  return text(byLanguage[language]?.value) ?? text(byLanguage[base]?.value) ?? text(byLanguage.en?.value) ?? text(Object.values(byLanguage)[0]?.value);
}

function firstStringClaim(claim: unknown): string | null {
  const first = rows(claim)[0];
  const value = ((first?.mainsnak as Json | undefined)?.datavalue as Json | undefined)?.value;
  return text(value);
}

/** A TMDB hit's own key in the shape Wikidata names it. */
export function tmdbKeyOf(hit: PictureHit): string | null {
  return hit.source === "tmdb" ? `${hit.kind}:${hit.id.slice("tmdb:".length)}` : null;
}

export function webHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.images).flatMap((row): PictureHit[] => {
    const imageUrl = text(row.imageUrl);
    const title = text(row.title);
    if (!imageUrl || !imageUrl.startsWith("https://") || !title) return [];
    // The search engine's own thumbnail is a couple of hundred pixels: the grid takes the picture itself.
    if (typeof row.imageWidth !== "number" || typeof row.imageHeight !== "number" || !fitsTile(row.imageWidth, row.imageHeight, false)) return [];
    return [{
      id: `web:${hashOf(imageUrl)}`,
      title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
      subtitle: text(row.source) ?? text(row.domain),
      imageUrl,
      thumbUrl: null,
      source: "web",
      kind: "web",
    }];
  });
}

/** A short stable id for a web picture; not a security hash. */
function hashOf(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
