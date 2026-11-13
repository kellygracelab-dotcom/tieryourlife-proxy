/**
 * Where a card's picture came from and whom it names, as fields of their own
 * beside the old `credit` text. Clients used to read the source off the
 * address, which says nothing once the picture is a copy of ours. Pure: the
 * copying and the Commons lookups are in `cataloguePictures.ts`.
 *
 * Which catalogue pictures we may keep a copy of was read off each one's terms
 * on 13.11.2026 and decided by Danylo the same day: iNaturalist's openly
 * licensed photos and Commons files, with their author, licence and page.
 * TMDB (six months at most), AniList (no storage), Steam (no grant) and IGDB
 * (until it confirms in writing) stay where the catalogue keeps them.
 */
import { createHash } from "node:crypto";
import { storageMediaUrl } from "./publicMedia";

export type AttributionSource = "tmdb" | "anilist" | "igdb" | "steam" | "deezer" | "openlibrary" | "inaturalist" | "wikimedia" | "web";

export interface PictureAttribution {
  source: AttributionSource;
  /** The person the licence asks to be named: an iNaturalist observer, a Commons author. Plain text. */
  author?: string;
  /** The licence's short name: "CC BY 4.0", "CC0 1.0", "Public domain". */
  license?: string;
  licenseUrl?: string;
  /** A page about this picture, or about its title, on the source's own site. */
  link?: string;
  /** Set only while `imageUrl` is our copy: the catalogue address it was copied from. */
  originalUrl?: string;
  /**
   * The catalogue's own id for what the picture shows, as its search hit names
   * it (`catalogueIdOf`): how a dead address is looked up again, and how
   * TMDB's and IGDB's data are refreshed.
   */
  id?: string;
  /** Addresses the card showed before the catalogue moved its picture, oldest first; set only by the server. */
  formerUrls?: string[];
  /**
   * Author, licence and page given by the house's editor (`manualAttribution.ts`),
   * kept as given: publishing, the backfill and `refreshPictures` never work them out again.
   */
  manual?: true;
}

/** A credit the house's editor gave: a licence and the page it stands on always, the author and the deed where known. */
export type ManualAttribution = Pick<PictureAttribution, "author" | "licenseUrl"> & { license: string; link: string; manual: true };

/** The editor's credit a stored attribution carries, or null. */
export function manualOf(attribution: PictureAttribution | null | undefined): ManualAttribution | null {
  if (attribution?.manual !== true || !attribution.license || !attribution.link) return null;
  return {
    ...(attribution.author ? { author: attribution.author } : {}),
    license: attribution.license,
    ...(attribution.licenseUrl ? { licenseUrl: attribution.licenseUrl } : {}),
    link: attribution.link,
    manual: true,
  };
}

/** A card's attribution with the editor's credit over it: the source, id and addresses stay the server's; a picture of nowhere known is `web`. */
export function withManual(derived: PictureAttribution | null, manual: ManualAttribution): PictureAttribution {
  const { author: _author, license: _license, licenseUrl: _licenseUrl, link: _link, manual: _manual, ...kept } = derived ?? { source: "web" as const };
  return { ...kept, ...manual };
}

export const MAX_AUTHOR_LENGTH = 300;
export const MAX_LICENSE_LENGTH = 100;
export const MAX_LINK_LENGTH = 500;
export const MAX_FORMER_URLS = 5;

/** The ids each catalogue's hits carry, in the one shape kept. */
const IDS: Partial<Record<AttributionSource, RegExp>> = {
  tmdb: /^tmdb:(movie|tv|person):\d{1,10}$/,
  anilist: /^anilist:c?\d{1,10}$/,
  igdb: /^igdb:\d{1,10}$/,
  steam: /^steam:\d{1,10}$/,
  openlibrary: /^openlibrary:OL\d{1,12}[WM]$/,
};

/** [raw] as an id of [source], or null. */
export function catalogueIdOf(source: AttributionSource, raw: unknown): string | null {
  const shape = IDS[source];
  return shape !== undefined && typeof raw === "string" && shape.test(raw) ? raw : null;
}

/** The id an address or a catalogue page says itself, where it does: then a client's cannot differ. */
export function idFromAddress(url: string, link: string | null | undefined): string | null {
  const source = catalogueSourceOf(url);
  if (source === null) return null;
  for (const page of [linkFromAddress(url), link ?? null]) {
    const one = page === null ? null : parsed(page);
    if (one === null) continue;
    const path = one.pathname;
    let id: string | null = null;
    if (source === "tmdb" && one.hostname === "www.themoviedb.org") id = /^\/(movie|tv|person)\/(\d{1,10})$/.exec(path)?.slice(1).join(":") ?? null;
    if (source === "anilist" && one.hostname === "anilist.co") {
      const match = /^\/(anime|manga|character)\/(\d{1,10})$/.exec(path);
      id = match ? `${match[1] === "character" ? "c" : ""}${match[2]}` : null;
    }
    if (source === "steam" && one.hostname === "store.steampowered.com") id = /^\/app\/(\d{1,10})$/.exec(path)?.[1] ?? null;
    if (source === "openlibrary" && one.hostname === "openlibrary.org") id = /^\/(?:works|books)\/(OL\d{1,12}[WM])$/.exec(path)?.[1] ?? null;
    if (id !== null) return catalogueIdOf(source, `${source}:${id}`);
  }
  return null;
}

/**
 * Where the catalogues the app and the site search keep their art, and whose
 * each host is. Exact hosts: a lookalike or another subdomain is no catalogue.
 */
export const HOST_SOURCES: Readonly<Record<string, AttributionSource>> = {
  "image.tmdb.org": "tmdb",
  "s4.anilist.co": "anilist",
  "images.igdb.com": "igdb",
  "shared.akamai.steamstatic.com": "steam",
  // Deezer is no longer searched, but lists published before keep its covers as they are.
  "cdn-images.dzcdn.net": "deezer",
  "e-cdns-images.dzcdn.net": "deezer",
  "covers.openlibrary.org": "openlibrary",
  "inaturalist-open-data.s3.amazonaws.com": "inaturalist",
  "static.inaturalist.org": "inaturalist",
  "commons.wikimedia.org": "wikimedia",
  "upload.wikimedia.org": "wikimedia",
  "thumb.wikimedia.org": "wikimedia",
};

/**
 * Wikimedia's file hosts: `upload` and `thumb` (its thumbnail host) answer the
 * same paths with the same bytes, Commons' files under `/wikipedia/commons/`
 * and each local Wikipedia's own under `/wikipedia/{wiki}/`.
 */
const WIKIMEDIA_FILE_HOSTS: ReadonlySet<string> = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);

/** The hosts a published list may show pictures from as they are (`outsidePictures.ts`). */
export const CATALOGUE_HOSTS: ReadonlySet<string> = new Set(Object.keys(HOST_SOURCES));

/** The file a picture from [url] is kept under: the same address always lands on the same copy. */
export function outsideName(url: string): string {
  return `w-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

function parsed(url: string | null | undefined): URL | null {
  if (typeof url !== "string") return null;
  try {
    const one = new URL(url);
    return one.protocol === "https:" && !one.username && !one.password && one.port === "" ? one : null;
  } catch {
    return null;
  }
}

/** The catalogue a picture's own address is on, or null for any other address. */
export function catalogueSourceOf(url: string | null | undefined): AttributionSource | null {
  const one = parsed(url);
  if (one === null || !CATALOGUE_HOSTS.has(one.hostname)) return null;
  // A local Wikipedia's own uploads (fair use under /wikipedia/en/ and the like) carry no free licence: a picture from another site.
  if (WIKIMEDIA_FILE_HOSTS.has(one.hostname) && !one.pathname.startsWith("/wikipedia/commons/")) return null;
  return HOST_SOURCES[one.hostname] ?? null;
}

/** The page a picture from another site was found on, as a person gives it: any https page, in one short shape. */
export function pageLink(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_LINK_LENGTH) return null;
  const one = parsed(raw.trim());
  if (one === null || !one.hostname.includes(".")) return null;
  return one.href.length <= MAX_LINK_LENGTH ? one.href : null;
}

// Each catalogue's pages, in the one shape a link to them is kept in. A client
// sends back the link a search gave it; anything else is not kept.
const PAGES: Partial<Record<AttributionSource, { host: string; path: RegExp }>> = {
  tmdb: { host: "www.themoviedb.org", path: /^\/(movie|tv|person)\/\d{1,12}$/ },
  anilist: { host: "anilist.co", path: /^\/(anime|manga|character)\/\d{1,12}$/ },
  igdb: { host: "www.igdb.com", path: /^\/games\/[a-z0-9-]{1,200}$/ },
  steam: { host: "store.steampowered.com", path: /^\/app\/\d{1,12}$/ },
  openlibrary: { host: "openlibrary.org", path: /^\/(works|books)\/OL\d{1,12}[WM]$/ },
  inaturalist: { host: "www.inaturalist.org", path: /^\/photos\/\d{1,12}$/ },
};

/** A link a client sent for a picture from [source], as kept; null unless it is one of that catalogue's own pages. */
export function sourceLink(source: AttributionSource, raw: unknown): string | null {
  const page = PAGES[source];
  const url = typeof raw === "string" && raw.length <= MAX_LINK_LENGTH ? parsed(raw) : null;
  if (!page || url === null || url.hostname !== page.host || url.search !== "" || url.hash !== "") return null;
  const path = url.pathname.replace(/\/$/, "");
  return page.path.test(path) ? `https://${page.host}${path}` : null;
}

const INATURALIST_PHOTO = /^\/photos\/(\d{1,12})\/(?:original|large|medium|small|square|thumb)\.(jpe?g|png|gif|webp)$/i;

/** The page an address says itself, where it does. */
export function linkFromAddress(url: string): string | null {
  const one = parsed(url);
  if (one === null) return null;
  switch (HOST_SOURCES[one.hostname]) {
    case "steam": {
      const app = /\/steam\/apps\/(\d{1,12})\//.exec(one.pathname)?.[1];
      return app ? `https://store.steampowered.com/app/${app}` : null;
    }
    case "inaturalist": {
      const photo = INATURALIST_PHOTO.exec(one.pathname)?.[1];
      return photo ? `https://www.inaturalist.org/photos/${photo}` : null;
    }
    case "anilist": {
      const character = /\/character\/(?:large|medium)\/b(\d{1,12})-/.exec(one.pathname)?.[1];
      return character ? `https://anilist.co/character/${character}` : null;
    }
    case "openlibrary": {
      const book = /^\/b\/olid\/(OL\d{1,12}M)-[SML]\.jpg$/.exec(one.pathname)?.[1];
      return book ? `https://openlibrary.org/books/${book}` : null;
    }
    default:
      return null;
  }
}

const OPEN_LICENSES: Record<string, { license: string; licenseUrl: string }> = {
  "CC BY": { license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
  "CC BY-SA": { license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" },
  CC0: { license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" },
  PD: { license: "Public domain", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/" },
};

/**
 * An iNaturalist photo's `attribution`, as its search hit carried it in
 * `credit`, read back into its parts. Only the licences search lets through
 * (CC BY, CC BY-SA, CC0, public domain); anything else is null. A taxon's
 * photo from elsewhere ends ", uploaded by {curator}": the author is still
 * the one named first, or the curator when nobody is.
 */
export function inaturalistLicence(credit: string | null | undefined): { author?: string; license: string; licenseUrl: string } | null {
  const whole = decodeEntities((credit ?? "").replace(/\s+/g, " ").trim());
  const upload = /^(.*), uploaded by (.+)$/.exec(whole);
  const text = upload?.[1] ?? whole;
  const named = (name: string | undefined) => {
    const author = (name || upload?.[2] || "").trim().slice(0, MAX_AUTHOR_LENGTH);
    return author ? { author } : {};
  };
  const some = /^\(c\) (.+), some rights reserved \((CC BY(?:-SA)?)\)$/.exec(text);
  if (some) return { ...named(some[1]), ...OPEN_LICENSES[some[2]] };
  const none = /^(?:\(c\) )?(?:(.+), )?no rights reserved(?: \(CC0\))?$/.exec(text);
  if (none) return { ...named(none[1]), ...OPEN_LICENSES.CC0 };
  const free = /^(?:(.+), )?no known copyright restrictions \(public domain\)$/.exec(text);
  if (free) return { ...named(free[1]), ...OPEN_LICENSES.PD };
  return null;
}

/** The few entities iNaturalist's attributions carry ("Jan Ebr &amp; Ivana Ebrová"). */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, key: string) => {
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? entity;
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

/**
 * A Commons file's name from its address: `Special:FilePath`, the file's own
 * page (`/wiki/File:…`, as people copy it from the browser) or Commons' own
 * upload folder, never a local wiki's.
 */
export function commonsFileOf(url: string): string | null {
  const one = parsed(url);
  if (one === null) return null;
  let name: string | null = null;
  try {
    if (one.hostname === "commons.wikimedia.org") {
      name = /^\/wiki\/(?:Special:FilePath\/|File:)([^/]+)$/.exec(one.pathname)?.[1] ?? null;
    } else if (WIKIMEDIA_FILE_HOSTS.has(one.hostname)) {
      const match = /^\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)(?:\/[^/]+)?$/.exec(one.pathname);
      name = match?.[1] ?? null;
    }
    name = name === null ? null : decodeURIComponent(name).replace(/_/g, " ").trim();
  } catch {
    return null;
  }
  if (!name || /[|#<>[\]{}]/.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A Commons file's picture, [width] pixels wide, as a search hit shows it. */
export function commonsThumb(file: string, width: number): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=${width}`;
}

/** The width a card asks a Commons file at, as search hits do: `Special:FilePath` serves its 960 px thumbnail. */
export const COMMONS_CARD_WIDTH = 600;
/** The widest `Special:FilePath` a card keeps as sent: wider is bytes nobody sees. */
const COMMONS_WIDEST = 1280;
/**
 * The widths Wikimedia makes thumbnails at (https://w.wiki/GHai). A direct
 * thumbnail (`…/thumb/…/{n}px-{name}`) at any other answers 400 since 2026;
 * `Special:FilePath` rounds any width up to one of these.
 */
export const COMMONS_THUMB_WIDTHS: ReadonlySet<number> = new Set([20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]);

/**
 * A Commons address as a card keeps it: a file page (`/wiki/File:…`, HTML no
 * card can show), a `Special:FilePath` without a width or wider than 1280, the
 * uploaded original, or a direct thumbnail at a width Wikimedia does not make
 * becomes `Special:FilePath/{name}?width=600`, as search hits are. Any other
 * Commons address, and every other address, as it is.
 */
export function commonsPictureOf(url: string): string {
  const one = parsed(url);
  const file = one === null ? null : commonsFileOf(url);
  if (one === null || file === null) return url;
  if (one.hostname === "commons.wikimedia.org" && one.pathname.startsWith("/wiki/Special:FilePath/")) {
    const width = one.searchParams.get("width");
    return width !== null && /^\d{1,4}$/.test(width) && Number(width) > 0 && Number(width) <= COMMONS_WIDEST ? url : commonsThumb(file, COMMONS_CARD_WIDTH);
  }
  const thumb = /^\/wikipedia\/commons\/thumb\/.+\/(\d{1,4})px-[^/]+$/.exec(one.pathname);
  if (thumb && COMMONS_THUMB_WIDTHS.has(Number(thumb[1])) && Number(thumb[1]) <= COMMONS_WIDEST) return url;
  return commonsThumb(file, COMMONS_CARD_WIDTH);
}

/** What Commons says about a file, as `commonsDetails` reads it. */
export interface CommonsDetails {
  author?: string;
  license?: string;
  licenseUrl?: string;
  link: string;
}

/**
 * The attribution of a picture at catalogue address [original], from what the
 * server knows: the address itself, the iNaturalist credit the card carries,
 * what Commons says about its file, and a page link the client sent back.
 */
export function attributionOf(
  original: string,
  { credit, sentLink, sentId, commons }: { credit?: string; sentLink?: unknown; sentId?: unknown; commons?: ReadonlyMap<string, CommonsDetails> },
): PictureAttribution | null {
  const source = catalogueSourceOf(original);
  if (source === null) return null;
  if (source === "wikimedia") {
    const file = commonsFileOf(original);
    const details = file === null ? undefined : commons?.get(file);
    if (details) return { source, ...details };
    return file === null ? { source } : { source, link: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, "_"))}` };
  }
  const link = linkFromAddress(original) ?? sourceLink(source, sentLink);
  const licence = source === "inaturalist" ? inaturalistLicence(credit) : null;
  // What the address or its page says wins; a client's id is kept only where they say nothing.
  const id = idFromAddress(original, link) ?? catalogueIdOf(source, sentId);
  return { source, ...(licence ?? {}), ...(link ? { link } : {}), ...(id ? { id } : {}) };
}

/**
 * Whether we may keep a copy of the picture at [original]: an openly
 * licensed iNaturalist photo from its open-data bucket, or a Commons file
 * whose licence Commons names. The licence must be known before copying.
 */
export function mayCopy(original: string, attribution: PictureAttribution | null): boolean {
  if (attribution === null || !attribution.license) return false;
  const host = parsed(original)?.hostname;
  if (attribution.source === "inaturalist") return host === "inaturalist-open-data.s3.amazonaws.com" && INATURALIST_PHOTO.test(parsed(original)!.pathname);
  return attribution.source === "wikimedia" && commonsFileOf(original) !== null;
}

/**
 * The catalogue's own picture that the copy is made from: about 500 px on its
 * long side for Commons and iNaturalist, a TMDB original at 500 px, the
 * address as it is for the other catalogues (their card sizes already).
 */
export function copySourceOf(original: string): string | null {
  const one = parsed(original);
  if (one === null) return null;
  const source = catalogueSourceOf(one.href);
  if (source === "tmdb") return one.href.replace(/\/t\/p\/original\//, "/t/p/w500/");
  if (source === "anilist" || source === "igdb" || source === "steam" || source === "openlibrary") return one.href;
  if (one.hostname === "inaturalist-open-data.s3.amazonaws.com") {
    return INATURALIST_PHOTO.test(one.pathname) ? one.href.split("?")[0].replace(/\/(?:original|large|medium|small|square|thumb)\.(\w+)$/i, "/medium.$1") : null;
  }
  const file = commonsFileOf(original);
  return file === null ? null : `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=500`;
}

/** A copy's name in our bucket, `w-{32 hex}`, whatever list it was copied into and by whichever attempt. */
const COPY_NAME = /\/o\/published%2F[^/?#%]+%2F(?:[A-Za-z0-9_]+-)*(w-[0-9a-f]{32})(?:_p_[a-f0-9-]{36})?(?:[?#]|$)/i;

export function copyNameOf(url: string): string | null {
  return COPY_NAME.exec(storageMediaUrl(url))?.[1] ?? null;
}

/** Whether [original] is the address the copy at [copy] was made from. */
export function isCopyOf(copy: string, original: string): boolean {
  return catalogueSourceOf(original) !== null && copyNameOf(copy) === outsideName(original);
}

/**
 * One key for a picture, whichever address it is shown at: a picture from
 * another site and every copy of it, in any list, are the same picture.
 */
export function pictureKey(url: string): string {
  const copy = copyNameOf(url);
  if (copy !== null) return `copy:${copy}`;
  const stored = storageMediaUrl(url);
  return stored.startsWith("https://firebasestorage.googleapis.com/") ? stored : `copy:${outsideName(url)}`;
}

/** An attribution as stored and sent: only known fields, each within its limit. */
export function cleanAttribution(value: PictureAttribution): PictureAttribution {
  const short = (text: string | undefined, max: number) => (text ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const author = short(value.author, MAX_AUTHOR_LENGTH);
  const license = short(value.license, MAX_LICENSE_LENGTH);
  const licenseUrl = value.licenseUrl && value.licenseUrl.length <= MAX_LINK_LENGTH && parsed(value.licenseUrl) ? value.licenseUrl : "";
  const link = value.link && value.link.length <= MAX_LINK_LENGTH && parsed(value.link) ? value.link : "";
  const formerUrls = cleanFormerUrls(value.formerUrls);
  return {
    source: value.source,
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(licenseUrl ? { licenseUrl } : {}),
    ...(link ? { link } : {}),
    ...(value.originalUrl ? { originalUrl: value.originalUrl } : {}),
    ...(catalogueIdOf(value.source, value.id) ? { id: value.id } : {}),
    ...(formerUrls.length > 0 ? { formerUrls } : {}),
    ...(value.manual === true ? { manual: true as const } : {}),
  };
}

/** Earlier catalogue addresses of one card, as kept: distinct, short, newest kept. */
function cleanFormerUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kept = raw.filter((one): one is string => typeof one === "string" && one.length <= MAX_LINK_LENGTH && catalogueSourceOf(one) !== null);
  return [...new Set(kept)].slice(-MAX_FORMER_URLS);
}

const SOURCES: readonly AttributionSource[] = ["tmdb", "anilist", "igdb", "steam", "deezer", "openlibrary", "inaturalist", "wikimedia", "web"];

/**
 * An attribution a client keeps on a private board, as stored: a known
 * source, short text and https links. A publication works its own out again.
 */
export function readAttribution(raw: unknown): PictureAttribution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const source = SOURCES.find((known) => known === value.source);
  if (!source) return null;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const original = text("originalUrl");
  return cleanAttribution({
    source,
    author: text("author"),
    license: text("license"),
    licenseUrl: text("licenseUrl"),
    link: text("link"),
    originalUrl: original && original.length <= MAX_LINK_LENGTH && catalogueSourceOf(original) !== null ? original : undefined,
    id: text("id"),
    formerUrls: Array.isArray(value.formerUrls) ? (value.formerUrls as string[]) : undefined,
    manual: value.manual === true ? true : undefined,
  });
}
