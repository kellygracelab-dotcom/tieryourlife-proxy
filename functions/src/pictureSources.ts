/**
 * Picture search for cards: which catalogues a scope asks, how each one's
 * answer becomes a hit, and how the hits are ranked together. Pure: the
 * requests are in src/pictureSearch.ts.
 */
import { fold, wordsOf } from "./search";

export const PICTURE_SCOPES = ["all", "film_tv", "anime", "games", "music", "books", "people"] as const;
export type PictureScope = (typeof PICTURE_SCOPES)[number];

export type PictureSource = "tmdb" | "anilist" | "steam" | "deezer" | "openlibrary" | "wikidata" | "web";

/** What a card's picture can be: the chip a client draws under a result is its own business. */
export type PictureKind = "movie" | "tv" | "person" | "anime" | "manga" | "character" | "game" | "artist" | "album" | "book" | "thing" | "web";

export interface PictureHit {
  /** `source:id`, stable across searches, so a client can drop what it already shows. */
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  /** A smaller copy for the grid, when the source has one apart from [imageUrl]. */
  thumbUrl: string | null;
  source: PictureSource;
  kind: PictureKind;
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
      return ["steam", "wikidata"];
    case "music":
      return ["deezer", "wikidata"];
    case "books":
      return ["openlibrary", "wikidata"];
    case "all":
      return ["tmdb", "anilist", "steam", "deezer", "openlibrary", "wikidata"];
  }
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
    const keys = [hit.imageUrl, `${hit.kind}|${fold(hit.title)}|${hit.subtitle ?? ""}`];
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
    return [{ id: `tmdb:${row.id}`, title, subtitle, imageUrl: `${TMDB_IMAGES}w500${path}`, thumbUrl: `${TMDB_IMAGES}w185${path}`, source: "tmdb", kind }];
  });
}

export function anilistHits(body: unknown): PictureHit[] {
  const data = ((body as Json | null)?.data ?? {}) as Json;
  const media = rows((data.media as Json | undefined)?.media).flatMap((row): PictureHit[] => {
    const titles = (row.title ?? {}) as Json;
    const title = text(titles.english) ?? text(titles.romaji) ?? text(titles.native);
    const cover = (row.coverImage ?? {}) as Json;
    const imageUrl = text(cover.extraLarge) ?? text(cover.large);
    if (!title || !imageUrl || typeof row.id !== "number" || row.isAdult === true) return [];
    const kind: PictureKind = row.type === "MANGA" ? "manga" : "anime";
    const year = typeof row.seasonYear === "number" ? String(row.seasonYear) : typeof (row.startDate as Json | undefined)?.year === "number" ? String((row.startDate as Json).year) : null;
    return [{ id: `anilist:${row.id}`, title, subtitle: year, imageUrl, thumbUrl: text(cover.medium), source: "anilist", kind }];
  });
  const characters = rows((data.characters as Json | undefined)?.characters).flatMap((row): PictureHit[] => {
    const title = text((row.name as Json | undefined)?.full);
    const image = (row.image ?? {}) as Json;
    const imageUrl = text(image.large);
    if (!title || !imageUrl || imageUrl.includes("/default.jpg") || typeof row.id !== "number") return [];
    const from = rows((row.media as Json | undefined)?.nodes)[0];
    const subtitle = from ? text((from.title as Json | undefined)?.english) ?? text((from.title as Json | undefined)?.romaji) : null;
    return [{ id: `anilist:c${row.id}`, title, subtitle, imageUrl, thumbUrl: text(image.medium), source: "anilist", kind: "character" }];
  });
  return [...media, ...characters];
}

export const ANILIST_QUERY = `query ($q: String, $page: Int) {
  media: Page(page: $page, perPage: 15) { pageInfo { hasNextPage } media(search: $q, sort: SEARCH_MATCH, isAdult: false) {
    id type isAdult seasonYear startDate { year } title { english romaji native } coverImage { extraLarge large medium } } }
  characters: Page(page: $page, perPage: 10) { characters(search: $q, sort: SEARCH_MATCH) {
    id name { full } image { large medium } media(perPage: 1) { nodes { title { english romaji } } } } }
}`;

const STEAM_CDN = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/";

/** Steam's own search: the portrait cover where the game has one is chosen by the caller, the wide header is always there. */
export function steamHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.items).flatMap((row): PictureHit[] => {
    const title = text(row.name);
    if (!title || typeof row.id !== "number" || row.type !== "app") return [];
    return [{
      id: `steam:${row.id}`,
      title,
      subtitle: null,
      imageUrl: `${STEAM_CDN}${row.id}/library_600x900.jpg`,
      thumbUrl: `${STEAM_CDN}${row.id}/header.jpg`,
      source: "steam",
      kind: "game",
    }];
  });
}

export function steamHeaderOf(hit: PictureHit): PictureHit {
  return { ...hit, imageUrl: hit.thumbUrl ?? hit.imageUrl, thumbUrl: null };
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
    return [{ id: `deezer:a${row.id}`, title, subtitle: null, imageUrl, thumbUrl: deezerPicture(row.picture_medium), source: "deezer", kind: "artist" }];
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
      thumbUrl: deezerPicture(row.cover_medium),
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
      thumbUrl: `${covers}-M.jpg`,
      source: "openlibrary",
      kind: "book",
    }];
  });
}

/** The properties a Wikidata item's picture can be in, the most telling first: a poster, a cover, a logo, a photo. */
const WIKIDATA_PICTURES = ["P3383", "P18", "P154", "P2716"];
/** Where an item says what it is on TMDB, so the same film is not shown twice. */
const WIKIDATA_TMDB = { P4947: "movie", P4983: "tv", P4985: "person" } as const;

export interface WikidataCandidate {
  hit: PictureHit;
  tmdbIds: string[];
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
        thumbUrl: commonsThumb(file, 250),
        source: "wikidata",
        kind: "thing",
      },
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
    const thumb = text(row.thumbnailUrl);
    return [{
      id: `web:${hashOf(imageUrl)}`,
      title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
      subtitle: text(row.source) ?? text(row.domain),
      imageUrl,
      thumbUrl: thumb?.startsWith("https://") ? thumb : null,
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
