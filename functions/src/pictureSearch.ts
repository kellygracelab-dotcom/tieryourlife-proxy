/**
 * GET /lists/pictures: the catalogues a scope names, asked together, each
 * on its own clock, so one that is slow or down only leaves its own gap.
 * With part=quick only the fast ones are asked and the web is not; `rest`
 * says whether the whole search would add anything, so a client shows the
 * quick answer at once and the whole one's new hits below it. The whole
 * search takes the quick one's answers as they are and asks only the rest.
 * A catalogue that refuses (429, 5xx) is left alone for a while, and each
 * person's searches that reach the catalogues are counted
 * (src/pictureSearchLimit.ts).
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
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Identity } from "./auth";
import { isDemoEmulator, STUB_PICTURE } from "./emulator";
import {
  ANILIST_QUERY,
  anilistHits,
  commonsPictures,
  commonsName,
  decideWeb,
  deezerAlbumHits,
  deezerArtistHits,
  goodMatches,
  hitScore,
  hasSlowSources,
  IGDB_QUERY_FIELDS,
  igdbHits,
  inaturalistHasOpenPhoto,
  inaturalistHits,
  inaturalistObservationPhotos,
  inaturalistPhotos,
  inaturalistWithoutPhoto,
  mergeHits,
  appendNew,
  WEB_WHEN_EMPTY,
  fittingPicture,
  searchLanguage,
  worthSearching,
  openLibraryHits,
  PictureHit,
  PictureScope,
  pictureScopeOf,
  PictureSource,
  quickSourcesFor,
  restUntil,
  retryAfterMs,
  sourcesFor,
  steamAppIds,
  steamHits,
  tmdbHits,
  tmdbKeyOf,
  USER_AGENT,
  webHits,
  WikidataCandidate,
  wantsCovers,
  wikidataCandidates,
} from "./pictureSources";
import { noteDenied } from "./pictureAlarms";
import { chargeSearch, retryAfterSeconds, type SearchCharge } from "./pictureSearchLimit";
import { dayKey } from "./quota";
import { fold } from "./search";
import {
  builtInWant,
  cleanId,
  judgeHits,
  otherLayout,
  trimmedTail,
  typeOfNames,
  wantKey,
  wantRank,
  wantScore,
  wikipediaOf,
  wikipediaSuggestion,
  type JudgedHit,
  type Retry,
  type Want,
} from "./pictureIntent";

export const pictureTmdbToken = defineSecret("TMDB_READ_ACCESS_TOKEN");
export const igdbClientId = defineSecret("IGDB_CLIENT_ID");
export const igdbClientSecret = defineSecret("IGDB_CLIENT_SECRET");

const SOURCE_TIMEOUT_MS = 5_000;
const CACHE = "pictureCache";
const CACHE_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Raised whenever an answer holds something different, so answers kept from before are not served.
 * Raising it also drops three days of answers at once and sends every search back to the catalogues.
 */
const CACHE_SHAPE = 17;
const WEB_USAGE = "pictureWeb";
const WEB_SWITCH = "config/pictureWeb";
/** Out of credits, or refused: the web is left alone this long before it is tried again. */
const WEB_REST_MS = 60 * 60 * 1000;
/** Until when each catalogue that refused is left alone, for every instance. */
const RESTS = "config/pictureSources";
/** How long an instance trusts what it last read of [RESTS]. */
const RESTS_READ_MS = 30_000;
const SEARCHES = "pictureSearches";
/** Open Library's search often takes six or seven seconds, and a books search has nothing else to wait for. */
const OPEN_LIBRARY_TIMEOUT_MS = 9_000;
/** Taxa whose open photo is looked for among their best-liked observations, one request each. */
const INATURALIST_OBSERVED = 6;
const MAX_QUERY = 100;
const MAX_PAGE = 20;

interface PicturesAnswer {
  items: JudgedHit[];
  hasMore: boolean;
  notices: string[];
  /** Quick answers only: whether the whole search can find more. */
  rest?: boolean;
  /** The catalogues of this search that are busy (refused, or resting after a refusal): a gap, not "nothing found". */
  busy?: PictureSource[];
  /** With [busy]: when they may be asked again, epoch milliseconds. */
  retryAt?: number;
  /** What was searched instead when the text as typed found nothing like it (since 18.11.2026). */
  searchedAs?: { text: string; how: Retry };
}

/**
 * The catalogues of [sources] that left a gap because they are busy: not in
 * [answered] and resting past [nowMs]. Empty fields when there are none.
 */
export function busyGap(
  sources: readonly PictureSource[],
  answered: ReadonlySet<PictureSource>,
  resting: ReadonlyMap<PictureSource, number>,
  nowMs: number,
): Pick<PicturesAnswer, "busy" | "retryAt"> {
  const busy = sources.filter((source) => !answered.has(source) && (resting.get(source) ?? 0) > nowMs);
  return busy.length === 0 ? {} : { busy, retryAt: Math.max(...busy.map((source) => resting.get(source)!)) };
}

/**
 * Whether an answer is `503 SOURCE_BUSY` rather than "nothing found": nothing
 * was found, a catalogue it needed is busy, and no later part of the search can
 * still find something.
 */
export function busyAnswer(answer: PicturesAnswer): answer is PicturesAnswer & Required<Pick<PicturesAnswer, "busy" | "retryAt">> {
  return answer.busy !== undefined && answer.retryAt !== undefined && answer.items.length === 0 && answer.rest !== true;
}

/** This person has searched the catalogues as much as an hour or a UTC day allows (src/pictureSearchLimit.ts). */
export interface SearchLimited {
  limited: true;
  retryAtMs: number;
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
    // "!!!???" or two emoji: no catalogue can mean anything by it, so none is asked and nothing is counted.
    if (!worthSearching(typed)) {
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ items: [], hasMore: false, notices: [], ...(query.part === "quick" ? { rest: false } : {}) });
      return;
    }
    const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1));
    const answer = await searchPicturesCounted({
      typed,
      scope: pictureScopeOf(query.scope),
      want: await wantOf(cleanId(query.section), cleanId(query.topic)),
      language: searchLanguage(query.lang),
      page,
      forcedWeb: query.web === "1" || query.web === "true",
      quick: query.part === "quick",
      uid: identity.uid,
    });
    if (answer === null) {
      response.status(502).json({ error: "No catalogue answered", code: "SOURCES_DOWN" });
      return;
    }
    if ("limited" in answer) {
      response.setHeader("Retry-After", String(retryAfterSeconds(answer.retryAtMs, Date.now())));
      response.setHeader("Cache-Control", "no-store");
      response.status(429).json({ error: "Too many picture searches", code: "SEARCH_LIMIT", retryAt: answer.retryAtMs });
      return;
    }
    if (busyAnswer(answer)) {
      response.setHeader("Retry-After", String(retryAfterSeconds(answer.retryAt, Date.now())));
      response.setHeader("Cache-Control", "no-store");
      response.status(503).json({ error: "A catalogue this search needs is busy", code: "SOURCE_BUSY", retryAt: answer.retryAt, busy: answer.busy });
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
  /** What the list wants, from its section and topic; absent or null: as before sections were sent. */
  want?: Want | null;
  language: string;
  page: number;
  forcedWeb: boolean;
  quick: boolean;
  uid: string;
  /** Never asks the web: the house fill takes only pictures it may copy, and a second attempt's searches are the first one's. */
  noWeb?: boolean;
}

/**
 * Null when every catalogue asked failed, or nothing was found while one it
 * needed is busy: an empty answer from catalogues that worked is still an
 * answer. Not counted: the house fill's.
 */
export async function searchPictures(input: SearchInput): Promise<PicturesAnswer | null> {
  const answer = await search(input, false);
  return answer === null || "limited" in answer || busyAnswer(answer) ? null : answer;
}

/** A person's search, counted against their hourly and daily searches. */
export function searchPicturesCounted(input: SearchInput): Promise<PicturesAnswer | SearchLimited | null> {
  return search(input, true);
}

/**
 * Cache keys of a search: its answer, with the web, the quick parts, the second attempt chosen for it, and
 * the web's pictures for a search that found nothing.
 */
function cacheKey(input: SearchInput, web: boolean, part: "" | "parts" | "retry" | "empty" = ""): string {
  return createHash("sha256")
    .update([CACHE_SHAPE, fold(input.typed), input.scope, input.language, input.page, web ? "web" : "", part, wantKey(input.want ?? null)].join("|"))
    .digest("hex");
}

/**
 * A search as it is answered: the catalogues asked as typed, and when that finds nothing like it on the
 * first page, a second attempt (a trailing "watch online" cut off, the other keyboard layout, Wikipedia's
 * spelling) whose answer is given instead, with `searchedAs`. The texts tried are kept with the search, so
 * a quick search and the whole one after it try the same. When that finds nothing either, the web's first
 * pictures come below (`webWhenEmpty`). Each hit is then judged.
 */
async function search(input: SearchInput, metered: boolean): Promise<PicturesAnswer | SearchLimited | null> {
  const first = await searchAsTyped(input, metered);
  if (first === null || "limited" in first) return first;
  let answer: PicturesAnswer = first;
  if (input.page === 1 && !busyAnswer(first) && goodMatches(input.typed, first.items) === 0 && !isDemoEmulator()) {
    const retried = await secondAttempt(input, first);
    answer = retried ?? (await webWhenEmpty(input, first));
  }
  const typed = answer.searchedAs?.text ?? input.typed;
  return { ...answer, items: judgeHits(answer.items, typed, input.scope, input.want ?? null, answer.searchedAs !== undefined, input.page === 1) };
}

/** The second attempt's answer for [input], or null when none is worth giving. */
async function secondAttempt(input: SearchInput, first: PicturesAnswer): Promise<PicturesAnswer | null> {
  const chosenRef = getFirestore().collection(CACHE).doc(cacheKey(input, false, "retry"));
  const chosen = await chosenRef.get().catch(() => null);
  const at = chosen?.get("at")?.toMillis?.() ?? 0;
  const known = chosen?.exists && Date.now() - at < CACHE_FRESH_MS ? (chosen.get("tries") as { text: string; how: Retry }[] | undefined) : undefined;
  const tries = known ?? (await retryTexts(input.typed, input.language, first.items.length === 0));
  if (!known) await chosenRef.set({ tries, at: Timestamp.now() }).catch(() => undefined);
  for (const attempt of tries.slice(0, 2)) {
    // The same search, so it is not counted again; the web, if any, was asked for the text as typed.
    const again = await searchAsTyped({ ...input, typed: attempt.text, noWeb: true }, false);
    if (again === null || "limited" in again || busyAnswer(again)) continue;
    if (goodMatches(attempt.text, again.items) === 0) continue;
    // What the text as typed found stays below.
    const rest = first.rest === undefined && again.rest === undefined ? {} : { rest: again.rest === true || first.rest === true };
    return { ...again, items: appendNew(again.items, first.items), searchedAs: attempt, ...rest };
  }
  return null;
}

/**
 * A search in a scope of its own that found nothing like the name, as typed or at the second attempt: the
 * web's first pictures below what it did find. "all" and a search for the web everywhere asked the web
 * already. Kept with the search, so asked again it costs nothing more; a quick search only says that the
 * whole one may bring them. Without a web key, the answer as it is.
 */
async function webWhenEmpty(input: SearchInput, answer: PicturesAnswer): Promise<PicturesAnswer> {
  if (input.scope === "all" || input.forcedWeb || input.noWeb === true || webKey() === null) return answer;
  if (input.quick) return { ...answer, rest: true };
  const keptRef = getFirestore().collection(CACHE).doc(cacheKey(input, true, "empty"));
  const kept = await keptRef.get().catch(() => null);
  const at = kept?.get("at")?.toMillis?.() ?? 0;
  let hits = kept?.exists && Date.now() - at < CACHE_FRESH_MS ? (kept.get("items") as PictureHit[] | undefined) : undefined;
  if (!hits) {
    const web = await maybeAskWeb(input, 0, true);
    if (web.notice) return { ...answer, notices: [...answer.notices, web.notice] };
    if (!web.hits) return answer;
    hits = web.hits.slice(0, WEB_WHEN_EMPTY);
    // Through JSON: Firestore refuses a field left undefined.
    await keptRef.set({ items: JSON.parse(JSON.stringify(hits)), at: Timestamp.now() }).catch(() => undefined);
  }
  return { ...answer, items: appendNew(answer.items, hits) };
}

/**
 * The texts a second attempt tries, best first: the title without its tail, the other layout, Wikipedia's
 * spelling. The other layout only when nothing at all was found: "Крёстный отец" is no Latin typed wrong.
 */
async function retryTexts(typed: string, language: string, nothing: boolean): Promise<{ text: string; how: Retry }[]> {
  const tries: { text: string; how: Retry }[] = [];
  const trimmed = trimmedTail(typed);
  if (trimmed) tries.push({ text: trimmed, how: "trimmed" });
  const layout = nothing ? otherLayout(trimmed ?? typed, language) : null;
  if (layout) tries.push({ text: layout, how: "layout" });
  if (tries.length < 2) {
    const spelled = await spelling(trimmed ?? typed, language);
    if (spelled) tries.push({ text: spelled, how: "spelling" });
  }
  return tries;
}

/** Wikipedia's "did you mean" in the search's language, then in English; null when neither suggests anything. */
async function spelling(typed: string, language: string): Promise<string | null> {
  for (const wiki of [...new Set([wikipediaOf(language), "en"])]) {
    const params = new URLSearchParams({ action: "query", list: "search", srsearch: typed, srinfo: "suggestion", srprop: "", srlimit: "1", format: "json" });
    const body = await getJson(`https://${wiki}.wikipedia.org/w/api.php?${params}`).catch(() => null);
    const suggestion = wikipediaSuggestion(body, typed);
    if (suggestion) return suggestion;
  }
  return null;
}

/** What one section or topic is called, read at most every ten minutes per instance. */
const NAMES_FRESH_MS = 10 * 60 * 1000;
const namesRead = new Map<string, { atMs: number; names: string[] }>();

async function namesOf(collection: "sections" | "topics", id: string): Promise<string[]> {
  const key = `${collection}/${id}`;
  const kept = namesRead.get(key);
  if (kept && Date.now() - kept.atMs < NAMES_FRESH_MS) return kept.names;
  const doc = await getFirestore().collection(collection).doc(id).get().catch(() => null);
  const data = (doc?.exists ? doc.data() : null) ?? {};
  const names = [data.name, ...Object.values((data.names ?? {}) as Record<string, unknown>)].filter((name): name is string => typeof name === "string").slice(0, 20);
  if (namesRead.size > 500) namesRead.clear();
  namesRead.set(key, { atMs: Date.now(), names });
  return names;
}

/**
 * What a list with [section] and [topic] wants. A built-in section says it; a section of somebody's own,
 * by its names; where that says nothing more than "anything", the topic's names may.
 */
export async function wantOf(section: string | null, topic: string | null): Promise<Want | null> {
  if (section === null && topic === null) return null;
  let want = builtInWant(section ?? "other");
  if (want === undefined) {
    const type = typeOfNames(await namesOf("sections", section!));
    want = type ? { kind: "type", type } : { kind: "general" };
  }
  if (want?.kind === "general" && topic !== null) {
    const type = typeOfNames(await namesOf("topics", topic));
    if (type) want = { kind: "type", type };
  }
  return want;
}

async function searchAsTyped(input: SearchInput, metered: boolean): Promise<PicturesAnswer | SearchLimited | null> {
  if (isDemoEmulator()) return { items: [], hasMore: false, notices: [], ...(input.quick ? { rest: false } : {}) };
  const db = getFirestore();
  // "parts": each catalogue's answer to a quick search. The merged quick answers once kept under "quick" are read no more.
  const key = (web: boolean, part: "" | "parts" = "") => cacheKey(input, web, part);
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
  const quickParts = key(false, "parts");
  const known = await knownParts(quickParts);
  if (input.quick) {
    const quick = await askCatalogues(input, quickSourcesFor(input.scope), known, metered, { parts: quickParts });
    if (quick && "limited" in quick) return quick;
    const rest = hasSlowSources(input.scope) || webLater;
    return quick ? { ...quick, rest } : rest ? { items: [], hasMore: false, notices: [], rest } : null;
  }

  if (!catalogues) {
    const asked = await askCatalogues(input, sourcesFor(input.scope), known, metered, { answer: key(false) });
    if (asked && "limited" in asked) return asked;
    catalogues = asked;
  }
  if (!catalogues) return null;
  if (input.page > 1) return catalogues;
  const web = await maybeAskWeb(input, goodMatches(input.typed, catalogues.items));
  if (web.notice) return { ...catalogues, notices: [web.notice] };
  if (!web.hits) return catalogues;
  // Below the catalogues, as a person first sees them after the quick answer: asked again, the same order.
  const items = appendNew(catalogues.items, mergeHits(input.typed, [web.hits], input.scope, rankFor(input), scoreFor(input)));
  const withWeb = { items, hasMore: catalogues.hasMore, notices: [] };
  // An answer with a busy catalogue's gap is not kept: asked again, it may be whole.
  // Through JSON: Firestore refuses a field left undefined, such as a web picture's missing subtitle.
  if (catalogues.busy === undefined) await db.collection(CACHE).doc(key(true)).set({ ...JSON.parse(JSON.stringify(withWeb)), at: Timestamp.now() }).catch(() => undefined);
  return catalogues.busy === undefined ? withWeb : { ...withWeb, busy: catalogues.busy, retryAt: catalogues.retryAt };
}

/** A catalogue's answer as kept among a quick search's parts, with when it was heard. */
interface KnownAnswer extends SourceAnswer {
  atMs: number;
}

/**
 * The answer of [sources] merged. What [known] holds is not asked again, nor
 * is a catalogue that is resting. Each answer is kept under `parts`, with the
 * moment it was heard, so an old one is not kept fresh by being saved again;
 * the merged one under `answer` only when none failed: a gap left by one
 * that did is not kept for days.
 *
 * A search is counted when it asks a catalogue and builds on nothing heard
 * before: the whole search after a quick one is the same search.
 */
async function askCatalogues(
  input: SearchInput,
  sources: PictureSource[],
  known: Map<PictureSource, KnownAnswer>,
  metered: boolean,
  keep: { parts?: string; answer?: string },
): Promise<PicturesAnswer | SearchLimited | null> {
  const resting = await restingUntil();
  const now = Date.now();
  const asking = sources.filter((source) => !known.has(source) && (resting.get(source) ?? 0) <= now);
  if (metered && asking.length > 0 && known.size === 0) {
    const charge = await chargeFor(input.uid);
    if (!charge.allowed) return { limited: true, retryAtMs: charge.retryAtMs };
  }
  const answers = new Map<PictureSource, KnownAnswer>(known);
  const asked = await Promise.all(asking.map(async (source) => [source, await askSource(source, input)] as const));
  for (const [source, answer] of asked) if (answer) answers.set(source, { ...answer, atMs: Date.now() });
  const found = sources.map((source) => answers.get(source) ?? null);
  // A catalogue that refused now, or rests after an earlier refusal, is busy: its gap is said, not hidden.
  const gap = busyGap(sources, new Set(answers.keys()), await restingUntil(), Date.now());
  if (found.every((answer) => answer === null)) return gap.busy ? { items: [], hasMore: false, notices: [], ...gap } : null;
  const hits = withoutTmdbTwins(found.map((answer) => answer ?? { hits: [], hasMore: false }));
  // The whole answer keeps the quick one's order at its head, the slow catalogues' new hits below: what a
  // person saw first is what they see when the same search comes from the cache (18.11.2026).
  const quick = new Set(quickSourcesFor(input.scope));
  const fast = hits.filter((_, at) => quick.has(sources[at]!));
  const all = mergeHits(input.typed, hits, input.scope, rankFor(input), scoreFor(input));
  const items = fast.length < hits.length ? appendNew(mergeHits(input.typed, fast, input.scope, rankFor(input), scoreFor(input)), all) : all;
  const merged: PicturesAnswer = { items, hasMore: found.some((answer) => answer?.hasMore === true), notices: [], ...gap };
  const cache = getFirestore().collection(CACHE);
  if (keep.parts && asked.some(([, answer]) => answer !== null)) {
    const parts = sources.flatMap((source) => {
      const answer = answers.get(source);
      return answer ? [{ source, ...answer }] : [];
    });
    await cache.doc(keep.parts).set({ parts, at: Timestamp.now() }).catch(() => undefined);
  }
  if (keep.answer && found.every((answer) => answer !== null)) {
    await cache.doc(keep.answer).set({ ...merged, at: Timestamp.now() }).catch(() => undefined);
  }
  return merged;
}

/** How a search ranks hits for what its list wants (src/pictureIntent.ts). */
function rankFor(input: SearchInput): (hit: PictureHit) => number {
  const want = input.want ?? null;
  return (hit) => wantRank(hit, input.scope, want);
}

function scoreFor(input: SearchInput): (hit: PictureHit) => number {
  const want = input.want ?? null;
  return (hit) => wantScore(hit, want, hitScore(hit, input.typed));
}

/** What a quick search already heard from each catalogue, each while it is fresh. */
async function knownParts(id: string): Promise<Map<PictureSource, KnownAnswer>> {
  const doc = await getFirestore().collection(CACHE).doc(id).get().catch(() => null);
  const parts: unknown = doc?.exists ? doc.get("parts") : null;
  const known = new Map<PictureSource, KnownAnswer>();
  const now = Date.now();
  for (const part of Array.isArray(parts) ? parts : []) {
    const { source, hits, hasMore, twins, atMs } = (part ?? {}) as { source?: unknown; hits?: unknown; hasMore?: unknown; twins?: Record<string, string[]>; atMs?: unknown };
    if (typeof source !== "string" || !Array.isArray(hits) || typeof atMs !== "number" || now - atMs >= CACHE_FRESH_MS) continue;
    known.set(source as PictureSource, { hits: hits as PictureHit[], hasMore: hasMore === true, atMs, ...(twins ? { twins } : {}) });
  }
  return known;
}

/** One more search for this person, if it fits; a counter that cannot be reached lets the search through. */
async function chargeFor(uid: string): Promise<SearchCharge> {
  const db = getFirestore();
  const ref = db.doc(`${SEARCHES}/${dayKey(Date.now())}/users/${uid}`);
  try {
    return await db.runTransaction(async (transaction) => {
      const charge = chargeSearch((await transaction.get(ref)).data(), Date.now());
      if (charge.allowed) transaction.set(ref, charge.next);
      return charge;
    });
  } catch (error) {
    console.warn("Picture search count failed", error instanceof Error ? error.message : error);
    return { allowed: true, next: { count: 0, hour: 0, hourCount: 0 } };
  }
}

/** A catalogue's answer that says to stop for a while: too many requests, or trouble on its side. */
export class CatalogueRefusal extends Error {
  constructor(host: string, readonly status: number, readonly retryAfter: string | null) {
    super(`${host} answered ${status}`);
  }
}

let rests: { readAtMs: number; until: Map<PictureSource, number> } | null = null;

/** Forgets what this instance remembers of resting catalogues; for tests. */
export function forgetCatalogueRests(): void {
  rests = null;
}

export async function restingUntil(): Promise<Map<PictureSource, number>> {
  const now = Date.now();
  if (rests && now - rests.readAtMs < RESTS_READ_MS) return rests.until;
  const doc = await getFirestore().doc(RESTS).get().catch(() => null);
  const until = new Map(rests?.until ?? []);
  for (const [source, value] of Object.entries(doc?.data() ?? {})) {
    const ms = (value as { offUntil?: { toMillis?: () => number } } | null)?.offUntil?.toMillis?.();
    if (typeof ms === "number") until.set(source as PictureSource, Math.max(until.get(source as PictureSource) ?? 0, ms));
  }
  rests = { readAtMs: now, until };
  return until;
}

export async function rest(source: PictureSource, refusal: CatalogueRefusal): Promise<void> {
  const until = restUntil(refusal.status, refusal.retryAfter, Date.now());
  if (until === null) return;
  (rests ??= { readAtMs: 0, until: new Map() }).until.set(source, until);
  await getFirestore().doc(RESTS).set({ [source]: { offUntil: Timestamp.fromMillis(until), lastStatus: refusal.status } }, { merge: true }).catch(() => undefined);
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
    if (error instanceof CatalogueRefusal) await rest(source, error);
    return null;
  }
}

/** A side request's failure leaves its part out, unless the catalogue refused: then the whole answer is a gap. */
function unlessRefused<T>(fallback: () => T): (error: unknown) => T {
  return (error) => {
    if (error instanceof CatalogueRefusal) throw error;
    return fallback();
  };
}

export async function getJson(url: string, init: RequestInit = {}, timeoutMs = SOURCE_TIMEOUT_MS): Promise<unknown> {
  const reply = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!reply.ok) {
    const host = new URL(url).host;
    // A 401 or 403 is a key switched off or access closed: an alarm, not a quiet gap (`pictureAlarms.ts`).
    noteDenied(url, reply.status);
    if (reply.status === 429 || reply.status >= 500) throw new CatalogueRefusal(host, reply.status, reply.headers.get("retry-after"));
    throw new Error(`${host} answered ${reply.status}`);
  }
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
export async function igdbAccess(id: string, secret: string): Promise<string> {
  if (igdbToken && igdbToken.untilMs > Date.now()) return igdbToken.value;
  const params = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" });
  const body = (await getJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("Twitch gave no IGDB token");
  igdbToken = { value: body.access_token, untilMs: Date.now() + Math.max(0, body.expires_in - 24 * 60 * 60) * 1000 };
  return igdbToken.value;
}

export async function askIgdb(input: SearchInput): Promise<SourceAnswer> {
  const id = igdbClientId.value().trim();
  const secret = igdbClientSecret.value().trim();
  if (!id || !secret) return { hits: [], hasMore: false };
  const typed = input.typed.replace(/["\\]/g, " ").trim();
  const headers = { "Client-ID": id, Authorization: `Bearer ${await igdbAccess(id, secret)}`, "Content-Type": "text/plain" };
  const ask = (query: string) => getJson("https://api.igdb.com/v4/games", { method: "POST", headers, body: query });
  const [body, rated] = await Promise.all([
    ask(`search "${typed}"; fields ${IGDB_QUERY_FIELDS}; where cover != null & version_parent = null; limit ${IGDB_PAGE}; offset ${(input.page - 1) * IGDB_PAGE};`),
    // IGDB's search ranks by text alone: "Mario" finds Mario & Luigi, not Super Mario Bros. The most rated games
    // with the name in theirs come along on the first page (Web's request of 15.11.2026).
    input.page === 1
      ? ask(`fields ${IGDB_QUERY_FIELDS}; where name ~ *"${typed}"* & cover != null & version_parent = null & total_rating_count > 0; sort total_rating_count desc; limit ${IGDB_MOST_RATED};`)
        .then(igdbHits, unlessRefused((): PictureHit[] => []))
      : Promise.resolve([]),
  ]);
  return { hits: withMostRated(igdbHits(body), rated), hasMore: Array.isArray(body) && body.length >= IGDB_PAGE };
}

/** The most rated games added to a search's first page. */
const IGDB_MOST_RATED = 10;

/** [searched] in IGDB's order, then those of [rated] it lacks, most rated first. */
export function withMostRated(searched: readonly PictureHit[], rated: readonly PictureHit[]): PictureHit[] {
  const ids = new Set(searched.map((hit) => hit.id));
  return [...searched, ...rated.filter((hit) => !ids.has(hit.id))];
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
  // taxon_id 1 is Animalia, 47126 Plantae: the animals scope is for animals, "all" takes plants too (18.11.2026).
  const params = new URLSearchParams({ q: input.typed, taxon_id: input.scope === "animals" ? "1" : "1,47126", rank: "species,subspecies,genus", locale: input.language, per_page: "20" });
  const found = await getJson(`https://api.inaturalist.org/v1/taxa/autocomplete?${params}`);
  // Most default photos are licensed non-commercially or not at all: such a taxon's other photos are looked through.
  const without = inaturalistWithoutPhoto(found);
  const others = without.length === 0
    ? new Map<number, unknown[]>()
    : await getJson(`https://api.inaturalist.org/v1/taxa/${without.join(",")}`).then(inaturalistPhotos, unlessRefused(() => new Map<number, unknown[]>()));
  // The cat, the brown bear, the bald eagle: the best-known animals often have no open photo among their own,
  // but thousands of openly licensed observations. Only a taxon still without one is asked for those.
  const still = without.filter((id) => !inaturalistHasOpenPhoto(others.get(id) ?? []));
  const observed = await Promise.all(still.slice(0, INATURALIST_OBSERVED).map(async (id) => {
    const params = new URLSearchParams({ taxon_id: String(id), photo_license: "cc0,cc-by,cc-by-sa", quality_grade: "research", order_by: "votes", per_page: "10", photos: "true" });
    return [id, await getJson(`https://api.inaturalist.org/v1/observations?${params}`).then(inaturalistObservationPhotos, unlessRefused(() => []))] as const;
  }));
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
  const found = (await getJson(`https://www.wikidata.org/w/api.php?${search}`)) as { search?: { id?: unknown; match?: { text?: unknown } }[] };
  // The name each item was found by: a label in another language or an alias.
  const matched = new Map((found.search ?? []).flatMap((row) => (typeof row.id === "string" && typeof row.match?.text === "string" ? [[row.id, row.match.text] as const] : [])));
  const ids = (found.search ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (ids.length === 0) return { hits: [], hasMore: false };
  const details = new URLSearchParams({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|descriptions|claims",
    // `mul`: Wikidata keeps a name that is the same in every language (Michael Jordan, PlayStation 5) there, and nowhere else.
    languages: [...new Set([input.language, language, "en", "mul"])].join("|"),
    format: "json",
  });
  const pictured = wikidataCandidates(ids, await getJson(`https://www.wikidata.org/w/api.php?${details}`), input.language, input.scope === "music", matched);
  const candidates = pictured.length === 0 ? pictured : await fitting(pictured, wantsCovers(input.scope));
  return {
    hits: candidates.map(({ hit }) => hit),
    hasMore: false,
    twins: Object.fromEntries(candidates.map(({ hit, tmdbIds }) => [hit.id, tmdbIds])),
  };
}

/** Files Commons describes in one request. */
const COMMONS_TITLES = 50;

/**
 * Commons knows each file's size: too small a picture never shows, nor a wide one where covers are wanted.
 * An item whose first picture will not do shows its next one (`fittingPicture`).
 */
async function fitting(candidates: WikidataCandidate[], covers: boolean): Promise<WikidataCandidate[]> {
  const titles = [...new Set(candidates.flatMap(({ files }) => files.map((file) => `File:${commonsName(file)}`)))];
  const chunks = Array.from({ length: Math.ceil(titles.length / COMMONS_TITLES) }, (_, at) => titles.slice(at * COMMONS_TITLES, (at + 1) * COMMONS_TITLES));
  const answers = await Promise.all(chunks.map((chunk) => getJson(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: "query",
    prop: "imageinfo",
    iiprop: "size|extmetadata",
    iiextmetadatafilter: "Artist|Credit|Attribution|LicenseShortName|LicenseUrl|UsageTerms",
    iiextmetadatalanguage: "en",
    titles: chunk.join("|"),
    format: "json",
  })}`)));
  const good = new Map(answers.flatMap((body) => [...commonsPictures(body, covers)]));
  return candidates.flatMap((candidate) => {
    const chosen = fittingPicture(candidate, good);
    return chosen ? [chosen] : [];
  });
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

/** The web's pictures for [input] when `decideWeb` says so; [empty]: the search found nothing like the name. */
async function maybeAskWeb(input: SearchInput, good: number, empty = false): Promise<WebOutcome> {
  if (input.noWeb === true) return {};
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
    empty,
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
type Downloaded = { bytes: Buffer; type: string } | { error: string; retryAtMs?: number };

/** The longest a download waits in place for a busy source before it tries once more. */
export const BUSY_WAIT_MS = 3_000;
/** A busy source that says nothing of when is tried again after this long, once. */
const BUSY_PAUSE_MS = 1_000;

/**
 * What a download does about a source's answer [status]: nothing (null), wait
 * [waitMs] and try once more, or give up until [retryAtMs]. Only 429 and 5xx
 * are a source being busy; [restHost] when it asked us to slow down (429, 503).
 */
export function sourceBusy(
  status: number,
  retryAfter: string | null,
  nowMs: number,
  triedAgain: boolean,
): null | { waitMs: number } | { retryAtMs: number; restHost: boolean } {
  if (status !== 429 && status < 500) return null;
  const said = retryAfterMs(retryAfter, nowMs);
  if (!triedAgain && (said ?? BUSY_PAUSE_MS) <= BUSY_WAIT_MS) return { waitMs: Math.max(BUSY_PAUSE_MS, said ?? 0) };
  return { retryAtMs: restUntil(status, retryAfter, nowMs) ?? nowMs + BUSY_PAUSE_MS, restHost: status === 429 || status === 503 };
}

/** Hosts that told this instance to slow down, until when: nothing is fetched from them before. */
const busyHosts = new Map<string, number>();

/** Forgets the hosts this instance leaves alone; for tests. */
export function forgetBusyHosts(): void {
  busyHosts.clear();
}

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
  // This route's answers stay as they were: a busy source is UNREACHABLE here.
  if ("error" in fetched) return { error: fetched.error === "SOURCE_BUSY" ? "UNREACHABLE" : fetched.error };
  const pictureId = randomUUID();
  await getStorage().bucket().file(`users/${uid}/pictures/${pictureId}`).save(fetched.bytes, { contentType: fetched.type, resumable: false });
  return { pictureId };
}

/**
 * Also how publishing fetches a picture from another site: the same rules, and
 * [stop] to give up sooner. A source that is busy (429, 5xx) is waited for once
 * when it asks for no more than [BUSY_WAIT_MS]; otherwise the answer is
 * `SOURCE_BUSY` with when to try again, and a host that asked us to slow down
 * is left alone by this instance until then.
 */
export async function downloadPicture(start: URL, stop?: AbortSignal): Promise<Downloaded> {
  let url = start;
  let reply: globalThis.Response;
  let hops = 0;
  let waited = false;
  const timeout = () => AbortSignal.timeout(8_000);
  for (;;) {
    if (!(await safeToFetch(url))) return { error: "NOT_ALLOWED" };
    const resting = busyHosts.get(url.hostname) ?? 0;
    if (resting > Date.now()) return { error: "SOURCE_BUSY", retryAtMs: resting };
    try {
      reply = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
        signal: stop ? AbortSignal.any([timeout(), stop]) : timeout(),
      });
    } catch {
      return { error: "UNREACHABLE" };
    }
    const busy = sourceBusy(reply.status, reply.headers.get("retry-after"), Date.now(), waited);
    if (busy !== null) {
      await reply.body?.cancel().catch(() => undefined);
      if ("retryAtMs" in busy) {
        if (busy.restHost) busyHosts.set(url.hostname, busy.retryAtMs);
        return { error: "SOURCE_BUSY", retryAtMs: busy.retryAtMs };
      }
      if (stop?.aborted) return { error: "SOURCE_BUSY", retryAtMs: Date.now() + busy.waitMs };
      waited = true;
      await new Promise((resolve) => setTimeout(resolve, busy.waitMs));
      continue;
    }
    const next = reply.status >= 300 && reply.status < 400 ? reply.headers.get("location") : null;
    if (!next) break;
    if (hops++ >= KEEP_MAX_REDIRECTS) return { error: "UNREACHABLE" };
    url = new URL(next, url);
  }
  if (!reply.ok) {
    noteDenied(url, reply.status);
    return { error: "UNREACHABLE" };
  }
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
