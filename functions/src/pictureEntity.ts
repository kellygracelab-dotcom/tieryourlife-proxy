/**
 * Picture search, stage 2 (QA's IDEAL-SEARCH.md, "Сопоставление с сущностью"): before ranking pictures,
 * decide which Wikidata item the typed name means in this list, then show that item's own pictures
 * first, its catalogue's by id where it has one. Pure: the requests are in src/pictureSearch.ts.
 *
 * An item is chosen by four things, as QA's prototype measured on its 281 names (271 right):
 * - its kind fits the list (Wikidata's own classes, `pictureClassTable.ts`): the strongest;
 * - one of its names is the typed one;
 * - how well known it is: in how many Wikipedias it has an article;
 * - its place in Wikidata's and Wikipedia's searches.
 * Pages about a name, and items of no class, count against it. The lead over the next item is how sure.
 */
import { CLASS_TABLE } from "./pictureClassTable";
import { sameName, type Confidence, type Doubt, type Want } from "./pictureIntent";
import type { PictureHit, PictureKind, PictureScope } from "./pictureSources";

type TableKind =
  | "film" | "tv" | "anime" | "manga" | "games" | "books" | "musicGroup" | "musicWork" | "animals"
  | "food" | "sport" | "cars" | "brands" | "musicianJob" | "athleteJob" | "notAThing";

let parsed: Map<string, Set<number>> | null = null;

/** The classes of [kind], read from the table once per instance. */
function classes(kind: TableKind): Set<number> {
  parsed ??= new Map();
  let set = parsed.get(kind);
  if (!set) {
    set = new Set((CLASS_TABLE[kind] ?? "").split(",").filter((one) => one.length > 0).map((one) => Number.parseInt(one, 36)));
    parsed.set(kind, set);
  }
  return set;
}

function anyIn(kind: TableKind, ids: readonly number[]): boolean {
  const set = classes(kind);
  return ids.some((id) => set.has(id));
}

const HUMAN = 5;

/** The catalogues an item can name its page in, by Wikidata property. */
export const CATALOGUE_PROPERTIES = {
  P4947: "tmdbMovie",
  P4983: "tmdbTv",
  P4985: "tmdbPerson",
  P5794: "igdb",
  P1733: "steam",
  P8729: "anilist",
  P648: "openLibrary",
  P3151: "inaturalist",
} as const;
export type CatalogueField = (typeof CATALOGUE_PROPERTIES)[keyof typeof CATALOGUE_PROPERTIES];

/** What the search reads of one Wikidata item. */
export interface EntityFacts {
  id: string;
  /** What it is an instance of (P31), as numbers of Q-ids. */
  classes: number[];
  /** What it is a subclass of (P279): a dish or a car model is a class itself. */
  supers: number[];
  /** Occupations (P106). */
  jobs: number[];
  /** In how many Wikipedias and sister sites it has a page: how well known it is. */
  sitelinks: number;
  /** Its labels and aliases in the search's languages and `mul`. */
  names: string[];
  /** Its English description. */
  about: string | null;
  pictured: boolean;
  ids: Partial<Record<CatalogueField, string>>;
}

type Json = Record<string, unknown>;

function claimValues(claims: Json, property: string): unknown[] {
  const all = Array.isArray(claims[property]) ? (claims[property] as Json[]) : [];
  return all
    .filter((claim) => claim?.rank !== "deprecated" && (claim.mainsnak as Json | undefined)?.snaktype === "value")
    .map((claim) => ((claim.mainsnak as Json).datavalue as Json | undefined)?.value);
}

function itemNumbers(claims: Json, property: string): number[] {
  return claimValues(claims, property).flatMap((value) => {
    const id = (value as Json | null)?.id;
    const match = typeof id === "string" ? /^Q(\d+)$/.exec(id) : null;
    return match ? [Number(match[1])] : [];
  }).slice(0, 20);
}

/** Pictures an item names: photo, logo, poster, flag, coat of arms, and the like. */
const PICTURE_PROPERTIES = ["P18", "P154", "P3383", "P41", "P94", "P2716"];

/** The facts of each item of a `wbgetentities` answer, in [ids]' order; an item it lacks is left out. */
export function entityFacts(ids: readonly string[], body: unknown, languages: readonly string[]): EntityFacts[] {
  const entities = ((body as Json | null)?.entities ?? {}) as Record<string, Json>;
  const wanted = [...new Set([...languages, "en", "mul"])];
  return ids.flatMap((id): EntityFacts[] => {
    const entity = entities[id];
    if (!entity || typeof entity !== "object" || "missing" in entity) return [];
    const claims = (entity.claims ?? {}) as Json;
    const labels = (entity.labels ?? {}) as Record<string, Json>;
    const aliases = (entity.aliases ?? {}) as Record<string, Json[]>;
    const names = [
      ...wanted.map((code) => labels[code]?.value),
      ...wanted.flatMap((code) => (Array.isArray(aliases[code]) ? aliases[code]! : []).map((one) => one?.value)),
    ].filter((name): name is string => typeof name === "string" && name.length > 0);
    const descriptions = (entity.descriptions ?? {}) as Record<string, Json>;
    const catalogueIds: Partial<Record<CatalogueField, string>> = {};
    for (const [property, field] of Object.entries(CATALOGUE_PROPERTIES)) {
      const value = claimValues(claims, property)[0];
      if (typeof value === "string" && value.length > 0 && value.length <= 120) catalogueIds[field] = value;
    }
    return [{
      id,
      classes: itemNumbers(claims, "P31"),
      supers: itemNumbers(claims, "P279"),
      jobs: itemNumbers(claims, "P106"),
      sitelinks: entity.sitelinks && typeof entity.sitelinks === "object" ? Object.keys(entity.sitelinks).length : 0,
      names: [...new Set(names)],
      about: typeof descriptions.en?.value === "string" ? descriptions.en.value : null,
      pictured: PICTURE_PROPERTIES.some((property) => claimValues(claims, property).some((value) => typeof value === "string")),
      ids: catalogueIds,
    }];
  });
}

/**
 * The kind of picture an item is, by its classes: what a catalogue would call it. Anime and manga before
 * film and books, as they are those too, except in a list of films and series, where an anime film is a
 * film. Null: a thing ("thing" in the answer).
 */
export function kindOfFacts(facts: EntityFacts, want: Want | null = null, scope: PictureScope = "all"): PictureKind | null {
  const own = facts.classes;
  if (own.includes(HUMAN)) return "person";
  if (wantedKinds(want, scope)?.kinds.includes("film")) {
    if (anyIn("film", own)) return "movie";
    if (anyIn("tv", own)) return "tv";
  }
  if (anyIn("anime", own)) return "anime";
  if (anyIn("manga", own)) return "manga";
  if (anyIn("games", own)) return "game";
  if (anyIn("film", own)) return "movie";
  if (anyIn("tv", own)) return "tv";
  if (anyIn("musicGroup", own)) return "artist";
  if (anyIn("musicWork", own)) return "album";
  if (anyIn("books", own)) return "book";
  return null;
}

/** The kinds of the table a list wants, and whether a person of an occupation fits it. */
function wantedKinds(want: Want | null, scope: PictureScope): { kinds: TableKind[]; people?: TableKind | "any"; first?: TableKind } | null {
  const wanted = want ?? (scope === "all" ? null : { kind: "scope" as const, scope });
  if (wanted === null || wanted.kind === "general") return null;
  if (wanted.kind === "scope") {
    switch (wanted.scope) {
      case "film_tv": return { kinds: ["film", "tv"] };
      // The series before its manga, which usually has pages in more Wikipedias.
      case "anime": return { kinds: ["anime", "manga"], first: "anime" };
      case "games": return { kinds: ["games"] };
      case "books": return { kinds: ["books"] };
      case "music": return { kinds: ["musicGroup", "musicWork"], people: "musicianJob" };
      case "people": return { kinds: [], people: "any" };
      case "animals": return { kinds: ["animals"] };
      default: return null;
    }
  }
  switch (wanted.type) {
    case "food": return { kinds: ["food"] };
    case "sport": return { kinds: ["sport"], people: "athleteJob" };
    case "cars": return { kinds: ["cars"] };
    case "brands": return { kinds: ["brands", "cars"] };
    case "plants": return { kinds: ["animals"] };
    // Places have no table: Wikidata's places are too many classes. Their description says it (stage 1).
    case "places": return null;
  }
}

/** Whether an item is what the list wants: undefined where the list says nothing this can check. */
export function factsFit(facts: EntityFacts, want: Want | null, scope: PictureScope): boolean | undefined {
  const wanted = wantedKinds(want, scope);
  if (wanted === null) return undefined;
  const ids = [...facts.classes, ...facts.supers];
  if (wanted.kinds.some((kind) => anyIn(kind, ids))) return true;
  if (wanted.people && facts.classes.includes(HUMAN)) return wanted.people === "any" || anyIn(wanted.people, facts.jobs);
  return false;
}

/** A page about a name, a list or a category; or an item that says nothing of what it is. */
export function notAThing(facts: EntityFacts): boolean {
  if (facts.classes.length === 0 && facts.supers.length === 0) return true;
  return anyIn("notAThing", facts.classes) && kindOfFacts(facts) === null;
}

/** Where an item was found: its place in each search, 0 first. */
export interface Found {
  wikidata?: number;
  wikipedia?: number;
  /** A Wikipedia page that is a disambiguation page. */
  disambiguation?: boolean;
}

/** How likely [facts] is what somebody typing [typed] in a list of [want] means; higher is likelier. */
export function entityScore(facts: EntityFacts, found: Found, typed: string, want: Want | null, scope: PictureScope): number {
  let total = Math.max(
    found.wikidata === undefined ? 0 : 1.2 / (1 + found.wikidata),
    found.wikipedia === undefined ? 0 : 2 / (1 + found.wikipedia),
  );
  if (factsFit(facts, want, scope) === true) total += 4;
  const first = wantedKinds(want, scope)?.first;
  if (first && anyIn(first, [...facts.classes, ...facts.supers])) total += 3;
  total += 0.8 * Math.log10(1 + facts.sitelinks);
  if (facts.names.some((name) => sameName(name, typed))) total += 2.5;
  if (found.disambiguation || notAThing(facts)) total -= 6;
  if (facts.pictured || Object.keys(facts.ids).length > 0) total += 0.5;
  return total;
}

/** The item chosen for a name, how sure, and the ids its pictures go by. */
export interface Chosen {
  /** Wikidata's id, "Q42". */
  item: string;
  confidence: Confidence;
  kind: PictureKind | null;
  ids: Partial<Record<CatalogueField, string>>;
  /** Keys of the hits that show it (`entityKey`), filled as they are found. */
  keys: string[];
}

/**
 * The item [typed] most likely means, or null when none stands out enough to put first. High: the name
 * is one of its names, it is the kind the list wants (or the list says nothing and it leads by far),
 * and it leads the next by at least 2. Medium: the name, or the kind of an item Wikidata found by name,
 * and a lead of at least 0.8.
 */
export function chooseEntity(candidates: readonly { facts: EntityFacts; found: Found }[], typed: string, want: Want | null, scope: PictureScope): Chosen | null {
  const scored = candidates
    .map((one) => ({ ...one, score: entityScore(one.facts, one.found, typed, want, scope) }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) return null;
  const lead = best.score - (scored[1]?.score ?? 0);
  const named = best.facts.names.some((name) => sameName(name, typed));
  const fits = factsFit(best.facts, want, scope);
  if (fits === false || notAThing(best.facts) || best.found.disambiguation) return null;
  let confidence: Confidence | null = null;
  if (named && lead >= 2 && (fits === true || lead >= 3)) confidence = "high";
  // Without its name, only Wikidata's own search (names and aliases) vouches for it: Wikipedia's matches any text.
  else if ((named || (fits === true && best.found.wikidata !== undefined)) && lead >= 0.8) confidence = "medium";
  if (confidence === null) return null;
  return { item: best.facts.id, confidence, kind: kindOfFacts(best.facts, want, scope), ids: best.facts.ids, keys: [`wikidata:${best.facts.id}`] };
}

/** The key by which a hit is one item's: a TMDB id is a movie's, a series' or a person's. */
export function entityKey(hit: Pick<PictureHit, "id" | "source" | "kind">): string {
  return hit.source === "tmdb" ? `tmdb:${hit.kind}:${hit.id.slice("tmdb:".length)}` : hit.id;
}

/** The keys of the catalogues' hits that are the chosen item, by the ids Wikidata gives it. */
export function catalogueKeys(chosen: Pick<Chosen, "ids">): string[] {
  const { tmdbMovie, tmdbTv, tmdbPerson, anilist, steam, openLibrary, inaturalist } = chosen.ids;
  return [
    ...(tmdbMovie ? [`tmdb:movie:${tmdbMovie}`] : []),
    ...(tmdbTv ? [`tmdb:tv:${tmdbTv}`] : []),
    ...(tmdbPerson ? [`tmdb:person:${tmdbPerson}`] : []),
    ...(anilist ? [`anilist:${anilist}`] : []),
    ...(steam ? [`steam:${steam}`] : []),
    ...(openLibrary && /^OL\d+W$/.test(openLibrary) ? [`openlibrary:${openLibrary}`] : []),
    ...(inaturalist ? [`inaturalist:${inaturalist}`] : []),
  ];
}

/**
 * The hits that show the chosen item, judged as sure as the choice is: high without doubts, medium with
 * the doubts the hit had (or "namesakes": another item came close). Found by the second attempt, never
 * more than medium. Other hits stay as judged.
 */
export function withChosen<T extends Pick<PictureHit, "id" | "source" | "kind"> & { confidence?: Confidence; doubts?: Doubt[] }>(
  hits: readonly T[],
  chosen: Chosen | null | undefined,
  retried: boolean,
): T[] {
  if (!chosen) return [...hits];
  const keys = new Set(chosen.keys);
  return hits.map((hit) => {
    if (hit.confidence === undefined || !keys.has(entityKey(hit))) return hit;
    const { doubts: _doubts, ...rest } = hit;
    if (chosen.confidence === "high" && !retried) return { ...rest, confidence: "high" } as T;
    const kept = (hit.doubts ?? []).filter((doubt) => doubt === "spelling" || doubt === "namesakes" || doubt === "otherName");
    const doubts: Doubt[] = retried && !kept.includes("spelling") ? ["spelling", ...kept] : kept.length > 0 ? kept : ["namesakes"];
    return { ...rest, confidence: "medium", doubts } as T;
  });
}

/** Wikipedia's search answer: the Wikidata items of its pages, in its order. */
export function wikipediaItems(body: unknown): { item: string; disambiguation: boolean }[] {
  const pages = Object.values((((body as Json | null)?.query as Json | undefined)?.pages ?? {}) as Record<string, Json>);
  return pages
    .sort((left, right) => (Number(left.index) || 99) - (Number(right.index) || 99))
    .flatMap((page) => {
      const props = (page.pageprops ?? {}) as Json;
      const item = props.wikibase_item;
      return typeof item === "string" && /^Q\d+$/.test(item) ? [{ item, disambiguation: "disambiguation" in props }] : [];
    });
}

