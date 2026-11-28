/**
 * Picture search for cards: which catalogues a scope asks, how each one's
 * answer becomes a hit, and how the hits are ranked together. Pure: the
 * requests are in src/pictureSearch.ts.
 */
import { fold, wordsOf } from "./search";
import { commonsCredit, commonsDetails } from "./pictureCredit";
import { COMMONS_CARD_WIDTH, commonsFileOf, IGDB_COPY_SIZE, TMDB_COPY_SIZE, commonsPictureOf, commonsThumb, inaturalistLicence, inaturalistLicenceOfCode, linkFromAddress, mayCopy, pageLink, type PictureAttribution } from "./pictureAttribution";

export const PICTURE_SCOPES = ["all", "film_tv", "anime", "games", "music", "books", "people", "animals"] as const;
export type PictureScope = (typeof PICTURE_SCOPES)[number];

export type PictureSource = "tmdb" | "anilist" | "igdb" | "steam" | "deezer" | "openlibrary" | "inaturalist" | "wikidata" | "web";

/** What a card's picture can be: the chip a client draws under a result is its own business. */
export type PictureKind = "movie" | "tv" | "person" | "anime" | "manga" | "character" | "game" | "artist" | "album" | "book" | "animal" | "plant" | "thing" | "web";

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
  /** The same, as fields, with the picture's page at its source: a card keeps it as its own `attribution`. */
  attribution?: Omit<PictureAttribution, "originalUrl">;
  /**
   * How many ratings the catalogue counts for it (IGDB's `total_rating_count`, since 15.11.2026), a whole
   * number above 0; absent when it counts none. A client may take the most rated of several near matches,
   * the main game of a series.
   */
  popularity?: number;
  /** Another name the catalogue found it by ("Cat" for the domestic cat): ranked like the title; sent as `matchedName` when it is what was typed. */
  alias?: string;
  /** Wikidata's description in English, what a section's kind is told by (src/pictureIntent.ts); never sent. */
  about?: string;
}

/** A scope from what a client sent: a known scope, or a section id that means one; anything else is all. */
export function pictureScopeOf(raw: unknown): PictureScope {
  if (typeof raw !== "string") return "all";
  return (PICTURE_SCOPES as readonly string[]).includes(raw) ? (raw as PictureScope) : "all";
}

/**
 * Catalogues never asked, whatever the scope. Deezer is off for the first
 * release: the right to show its covers publicly is unclear. Lists that
 * already hold its covers keep them (`CATALOGUE_HOSTS`).
 */
export const DISABLED_SOURCES: readonly PictureSource[] = ["deezer"];

/** A picture on Deezer's servers: publishing drops it, and nothing copies it. */
export function isDeezerPicture(url: string | null): boolean {
  if (url === null) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "dzcdn.net" || host.endsWith(".dzcdn.net");
  } catch {
    return false;
  }
}

/** The catalogues a scope asks, best first; the order also breaks ties between equally good titles. */
export function sourcesFor(scope: PictureScope): PictureSource[] {
  return everySourceFor(scope).filter((source) => !DISABLED_SOURCES.includes(source));
}

function everySourceFor(scope: PictureScope): PictureSource[] {
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

/** Catalogues that can take many seconds: a quick search leaves them for the whole one. */
const SLOW_SOURCES: readonly PictureSource[] = ["openlibrary"];

/**
 * What a quick search asks: the scope's catalogues that answer in a second or two, and in Books Open
 * Library too, the catalogue of its own (26.11.2026): a books search without it showed authors and
 * namesakes first. A quick search waits for none longer than its deadline (src/pictureSearch.ts).
 */
export function quickSourcesFor(scope: PictureScope): PictureSource[] {
  return sourcesFor(scope).filter((source) => scope === "books" || !SLOW_SOURCES.includes(source));
}

export function hasSlowSources(scope: PictureScope): boolean {
  return quickSourcesFor(scope).length < sourcesFor(scope).length;
}

/**
 * How every request of ours to a catalogue or another site names itself.
 * Wikimedia and Open Library allow more to a client that says how to reach it:
 * the privacy page gives the contact address, so none is sent here.
 */
export const USER_AGENT = "TierYourLife/1.0 (https://tieryourlife.com/privacy)";

/** A catalogue that answered 429 or 5xx without saying for how long is left alone this long. */
export const CATALOGUE_REST_MS = 5 * 60 * 1000;
const LONGEST_REST_MS = 60 * 60 * 1000;

/** Until when a catalogue is left alone after answering [status] with [retryAfter]; null when that was no refusal. */
export function restUntil(status: number, retryAfter: string | null, nowMs: number): number | null {
  if (status !== 429 && status < 500) return null;
  return nowMs + Math.min(LONGEST_REST_MS, retryAfterMs(retryAfter, nowMs) ?? CATALOGUE_REST_MS);
}

/** Retry-After as seconds or as an HTTP date. */
export function retryAfterMs(value: string | null, nowMs: number): number | null {
  const raw = value?.trim() ?? "";
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = raw.length > 0 ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** Scopes whose tiles are covers and posters, where anything wider than tall looks broken; the others hold photos. */
export function wantsCovers(scope: PictureScope): boolean {
  // Music is mostly band and artist photos: Commons holds few album covers.
  return scope !== "all" && scope !== "animals" && scope !== "music";
}

/** Below this on its short side a picture is soft in a grid tile. */
export const MIN_SHORT_SIDE = 300;
/**
 * A photo is cropped into a tile; past this it is a panorama or a banner, and another picture of the same
 * thing is looked for. Raised from 1.5 on 18.11.2026: Paris, Cairo, Everest and Queen were dropped whole
 * for a picture 1.6 to 1.9 times as wide as tall (QA, `qa-picture-search-2026-11-18`).
 */
export const WIDEST_PHOTO = 2;

/** Whether a picture this size makes a good tile: big enough, and upright where covers are wanted. */
export function fitsTile(width: number, height: number, covers: boolean): boolean {
  if (!(width > 0 && height > 0) || Math.min(width, height) < MIN_SHORT_SIDE) return false;
  return covers ? width <= height : width <= height * WIDEST_PHOTO;
}

/** Fewer good matches than this from the catalogues, and "all" asks the web too. */
export const WEB_WHEN_FEWER_THAN = 6;
/**
 * How many of the web's pictures a search that found nothing shows, in any scope: the first few, as an
 * image search shows them (QA, 18.11.2026: "если не находило то шло в гугл картинки и брало от туда первые 5").
 */
export const WEB_WHEN_EMPTY = 5;
export const WEB_DAILY_PER_USER = 30;
/** About fifty dollars of web searches; past it the web drops out for everyone until the month turns. */
export const WEB_MONTHLY_CEILING = 50_000;

export type WebDecision = "ask" | "skip" | "dailyLimit" | "off";

/**
 * Whether a search asks the web. "all" asks it when the catalogues found little; any scope asks it when
 * [empty]: the catalogues and the second attempt found nothing like the name. [forced]: asked for everywhere.
 */
export function decideWeb(input: {
  scope: PictureScope;
  forced: boolean;
  empty?: boolean;
  goodMatches: number;
  configured: boolean;
  offUntilMs: number;
  nowMs: number;
  usedToday: number;
  usedThisMonth: number;
}): WebDecision {
  const wanted = input.forced || input.empty === true || (input.scope === "all" && input.goodMatches < WEB_WHEN_FEWER_THAN);
  if (!wanted) return "skip";
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
 * What a scope's own catalogue shows, the pictures its lists are made of: in that scope they come before
 * everything else, Wikidata's last (18.11.2026). An anime list wants the series before its manga, a games
 * list the game before a namesake. "all" has none: it does not know what the list is about.
 */
export const OWN_KINDS: Partial<Record<PictureScope, readonly PictureKind[]>> = {
  film_tv: ["movie", "tv"],
  people: ["person"],
  anime: ["anime"],
  games: ["game"],
  music: ["artist", "album"],
  books: ["book"],
  animals: ["animal"],
};

/** 0 the scope's own kind of picture, 1 another catalogue's, 2 Wikidata's; all 0 where the scope has no kind of its own. */
export function scopeRank(hit: Pick<PictureHit, "kind" | "source">, scope: PictureScope): number {
  const own = OWN_KINDS[scope];
  if (!own) return 0;
  if (own.includes(hit.kind)) return 0;
  return hit.source === "wikidata" ? 2 : 1;
}

/** The key two hits of the same thing share: games by their title alone, as two catalogues write the year differently or not at all. */
function sameThing(hit: PictureHit): string {
  return `${hit.kind}|${fold(hit.title)}|${hit.kind === "game" ? "" : hit.subtitle ?? ""}`;
}

/**
 * One list from many: each catalogue's answer in its own order, taken in
 * turn, then, in a scope with a catalogue of its own, that catalogue's kind
 * of picture first, then the best titles first. A picture already shown by
 * an earlier source, or the same title of the same kind, is dropped; of games
 * with one title the most rated is kept, in the place of the first (IGDB
 * lists an unrated re-release of Hollow Knight above the game).
 */
export function mergeHits(
  typed: string,
  answers: readonly (readonly PictureHit[])[],
  scope: PictureScope = "all",
  rank: (hit: PictureHit) => number = (hit) => scopeRank(hit, scope),
  score: (hit: PictureHit) => number = (hit) => hitScore(hit, typed),
): PictureHit[] {
  const interleaved: PictureHit[] = [];
  const longest = Math.max(0, ...answers.map((answer) => answer.length));
  for (let index = 0; index < longest; index++) {
    for (const answer of answers) {
      const hit = answer[index];
      if (hit) interleaved.push(hit);
    }
  }
  const mostRated = new Map<string, PictureHit>();
  for (const hit of interleaved) {
    if (hit.kind !== "game") continue;
    const best = mostRated.get(sameThing(hit));
    if (!best || (hit.popularity ?? 0) > (best.popularity ?? 0)) mostRated.set(sameThing(hit), hit);
  }
  const seen = new Set<string>();
  const kept = interleaved.flatMap((found) => {
    const hit = found.kind === "game" ? mostRated.get(sameThing(found)) ?? found : found;
    const keys = [hit.imageUrl, sameThing(hit)];
    if (keys.some((key) => seen.has(key))) return [];
    keys.forEach((key) => seen.add(key));
    return [hit];
  });
  return kept
    .map((hit, order) => ({ hit, order, rank: rank(hit), score: score(hit) }))
    .sort((left, right) => left.rank - right.rank || left.score - right.score || left.order - right.order)
    .map(({ hit }) => hit);
}

/**
 * In Books, a book called exactly what was typed comes first, before people and things, the item
 * Wikidata took the name to mean among them: "Circe" is the novel before the goddess (26.11.2026).
 */
export function exactBooksFirst(hits: readonly PictureHit[], typed: string, scope: PictureScope): PictureHit[] {
  if (scope !== "books") return [...hits];
  const exact = (hit: PictureHit) => hit.kind === "book" && hitScore(hit, typed) === 0;
  return [...hits.filter(exact), ...hits.filter((hit) => !exact(hit))];
}

/** How popular TMDB counts each film, series and person of its answer, by the hit's attribution id. */
export function tmdbPopularity(body: unknown): Map<string, number> {
  return new Map(rows((body as Json | null)?.results).flatMap((row): [string, number][] =>
    typeof row.id === "number" && typeof row.popularity === "number" && typeof row.media_type === "string" ? [[`tmdb:${row.media_type}:${row.id}`, row.popularity]] : []));
}

/**
 * TMDB's films and series called what was typed, most popular first, in the places they held: "Dune"
 * is the 2021 film, then the 1984 one, before the Russian "Бархан" (1989) that TMDB also calls Dune
 * (26.11.2026). The rest keep TMDB's order.
 */
export function namesakesByPopularity(hits: readonly PictureHit[], typed: string, popularity: ReadonlyMap<string, number>): PictureHit[] {
  const named = (hit: PictureHit) => (hit.kind === "movie" || hit.kind === "tv") && hitScore(hit, typed) === 0;
  const of = (hit: PictureHit) => popularity.get(hit.attribution?.id ?? "") ?? 0;
  const sorted = hits.filter(named).sort((left, right) => of(right) - of(left));
  let next = 0;
  return hits.map((hit) => (named(hit) ? sorted[next++]! : hit));
}

/**
 * [first] as it stands, then what [then] adds to it, in [then]'s order: the
 * whole search's answer in the order a person first saw it, the quick part
 * at once and the rest below, so asking again shows the same first tiles.
 */
export function appendNew(first: readonly PictureHit[], then: readonly PictureHit[]): PictureHit[] {
  const seen = new Set(first.flatMap((hit) => [hit.id, hit.imageUrl, sameThing(hit)]));
  return [...first, ...then.filter((hit) => ![hit.id, hit.imageUrl, sameThing(hit)].some((key) => seen.has(key)))];
}

/** Whether a search is worth making: a letter or a digit in it, in any script ("!!!???" and emoji have none). */
export function worthSearching(typed: string): boolean {
  return /[\p{L}\p{N}]/u.test(typed);
}

/**
 * The language a search is made and kept in: the language alone, so a phone's "en-US" and the site's "en"
 * share one answer (18.11.2026). Portuguese keeps Brazil, the app's own, apart from the rest; Chinese keeps
 * its region, which decides the script.
 */
export function searchLanguage(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(raw)) return "en";
  const [base = "en", region] = raw.split("-");
  const language = base.toLowerCase();
  if (language === "pt") return region?.toUpperCase() === "BR" ? "pt-BR" : "pt";
  if (language === "zh" && region) return `zh-${region.length === 2 ? region.toUpperCase() : region.charAt(0).toUpperCase() + region.slice(1).toLowerCase()}`;
  return language;
}

export function hitScore(hit: PictureHit, typed: string): number {
  return Math.min(matchScore(hit.title, typed), hit.alias ? matchScore(hit.alias, typed) : 3);
}

export function goodMatches(typed: string, hits: readonly PictureHit[]): number {
  return hits.filter((hit) => hitScore(hit, typed) < 3).length;
}

// What each catalogue answers, as hits. Each takes the parsed JSON and trusts nothing in it.

type Json = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => typeof row === "object" && row !== null) : [];
}

export const TMDB_IMAGES = "https://image.tmdb.org/t/p/";

export function tmdbHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.results).flatMap((row): PictureHit[] => {
    const type = row.media_type;
    const kind: PictureKind | null = type === "movie" ? "movie" : type === "tv" ? "tv" : type === "person" ? "person" : null;
    const path = text(kind === "person" ? row.profile_path : row.poster_path);
    const title = text(row.title) ?? text(row.name);
    const original = text(row.original_title) ?? text(row.original_name);
    if (!kind || !path || !title || typeof row.id !== "number") return [];
    const date = text(row.release_date) ?? text(row.first_air_date);
    const subtitle = kind === "person" ? text(row.known_for_department) : date?.slice(0, 4) ?? null;
    return [{ id: `tmdb:${row.id}`, title, subtitle, imageUrl: `${TMDB_IMAGES}${TMDB_COPY_SIZE}${path}`, thumbUrl: `${TMDB_IMAGES}w342${path}`, source: "tmdb", kind, attribution: { source: "tmdb", link: `https://www.themoviedb.org/${kind}/${row.id}`, id: `tmdb:${kind}:${row.id}` }, ...(original && original !== title ? { alias: original } : {}) }];
  });
}

export function anilistHits(body: unknown): PictureHit[] {
  const data = ((body as Json | null)?.data ?? {}) as Json;
  const media = rows((data.media as Json | undefined)?.media).flatMap((row): PictureHit[] => {
    const titles = (row.title ?? {}) as Json;
    const title = text(titles.english) ?? text(titles.romaji) ?? text(titles.native);
    // "Shingeki no Kyojin" is AniList's "Attack on Titan": the romaji or native name is matched as the title is.
    const alias = [text(titles.romaji), text(titles.native)].find((name) => name !== null && name !== title) ?? null;
    const cover = (row.coverImage ?? {}) as Json;
    const imageUrl = text(cover.extraLarge) ?? text(cover.large);
    // The tile shows the large cover (230 px), the card keeps the extra large one.
    const thumbUrl = text(cover.large) ?? imageUrl;
    if (!title || !imageUrl || imageUrl.includes("/default.jpg") || typeof row.id !== "number" || row.isAdult === true) return [];
    const kind: PictureKind = row.type === "MANGA" ? "manga" : "anime";
    const year = typeof row.seasonYear === "number" ? String(row.seasonYear) : typeof (row.startDate as Json | undefined)?.year === "number" ? String((row.startDate as Json).year) : null;
    return [{ id: `anilist:${row.id}`, title, subtitle: year, imageUrl, thumbUrl, source: "anilist", kind, attribution: { source: "anilist", link: `https://anilist.co/${kind}/${row.id}`, id: `anilist:${row.id}` }, ...(alias ? { alias } : {}) }];
  });
  const characters = rows((data.characters as Json | undefined)?.characters).flatMap((row): PictureHit[] => {
    const title = text((row.name as Json | undefined)?.full);
    const image = (row.image ?? {}) as Json;
    const imageUrl = text(image.large);
    if (!title || !imageUrl || imageUrl.includes("/default.jpg") || typeof row.id !== "number") return [];
    const from = rows((row.media as Json | undefined)?.nodes)[0];
    const subtitle = from ? text((from.title as Json | undefined)?.english) ?? text((from.title as Json | undefined)?.romaji) : null;
    return [{ id: `anilist:c${row.id}`, title, subtitle, imageUrl, thumbUrl: imageUrl, source: "anilist", kind: "character", attribution: { source: "anilist", link: `https://anilist.co/character/${row.id}`, id: `anilist:c${row.id}` } }];
  });
  return [...media, ...characters];
}

export const ANILIST_QUERY = `query ($q: String, $page: Int) {
  media: Page(page: $page, perPage: 15) { pageInfo { hasNextPage } media(search: $q, sort: SEARCH_MATCH, isAdult: false) {
    id type isAdult seasonYear startDate { year } title { english romaji native } coverImage { extraLarge large } } }
  characters: Page(page: $page, perPage: 10) { characters(search: $q, sort: SEARCH_MATCH) {
    id name { full } image { large } media(perPage: 1) { nodes { title { english romaji } } } } }
}`;

export const IGDB_COVERS = `https://images.igdb.com/igdb/image/upload/${IGDB_COPY_SIZE}/`;
/** The same cover at half the size (264 px), for a tile. */
const IGDB_TILES = "https://images.igdb.com/igdb/image/upload/t_cover_big/";

/** IGDB's games: its cover is always upright, and a game without one is not asked for. */
export const IGDB_QUERY_FIELDS = "name,url,first_release_date,total_rating_count,cover.image_id,cover.width,cover.height";

export function igdbHits(body: unknown): PictureHit[] {
  return rows(body).flatMap((row): PictureHit[] => {
    const title = text(row.name);
    const cover = (row.cover ?? {}) as Json;
    const image = text(cover.image_id);
    if (!title || !image || typeof row.id !== "number" || !/^[a-z0-9]+$/.test(image)) return [];
    if (typeof cover.width === "number" && typeof cover.height === "number" && !fitsTile(cover.width, cover.height, true)) return [];
    const year = typeof row.first_release_date === "number" ? String(new Date(row.first_release_date * 1000).getUTCFullYear()) : null;
    const page = text(row.url);
    const link = page !== null && /^https:\/\/www\.igdb\.com\/games\/[a-z0-9-]{1,200}$/.test(page) ? page : null;
    const rated = typeof row.total_rating_count === "number" && Number.isFinite(row.total_rating_count) && row.total_rating_count > 0 ? Math.round(row.total_rating_count) : null;
    return [{
      id: `igdb:${row.id}`, title, subtitle: year, imageUrl: `${IGDB_COVERS}${image}.jpg`, thumbUrl: `${IGDB_TILES}${image}.jpg`, source: "igdb", kind: "game",
      attribution: { source: "igdb", ...(link ? { link } : {}), id: `igdb:${row.id}` },
      ...(rated === null ? {} : { popularity: rated }),
    }];
  });
}

const STEAM_ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/";

/**
 * Steam names `portrait.png` as the tall cover of many apps it has none for: 22 of 68 such covers in the answers
 * of 21-25.11.2026 answered 404 (soundtracks, demos, DLC, a few games), and nothing in Steam's answer tells them
 * from the 46 that load. These covers are asked for, all at once, and the hits whose cover does not load are left
 * out; every other Steam cover loaded. `loads` answers whether one address gives a picture.
 */
export async function withLoadingCovers(hits: readonly PictureHit[], loads: (url: string) => Promise<boolean>): Promise<PictureHit[]> {
  const doubtful = (hit: PictureHit) => hit.source === "steam" && /\/portrait\.png(?:\?|$)/.test(hit.imageUrl);
  const kept = await Promise.all(hits.map(async (hit) => !doubtful(hit) || (await loads(hit.imageUrl).catch(() => false))));
  return hits.filter((_, index) => kept[index]);
}

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
    // The tile shows the 300 px cover, the card keeps the 600 px one.
    const tile = text(assets.library_capsule) ?? cover;
    if (!title || !format || !cover) return [];
    return [{
      id: `steam:${id}`,
      title,
      subtitle: null,
      imageUrl: STEAM_ASSETS + format.replace("${FILENAME}", cover),
      thumbUrl: tile === null ? null : STEAM_ASSETS + format.replace("${FILENAME}", tile),
      source: "steam",
      kind: "game",
      attribution: { source: "steam", link: `https://store.steampowered.com/app/${id}`, id: `steam:${id}` },
    }];
  });
}

/** Deezer gives a grey silhouette to an artist with no photo; its address has no picture id. */
function deezerPicture(value: unknown): string | null {
  const url = text(value);
  return url && !/\/images\/(artist|cover)\/\//.test(url) ? url : null;
}

/** An artist with this share of the best-known one's fans is a namesake: "Lauryn Hill" with 1,773 under "Ms. Lauryn Hill" with 557,000. */
const NAMESAKE_FANS = 0.01;

export function deezerArtistHits(body: unknown): PictureHit[] {
  const found = rows((body as Json | null)?.data);
  const fans = (row: Json) => (typeof row.nb_fan === "number" ? row.nb_fan : 0);
  const most = Math.max(0, ...found.map(fans));
  return found.filter((row) => fans(row) >= most * NAMESAKE_FANS).flatMap((row): PictureHit[] => {
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
      // The medium cover (180 px) for a tile: the large one is often hundreds of kilobytes.
      thumbUrl: `${covers}-M.jpg`,
      source: "openlibrary",
      kind: "book",
      ...(/^\/works\/OL\d{1,12}W$/.test(key) ? { attribution: { source: "openlibrary" as const, link: `https://openlibrary.org${key}`, id: `openlibrary:${key.slice("/works/".length)}` } } : {}),
    }];
  });
}

/** The properties a Wikidata item's picture can be in, the most telling first: a poster, a cover, a logo, a photo. */
/** Licenses that let anybody show and keep a photo, a commercial app included: no NC, no ND, not "all rights reserved". */
const OPEN_LICENSES = new Set(["cc0", "cc-by", "cc-by-sa", "pd"]);

/**
 * An openly licensed photo a tile can be cut from, or null: CC0, CC BY, CC BY-SA
 * or public domain, said in its own credit, in iNaturalist's open-data bucket,
 * which is what we may copy (`mayCopy`). One on static.inaturalist.org, or
 * licensed NC, ND or not at all, is never offered.
 */
function inaturalistPhoto(raw: unknown): { medium: string; credit: string | null; code: string } | null {
  const photo = (raw ?? {}) as Json;
  const medium = text(photo.medium_url);
  const size = (photo.original_dimensions ?? {}) as Json;
  if (typeof photo.license_code !== "string" || !OPEN_LICENSES.has(photo.license_code)) return null;
  if (!medium || !medium.startsWith("https://")) return null;
  if (typeof size.width !== "number" || typeof size.height !== "number" || !fitsTile(size.width, size.height, false)) return null;
  const found = { medium, credit: text(photo.attribution), code: photo.license_code };
  return mayCopy(medium, { ...inaturalistAttribution(found) }) ? found : null;
}

/** An iNaturalist photo's author, licence and page, from its own attribution and address; the licence from its code when the attribution does not say. */
function inaturalistAttribution(photo: { medium: string; credit: string | null; code?: string }): Omit<PictureAttribution, "originalUrl"> {
  const link = linkFromAddress(photo.medium);
  return { source: "inaturalist", ...(inaturalistLicence(photo.credit) ?? inaturalistLicenceOfCode(photo.code) ?? {}), ...(link ? { link } : {}) };
}

/** Taxa whose default photo will not do, so their other photos are worth asking for. */
export function inaturalistWithoutPhoto(body: unknown): number[] {
  return rows((body as Json | null)?.results)
    .filter((row) => typeof row.id === "number" && inaturalistPhoto(row.default_photo) === null)
    .map((row) => row.id as number);
}

/** Whether any of a taxon's photos would do. */
export function inaturalistHasOpenPhoto(photos: readonly unknown[]): boolean {
  return photos.some((photo) => inaturalistPhoto(photo) !== null);
}

/**
 * The photos of a /v1/observations answer, shaped as a taxon's photos are:
 * an observation names its photo's square copy, the tile wants the medium one.
 */
export function inaturalistObservationPhotos(body: unknown): unknown[] {
  return rows((body as Json | null)?.results).flatMap((row) => rows(row.photos).slice(0, 1)).map((photo) => {
    const url = text(photo.url);
    return { ...photo, medium_url: url ? url.replace(/\/square\.(\w+)$/, "/medium.$1") : null };
  });
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
    const alias = text(row.matched_term);
    return [{
      id: `inaturalist:${row.id}`,
      title,
      subtitle: common ? latin : null,
      imageUrl: photo.medium.replace(/\/medium\.(\w+)$/, "/large.$1"),
      thumbUrl: photo.medium,
      source: "inaturalist",
      // Plants come along in "all" since 18.11.2026: a rose in a list of flowers.
      kind: row.iconic_taxon_name === "Plantae" ? "plant" : "animal",
      ...(photo.credit ? { credit: photo.credit } : {}),
      attribution: inaturalistAttribution(photo),
      ...(alias && alias !== title ? { alias } : {}),
    }];
  });
}

const WIKIDATA_PICTURES = ["P3383", "P18", "P154", "P2716"];
/** Where an item says what it is on TMDB, so the same film is not shown twice. */
const WIKIDATA_TMDB = { P4947: "movie", P4983: "tv", P4985: "person" } as const;

/** What an item is (P31) that makes it music: bands, albums, singles, songs, musical works. */
const WIKIDATA_MUSIC = new Set(["Q215380", "Q5741069", "Q9212979", "Q216337", "Q641066", "Q482994", "Q208569", "Q209939", "Q222910", "Q169930", "Q134556", "Q7366", "Q105543609"]);

/** Music: an item Wikidata gives a genre (P136), or one of the music classes; a city, a title or a church has neither. */
export function isMusicItem(claims: Record<string, unknown>): boolean {
  if (rows(claims.P136).length > 0) return true;
  return rows(claims.P31).some((row) => {
    const value = ((row.mainsnak as Json | undefined)?.datavalue as Json | undefined)?.value as Json | undefined;
    return WIKIDATA_MUSIC.has(text(value?.id) ?? "");
  });
}

export interface WikidataCandidate {
  hit: PictureHit;
  /** The first of [files]: the picture [hit] shows until Commons says which fits. */
  file: string;
  /** Every picture the item names, the most telling first, at most [WIKIDATA_FILES]: a wide first one gives way to the next. */
  files: string[];
  tmdbIds: string[];
}

/** Pictures of one item looked at, so a panorama or a banner gives way to another of the same thing. */
export const WIKIDATA_FILES = 3;

/** How Commons names a file: spaces, not underscores, and a capital first letter. */
export function commonsName(file: string): string {
  const spaced = file.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Commons `imageinfo` sizes: the files that make good tiles, by their Commons names. */
export function commonsFitting(body: unknown, covers: boolean): Set<string> {
  return new Set(commonsPictures(body, covers).keys());
}

/** Fitting files with their supplied attribution; an overlong known credit is never silently cut. */
export function commonsPictures(body: unknown, covers: boolean): Map<string, { credit?: string; attribution: Omit<PictureAttribution, "originalUrl"> }> {
  const pages = ((((body as Json | null)?.query as Json | undefined)?.pages ?? {}) as Record<string, Json>);
  const pictures = new Map<string, { credit?: string; attribution: Omit<PictureAttribution, "originalUrl"> }>();
  for (const page of Object.values(pages)) {
    const info = rows(page.imageinfo)[0];
    const title = text(page.title);
    if (!title || typeof info?.width !== "number" || typeof info?.height !== "number" || !fitsTile(info.width, info.height, covers)) continue;
    const credit = commonsCredit(page, info);
    if (credit === null) continue;
    // Only a file whose licence Commons states: one we may copy (`mayCopy`).
    const details = commonsDetails(page, info);
    if (details === undefined) continue;
    const attribution = { source: "wikimedia" as const, ...details };
    pictures.set(commonsName(title.replace(/^File:/, "")), { ...(credit ? { credit } : {}), attribution });
  }
  return pictures;
}

export { commonsThumb };

/** `wbgetentities` with labels, descriptions and claims, in the order `wbsearchentities` found the ids. */
export function wikidataCandidates(ids: readonly string[], body: unknown, language: string, onlyMusic = false, matched: ReadonlyMap<string, string> = new Map()): WikidataCandidate[] {
  const entities = ((body as Json | null)?.entities ?? {}) as Record<string, Json>;
  return ids.flatMap((id): WikidataCandidate[] => {
    const entity = entities[id];
    if (!entity) return [];
    const claims = (entity.claims ?? {}) as Record<string, unknown>;
    if (onlyMusic && !isMusicItem(claims)) return [];
    const files = [...new Set(WIKIDATA_PICTURES.flatMap((property) => stringClaims(claims[property])))].slice(0, WIKIDATA_FILES);
    const file = files[0] ?? null;
    const title = labelIn(entity.labels, language);
    if (!file || !title) return [];
    // The name the search found it by, when not its title here: "Киев" finds Kyiv on an English page.
    const alias = matched.get(id);
    const about = text(((entity.descriptions ?? {}) as Record<string, Json>).en?.value);
    const tmdbIds = Object.entries(WIKIDATA_TMDB).flatMap(([property, kind]) => {
      const value = firstStringClaim(claims[property]);
      return value ? [`${kind}:${value}`] : [];
    });
    return [{
      hit: {
        id: `wikidata:${id}`,
        title,
        subtitle: labelIn(entity.descriptions, language),
        imageUrl: commonsThumb(file, COMMONS_CARD_WIDTH),
        thumbUrl: commonsThumb(file, 400),
        source: "wikidata",
        kind: "thing",
        ...(alias && alias !== title ? { alias } : {}),
        ...(about ? { about } : {}),
      },
      file,
      files,
      tmdbIds,
    }];
  });
}

/**
 * A Wikidata label or description in [language], its base language, English,
 * then `mul` (a name the same in every language, kept there alone), then any.
 */
function labelIn(labels: unknown, language: string): string | null {
  const byLanguage = (labels ?? {}) as Record<string, Json>;
  const base = language.split("-")[0] ?? language;
  return text(byLanguage[language]?.value) ?? text(byLanguage[base]?.value) ?? text(byLanguage.en?.value) ?? text(byLanguage.mul?.value) ??
    text(Object.values(byLanguage)[0]?.value);
}

/** Every value of a claim that is a string, in Wikidata's order, the preferred ones first and no deprecated one. */
function stringClaims(claim: unknown): string[] {
  const all = rows(claim).filter((row) => row.rank !== "deprecated");
  return [...all.filter((row) => row.rank === "preferred"), ...all.filter((row) => row.rank !== "preferred")].flatMap((row) => {
    const value = text(((row.mainsnak as Json | undefined)?.datavalue as Json | undefined)?.value);
    return value ? [value] : [];
  });
}

function firstStringClaim(claim: unknown): string | null {
  const first = rows(claim)[0];
  const value = ((first?.mainsnak as Json | undefined)?.datavalue as Json | undefined)?.value;
  return text(value);
}

/**
 * The candidate with the first of its pictures Commons says fits ([good], by Commons name), shown by that
 * picture with its credit; null when none does.
 */
export function fittingPicture(
  candidate: WikidataCandidate,
  good: ReadonlyMap<string, { credit?: string; attribution: Omit<PictureAttribution, "originalUrl"> }>,
): WikidataCandidate | null {
  for (const file of candidate.files.length > 0 ? candidate.files : [candidate.file]) {
    const picture = good.get(commonsName(file));
    if (!picture) continue;
    return { ...candidate, file, hit: { ...candidate.hit, imageUrl: commonsThumb(file, COMMONS_CARD_WIDTH), thumbUrl: commonsThumb(file, 400), ...picture } };
  }
  return null;
}

/** A TMDB hit's own key in the shape Wikidata names it. */
export function tmdbKeyOf(hit: PictureHit): string | null {
  return hit.source === "tmdb" ? `${hit.kind}:${hit.id.slice("tmdb:".length)}` : null;
}

export function webHits(body: unknown): PictureHit[] {
  return rows((body as Json | null)?.images).flatMap((row): PictureHit[] => {
    const found = text(row.imageUrl);
    const title = text(row.title);
    if (!found || !found.startsWith("https://") || !title) return [];
    // A Commons original is often many megabytes (7.2 MB, a risotto, 24.11.2026), more than a kept picture
    // may be: it is asked for at 600 px, as a hit from Wikidata is.
    const imageUrl = commonsPictureOf(found);
    if (typeof row.imageWidth !== "number" || typeof row.imageHeight !== "number" || !fitsTile(row.imageWidth, row.imageHeight, false)) return [];
    // The page the picture stands on: whose it is and under what terms is said there, not by the search.
    const link = pageLink(row.link);
    // The tile shows a small copy, never the picture itself, which may be megabytes on a slow site (25.11.2026):
    // a Commons file at 400 px, as Wikidata's hits are, or else the search engine's own thumbnail.
    const file = commonsFileOf(found);
    const thumbnail = text(row.thumbnailUrl);
    const thumbUrl = file !== null ? commonsThumb(file, 400) : thumbnail !== null && thumbnail.startsWith("https://") ? thumbnail : null;
    return [{
      id: `web:${hashOf(imageUrl)}`,
      title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
      subtitle: text(row.source) ?? text(row.domain),
      imageUrl,
      thumbUrl,
      source: "web",
      kind: "web",
      attribution: link ? { source: "web", link } : { source: "web" },
    }];
  });
}

/** A short stable id for a web picture; not a security hash. */
function hashOf(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
