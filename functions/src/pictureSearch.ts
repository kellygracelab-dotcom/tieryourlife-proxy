/**
 * GET /lists/pictures: the catalogues a scope names, asked together, each
 * on its own clock, so one that is slow or down only leaves its own gap.
 * With part=quick only the fast ones are asked and the web is not; `rest`
 * says whether the whole search would add anything, so a client shows the
 * quick answer at once and the whole one's new hits below it.
 * The paid web search is asked last and only when it is worth it
 * (src/pictureSources.ts, decideWeb). POST /lists/pictures/keep copies a
 * picture from the web into the person's own folder, for a browser that
 * cannot read another site's bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Response } from "express";
import { defineSecret } from "firebase-functions/params";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Identity } from "./auth";
import { isDemoEmulator, STUB_PICTURE } from "./emulator";
import {
  ANILIST_QUERY,
  anilistHits,
  commonsFitting,
  commonsName,
  decideWeb,
  deezerAlbumHits,
  deezerArtistHits,
  goodMatches,
  hasSlowSources,
  IGDB_QUERY_FIELDS,
  igdbHits,
  inaturalistHits,
  inaturalistObservationPhotos,
  inaturalistPhotos,
  inaturalistWithoutPhoto,
  mergeHits,
  openLibraryHits,
  PictureHit,
  PictureScope,
  pictureScopeOf,
  PictureSource,
  quickSourcesFor,
  sourcesFor,
  steamAppIds,
  steamHits,
  tmdbHits,
  tmdbKeyOf,
  webHits,
  WikidataCandidate,
  wantsCovers,
  wikidataCandidates,
} from "./pictureSources";
import { dayKey } from "./quota";
import { fold } from "./search";

export const pictureTmdbToken = defineSecret("TMDB_READ_ACCESS_TOKEN");
export const igdbClientId = defineSecret("IGDB_CLIENT_ID");
export const igdbClientSecret = defineSecret("IGDB_CLIENT_SECRET");

const SOURCE_TIMEOUT_MS = 5_000;
const CACHE = "pictureCache";
const CACHE_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
/** Raised whenever an answer holds something different, so answers kept from before are not served. */
const CACHE_SHAPE = 6;
const WEB_USAGE = "pictureWeb";
const WEB_SWITCH = "config/pictureWeb";
/** Out of credits, or refused: the web is left alone this long before it is tried again. */
const WEB_REST_MS = 60 * 60 * 1000;
// Wikimedia throttles a client that names no way to reach it.
const USER_AGENT = "TierYourLife/1.0 (https://tieryourlife.web.app; com.artiuillab.tieryourlife; server)";
/** Open Library's search often takes six or seven seconds, and a books search has nothing else to wait for. */
const OPEN_LIBRARY_TIMEOUT_MS = 9_000;
/** Taxa whose open photo is looked for among their best-liked observations, one request each. */
const INATURALIST_OBSERVED = 6;
const MAX_QUERY = 100;
const MAX_PAGE = 20;

interface PicturesAnswer {
  items: PictureHit[];
  hasMore: boolean;
  notices: string[];
  /** Quick answers only: whether the whole search can find more. */
  rest?: boolean;
}

export async function routePictures(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  if (method === "GET" && rest.length === 0) {
    const typed = typeof query.q === "string" ? query.q.trim().slice(0, MAX_QUERY) : "";
    if ([...typed].length < 2) {
      response.status(400).json({ error: "Type at least two letters", code: "QUERY_TOO_SHORT" });
      return;
    }
    const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1));
    const answer = await searchPictures({
      typed,
      scope: pictureScopeOf(query.scope),
      language: typeof query.lang === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(query.lang) ? query.lang : "en",
      page,
      forcedWeb: query.web === "1" || query.web === "true",
      quick: query.part === "quick",
      uid: identity.uid,
    });
    if (answer === null) {
      response.status(502).json({ error: "No catalogue answered", code: "SOURCES_DOWN" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(answer);
    return;
  }
  if (method === "POST" && rest.length === 1 && rest[0] === "keep") {
    const url = (body as { url?: unknown } | null)?.url;
    if (typeof url !== "string") {
      response.status(400).json({ error: "Which picture?", code: "NO_URL" });
      return;
    }
    const kept = await keepPicture(url, identity.uid);
    if ("error" in kept) {
      response.status(422).json({ error: "That picture could not be kept", code: kept.error });
      return;
    }
    response.status(200).json(kept);
    return;
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

interface SearchInput {
  typed: string;
  scope: PictureScope;
  language: string;
  page: number;
  forcedWeb: boolean;
  quick: boolean;
  uid: string;
}

/** Null only when every catalogue asked failed: an empty answer from catalogues that worked is still an answer. */
export async function searchPictures(input: SearchInput): Promise<PicturesAnswer | null> {
  if (isDemoEmulator()) return { items: [], hasMore: false, notices: [], ...(input.quick ? { rest: false } : {}) };
  const db = getFirestore();
  const key = (web: boolean, quick = false) =>
    createHash("sha256")
      .update([CACHE_SHAPE, fold(input.typed), input.scope, input.language, input.page, web ? "web" : "", quick ? "quick" : ""].join("|"))
      .digest("hex");
  const fresh = async (id: string): Promise<PicturesAnswer | null> => {
    const doc = await db.collection(CACHE).doc(id).get();
    const at = doc.get("at")?.toMillis?.() ?? 0;
    return doc.exists && Date.now() - at < CACHE_FRESH_MS ? { items: doc.get("items") ?? [], hasMore: doc.get("hasMore") === true, notices: [] } : null;
  };

  // Somebody already paid for the web on this search: it costs nothing to show again.
  const cachedWithWeb = await fresh(key(true));
  if (cachedWithWeb) return input.quick ? { ...cachedWithWeb, rest: false } : cachedWithWeb;
  let catalogues = await fresh(key(false));
  const webLater = input.page === 1 && (input.scope === "all" || input.forcedWeb);
  if (input.quick && catalogues) return { ...catalogues, rest: webLater };
  if (input.quick) {
    const quick = (await fresh(key(false, true))) ?? (await askCatalogues(input, quickSourcesFor(input.scope), key(false, true)));
    const rest = hasSlowSources(input.scope) || webLater;
    return quick ? { ...quick, rest } : rest ? { items: [], hasMore: false, notices: [], rest } : null;
  }

  catalogues ??= await askCatalogues(input, sourcesFor(input.scope), key(false));
  if (!catalogues) return null;
  if (input.page > 1) return catalogues;
  const web = await maybeAskWeb(input, goodMatches(input.typed, catalogues.items));
  if (web.notice) return { ...catalogues, notices: [web.notice] };
  if (!web.hits) return catalogues;
  const items = mergeHits(input.typed, [catalogues.items, web.hits]);
  const withWeb = { items, hasMore: catalogues.hasMore, notices: [] };
  await db.collection(CACHE).doc(key(true)).set({ ...withWeb, at: FieldValue.serverTimestamp() }).catch(() => undefined);
  return withWeb;
}

/** The answer of [sources] merged, kept under [cacheId] when none failed: a gap left by one that did is not kept for days. */
async function askCatalogues(input: SearchInput, sources: PictureSource[], cacheId: string): Promise<PicturesAnswer | null> {
  const answers = await Promise.all(sources.map((source) => askSource(source, input)));
  if (answers.every((answer) => answer === null)) return null;
  const hits = withoutTmdbTwins(answers.map((answer) => answer ?? { hits: [], hasMore: false }));
  const merged = { items: mergeHits(input.typed, hits), hasMore: answers.some((answer) => answer?.hasMore === true), notices: [] };
  if (answers.every((answer) => answer !== null)) {
    await getFirestore().collection(CACHE).doc(cacheId).set({ ...merged, at: FieldValue.serverTimestamp() }).catch(() => undefined);
  }
  return merged;
}

/** A film Wikidata knows by its TMDB id is TMDB's to show, with TMDB's poster. */
function withoutTmdbTwins(answers: SourceAnswer[]): PictureHit[][] {
  const tmdb = new Set(answers.flatMap((answer) => answer.hits).map(tmdbKeyOf).filter((key): key is string => key !== null));
  return answers.map((answer) => answer.hits.filter((hit) => !(answer.twins?.[hit.id] ?? []).some((id) => tmdb.has(id))));
}

interface SourceAnswer {
  hits: PictureHit[];
  hasMore: boolean;
  /** Wikidata's: the TMDB keys each hit is also known by. */
  twins?: Record<string, string[]>;
}

async function askSource(source: PictureSource, input: SearchInput): Promise<SourceAnswer | null> {
  try {
    switch (source) {
      case "tmdb":
        return await askTmdb(input);
      case "anilist":
        return await askAnilist(input);
      case "igdb":
        return await askIgdb(input);
      case "steam":
        return input.page > 1 ? { hits: [], hasMore: false } : await askSteam(input);
      case "inaturalist":
        return await askInaturalist(input);
      case "deezer":
        return await askDeezer(input);
      case "openlibrary":
        return await askOpenLibrary(input);
      case "wikidata":
        return input.page > 1 ? { hits: [], hasMore: false } : await askWikidata(input);
      case "web":
        return null;
    }
  } catch (error) {
    console.warn(`Picture source ${source} failed`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function getJson(url: string, init: RequestInit = {}, timeoutMs = SOURCE_TIMEOUT_MS): Promise<unknown> {
  const reply = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!reply.ok) throw new Error(`${new URL(url).host} answered ${reply.status}`);
  return reply.json();
}

async function askTmdb(input: SearchInput): Promise<SourceAnswer> {
  const path = input.scope === "people" ? "/3/search/person" : "/3/search/multi";
  const params = new URLSearchParams({ query: input.typed, language: input.language, page: String(input.page), include_adult: "false" });
  const body = (await getJson(`https://api.themoviedb.org${path}?${params}`, {
    headers: { Authorization: `Bearer ${pictureTmdbToken.value()}` },
  })) as { results?: unknown[]; total_pages?: number };
  // /search/person leaves out media_type: every row there is a person.
  const shaped = input.scope === "people" ? { results: (body.results ?? []).map((row) => ({ ...(row as object), media_type: "person" })) } : body;
  const hits = tmdbHits(shaped).filter((hit) => input.scope !== "film_tv" || hit.kind !== "person");
  return { hits, hasMore: (body.total_pages ?? 0) > input.page };
}

async function askAnilist(input: SearchInput): Promise<SourceAnswer> {
  const body = await getJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { q: input.typed, page: input.page } }),
  });
  const pages = (body as { data?: { media?: { pageInfo?: { hasNextPage?: boolean } } } }).data;
  const hits = anilistHits(body);
  return { hits, hasMore: pages?.media?.pageInfo?.hasNextPage === true || hits.length >= 20 };
}

const IGDB_PAGE = 15;
let igdbToken: { value: string; untilMs: number } | null = null;

/** Twitch's app token for IGDB, kept for the instance's life and asked again a day before it ends. */
async function igdbAccess(id: string, secret: string): Promise<string> {
  if (igdbToken && igdbToken.untilMs > Date.now()) return igdbToken.value;
  const params = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" });
  const body = (await getJson(`https://id.twitch.tv/oauth2/token?${params}`, { method: "POST" })) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("Twitch gave no IGDB token");
  igdbToken = { value: body.access_token, untilMs: Date.now() + Math.max(0, body.expires_in - 24 * 60 * 60) * 1000 };
  return igdbToken.value;
}

async function askIgdb(input: SearchInput): Promise<SourceAnswer> {
  const id = igdbClientId.value().trim();
  const secret = igdbClientSecret.value().trim();
  if (!id || !secret) return { hits: [], hasMore: false };
  const typed = input.typed.replace(/["\\]/g, " ").trim();
  const query = `search "${typed}"; fields ${IGDB_QUERY_FIELDS}; where cover != null & version_parent = null; limit ${IGDB_PAGE}; offset ${(input.page - 1) * IGDB_PAGE};`;
  const body = await getJson("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": id, Authorization: `Bearer ${await igdbAccess(id, secret)}`, "Content-Type": "text/plain" },
    body: query,
  });
  return { hits: igdbHits(body), hasMore: Array.isArray(body) && body.length >= IGDB_PAGE };
}

/** IGDB's games called exactly this, oldest first: the original, which its search can rank below the remakes. */
export async function igdbNamed(name: string): Promise<PictureHit[]> {
  if (isDemoEmulator()) return [];
  const id = igdbClientId.value().trim();
  const secret = igdbClientSecret.value().trim();
  if (!id || !secret) return [];
  const exact = name.replace(/["\\]/g, " ").trim();
  const body = await getJson("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": id, Authorization: `Bearer ${await igdbAccess(id, secret)}`, "Content-Type": "text/plain" },
    body: `fields ${IGDB_QUERY_FIELDS}; where name ~ "${exact}" & cover != null; sort first_release_date asc; limit ${IGDB_PAGE};`,
  });
  return igdbHits(body);
}

/** Autocomplete ranks the tiger above the tiger moths; it has one page, so the next one is empty. */
async function askInaturalist(input: SearchInput): Promise<SourceAnswer> {
  if (input.page > 1) return { hits: [], hasMore: false };
  // taxon_id 1 is Animalia: plants and fungi are not what this scope is for.
  const params = new URLSearchParams({ q: input.typed, taxon_id: "1", rank: "species,subspecies,genus", locale: input.language, per_page: "20" });
  const found = await getJson(`https://api.inaturalist.org/v1/taxa/autocomplete?${params}`);
  // Most default photos are licensed non-commercially or not at all: such a taxon's other photos are looked through.
  const without = inaturalistWithoutPhoto(found);
  // The cat, the brown bear, the bald eagle: the best-known animals often have no open photo among their own,
  // but thousands of openly licensed observations. Both are asked at once, the taxon's own photos coming first.
  const [others, observed] = await Promise.all([
    without.length === 0
      ? new Map<number, unknown[]>()
      : getJson(`https://api.inaturalist.org/v1/taxa/${without.join(",")}`).then(inaturalistPhotos, () => new Map<number, unknown[]>()),
    Promise.all(without.slice(0, INATURALIST_OBSERVED).map(async (id) => {
      const params = new URLSearchParams({ taxon_id: String(id), photo_license: "cc0,cc-by,cc-by-sa", quality_grade: "research", order_by: "votes", per_page: "10", photos: "true" });
      return [id, await getJson(`https://api.inaturalist.org/v1/observations?${params}`).then(inaturalistObservationPhotos, () => [])] as const;
    })),
  ]);
  for (const [id, photos] of observed) others.set(id, [...(others.get(id) ?? []), ...photos]);
  return { hits: inaturalistHits(found, others), hasMore: false };
}

async function askSteam(input: SearchInput): Promise<SourceAnswer> {
  const params = new URLSearchParams({ term: input.typed, l: "english", cc: "US" });
  const ids = steamAppIds(await getJson(`https://store.steampowered.com/api/storesearch/?${params}`));
  if (ids.length === 0) return { hits: [], hasMore: false };
  const request = {
    ids: ids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "US" },
    data_request: { include_assets: true },
  };
  const items = await getJson(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?${new URLSearchParams({ input_json: JSON.stringify(request) })}`);
  return { hits: steamHits(ids, items), hasMore: false };
}

async function askDeezer(input: SearchInput): Promise<SourceAnswer> {
  const params = new URLSearchParams({ q: input.typed, limit: "10", index: String((input.page - 1) * 10) });
  const [artists, albums] = await Promise.all([
    getJson(`https://api.deezer.com/search/artist?${params}`),
    getJson(`https://api.deezer.com/search/album?${params}`),
  ]);
  const hits = [...deezerArtistHits(artists), ...deezerAlbumHits(albums)];
  const more = [artists, albums].some((body) => typeof (body as { next?: unknown }).next === "string");
  return { hits, hasMore: more };
}

async function askOpenLibrary(input: SearchInput): Promise<SourceAnswer> {
  // Open Library refuses a query this short with 422.
  if (input.typed.trim().length < 3) return { hits: [], hasMore: false };
  const params = new URLSearchParams({
    q: input.typed,
    fields: "key,title,author_name,first_publish_year,cover_i",
    limit: "20",
    page: String(input.page),
  });
  const body = await getJson(`https://openlibrary.org/search.json?${params}`, {}, OPEN_LIBRARY_TIMEOUT_MS);
  const found = (body as { numFound?: number }).numFound ?? 0;
  return { hits: openLibraryHits(body), hasMore: found > input.page * 20 };
}

async function askWikidata(input: SearchInput): Promise<SourceAnswer> {
  const language = input.language.split("-")[0] ?? "en";
  const search = new URLSearchParams({
    action: "wbsearchentities",
    search: input.typed,
    language,
    uselang: language,
    type: "item",
    limit: "20",
    format: "json",
  });
  const found = (await getJson(`https://www.wikidata.org/w/api.php?${search}`)) as { search?: { id?: unknown }[] };
  const ids = (found.search ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (ids.length === 0) return { hits: [], hasMore: false };
  const details = new URLSearchParams({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|descriptions|claims",
    languages: [...new Set([input.language, language, "en"])].join("|"),
    format: "json",
  });
  const pictured = wikidataCandidates(ids, await getJson(`https://www.wikidata.org/w/api.php?${details}`), input.language);
  const candidates = pictured.length === 0 ? pictured : await fitting(pictured, wantsCovers(input.scope));
  return {
    hits: candidates.map(({ hit }) => hit),
    hasMore: false,
    twins: Object.fromEntries(candidates.map(({ hit, tmdbIds }) => [hit.id, tmdbIds])),
  };
}

/** Commons knows each file's size: too small a picture never shows, nor a wide one where covers are wanted. */
async function fitting(candidates: WikidataCandidate[], covers: boolean): Promise<WikidataCandidate[]> {
  const sizes = new URLSearchParams({
    action: "query",
    prop: "imageinfo",
    iiprop: "size",
    titles: candidates.map(({ file }) => `File:${file}`).join("|"),
    format: "json",
  });
  const good = commonsFitting(await getJson(`https://commons.wikimedia.org/w/api.php?${sizes}`), covers);
  return candidates.filter(({ file }) => good.has(commonsName(file)));
}

interface WebOutcome {
  hits?: PictureHit[];
  notice?: string;
}

/** The web key is bound to this function only once the owner has set it; until then the web is simply off. */
function webKey(): string | null {
  const key = process.env.SERPER_API_KEY;
  return key && key.length > 0 ? key : null;
}

async function maybeAskWeb(input: SearchInput, good: number): Promise<WebOutcome> {
  const db = getFirestore();
  const now = Date.now();
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const [switchDoc, mine, monthDoc] = await Promise.all([
    db.doc(WEB_SWITCH).get(),
    db.doc(`${WEB_USAGE}/${today}/users/${input.uid}`).get(),
    db.doc(`${WEB_USAGE}/${month}`).get(),
  ]);
  const decision = decideWeb({
    scope: input.scope,
    forced: input.forcedWeb,
    goodMatches: good,
    configured: webKey() !== null,
    offUntilMs: switchDoc.get("offUntil")?.toMillis?.() ?? 0,
    nowMs: now,
    usedToday: mine.get("count") ?? 0,
    usedThisMonth: monthDoc.get("count") ?? 0,
  });
  if (decision === "skip") return {};
  // Off because nobody set it up is nothing a person can do anything about, and nothing to tell them.
  if (decision === "off") return webKey() === null ? {} : { notice: "webOff" };
  if (decision === "dailyLimit") return { notice: "webDailyLimit" };

  let reply: globalThis.Response;
  try {
    reply = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": webKey() ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ q: input.typed, num: 20, hl: input.language.split("-")[0] }),
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch {
    return {};
  }
  if (reply.status === 400 || reply.status === 401 || reply.status === 402 || reply.status === 403 || reply.status === 429) {
    console.error("Web picture search refused", reply.status, (await reply.text()).slice(0, 200));
    await db.doc(WEB_SWITCH).set({ offUntil: new Date(now + WEB_REST_MS), lastStatus: reply.status }, { merge: true });
    return { notice: "webOff" };
  }
  if (!reply.ok) return {};
  await Promise.all([
    db.doc(`${WEB_USAGE}/${today}/users/${input.uid}`).set({ count: FieldValue.increment(1) }, { merge: true }),
    db.doc(`${WEB_USAGE}/${month}`).set({ count: FieldValue.increment(1) }, { merge: true }),
  ]);
  return { hits: webHits(await reply.json()) };
}

// Keeping a web picture.

const KEEP_MAX_BYTES = 4 * 1024 * 1024;
const KEEP_MAX_REDIRECTS = 3;
const KEEP_DAILY_PER_USER = 300;

type Kept = { pictureId: string } | { error: string };

/** Loopback, private, link-local and the like: an address the server must never be talked into fetching. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") ||
    lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff");
}

async function safeToFetch(url: URL): Promise<boolean> {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  if (isIP(url.hostname)) return !isPrivateAddress(url.hostname);
  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

async function keepPicture(raw: string, uid: string): Promise<Kept> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "BAD_URL" };
  }
  const db = getFirestore();
  const usage = db.doc(`${WEB_USAGE}/${dayKey(Date.now())}/keeps/${uid}`);
  if (((await usage.get()).get("count") ?? 0) >= KEEP_DAILY_PER_USER) return { error: "KEEP_LIMIT" };
  // Counted before the fetch: a refused address costs the server a fetch too.
  await usage.set({ count: FieldValue.increment(1) }, { merge: true });

  const fetched = isDemoEmulator() ? { bytes: STUB_PICTURE, type: "image/png" } : await downloadPicture(url);
  if ("error" in fetched) return fetched;
  const pictureId = randomUUID();
  await getStorage().bucket().file(`users/${uid}/pictures/${pictureId}`).save(fetched.bytes, { contentType: fetched.type, resumable: false });
  return { pictureId };
}

async function downloadPicture(start: URL): Promise<{ bytes: Buffer; type: string } | { error: string }> {
  let url = start;
  let reply: globalThis.Response | null = null;
  for (let hop = 0; hop <= KEEP_MAX_REDIRECTS; hop++) {
    if (!(await safeToFetch(url))) return { error: "NOT_ALLOWED" };
    try {
      reply = await fetch(url, { redirect: "manual", headers: { "User-Agent": USER_AGENT, Accept: "image/*" }, signal: AbortSignal.timeout(8_000) });
    } catch {
      return { error: "UNREACHABLE" };
    }
    const next = reply.status >= 300 && reply.status < 400 ? reply.headers.get("location") : null;
    if (!next) break;
    url = new URL(next, url);
    reply = null;
  }
  if (!reply || !reply.ok) return { error: "UNREACHABLE" };
  const type = (reply.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return { error: "NOT_A_PICTURE" };
  if (Number(reply.headers.get("content-length") ?? "0") > KEEP_MAX_BYTES) return { error: "TOO_BIG" };
  let bytes: Buffer | null;
  try {
    bytes = await readAtMost(reply, KEEP_MAX_BYTES);
  } catch {
    return { error: "UNREACHABLE" };
  }
  if (bytes === null || bytes.length === 0) return { error: "TOO_BIG" };
  return { bytes, type };
}

/** The body, or null as soon as it passes [max]: a missing or lying content-length must not decide the memory. */
export async function readAtMost(reply: globalThis.Response, max: number): Promise<Buffer | null> {
  if (!reply.body) return Buffer.alloc(0);
  const reader = reply.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
