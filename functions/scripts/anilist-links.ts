/**
 * Cards whose picture AniList gave and whose `attribution` has no `link`: the
 * site then shows no "About the picture". Publishing gives each a link now
 * (`linkFromAddress`, `anilistLink`); this gives one to the cards stored
 * before. A character's page follows from its id (`anilist:c{n}`); an anime's
 * or a manga's (`anilist:{n}`, one numbering for both) from the type AniList
 * names for that id, asked fifty ids at a time, one request after another,
 * or else from the folder of the card's AniList address (`/media/anime/cover/…`).
 *
 * It walks published lists (`items`; the `revision` moves, `updatedAt` stays),
 * ranking snapshots (`snapshot.items`, and `addedCards` where a ranking has
 * them) and boards kept in accounts (`items`, in place: a board's revision and
 * fingerprint never move, and a board that would no longer fit is left as it
 * is). Nothing else on a card changes. The old values of every document it
 * changes are saved first under `--backup` (default
 * D:/MyProjects/TierYourLife/backups/anilist-links-<date>).
 *
 * A dry run unless `--apply`; a dry run asks AniList but writes nothing to Firestore.
 *
 *   npm run anilist-links -- --project tieryourlife
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fitsWithCopies } from "../src/boardPictures";
import { anilistLink, catalogueIdOf, catalogueSourceOf, idFromAddress, linkFromAddress } from "../src/pictureAttribution";
import { retryAfterMs, USER_AGENT } from "../src/pictureSources";
import { readBackfillOptions, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const DEFAULT_BACKUPS = "D:/MyProjects/TierYourLife/backups";
const ANILIST = "https://graphql.anilist.co";
export const IDS_PER_REQUEST = 50;
/** AniList allows 90 requests a minute, 30 while it is degraded: one every two seconds is within both. */
const PAUSE_MS = 2100;
const MAX_TRIES = 5;

export type MediaType = "ANIME" | "MANGA";

/** A card that needs its AniList page: where it is, and what for. */
export type AnilistNeed =
  | { at: number; kind: "character"; number: string }
  | { at: number; kind: "media"; number: string; fromAddress: MediaType | null };

type Card = { imageUrl?: unknown; attribution?: Record<string, unknown> } & Record<string, unknown>;

/** The AniList cards of [items] whose attribution has no link (an editor's own credit aside), and what each needs. */
export function linksNeeded(items: readonly unknown[]): AnilistNeed[] {
  return items.flatMap((raw, at): AnilistNeed[] => {
    const card = (raw ?? {}) as Card;
    const attribution = card.attribution;
    if (attribution === null || typeof attribution !== "object" || attribution.source !== "anilist") return [];
    if ((typeof attribution.link === "string" && attribution.link !== "") || attribution.manual === true) return [];
    const address = [attribution.originalUrl, card.imageUrl].find((url): url is string => typeof url === "string" && catalogueSourceOf(url) === "anilist") ?? null;
    const id = catalogueIdOf("anilist", attribution.id) ?? (address === null ? null : idFromAddress(address, null));
    const match = id === null ? null : /^anilist:(c?)(\d+)$/.exec(id);
    if (match === null) return [];
    if (match[1] === "c") return [{ at, kind: "character", number: match[2]! }];
    // The address's own folder, when it names the same media.
    const page = address === null ? null : linkFromAddress(address);
    const said = page === null ? null : /^https:\/\/anilist\.co\/(anime|manga)\/(\d+)$/.exec(page);
    const fromAddress = said !== null && said[2] === match[2] ? (said[1]!.toUpperCase() as MediaType) : null;
    return [{ at, kind: "media", number: match[2]!, fromAddress }];
  });
}

/** The page [need] gets: AniList's word on the media's type first, the address's folder next; null when neither says. */
export function linkFor(need: AnilistNeed, types: ReadonlyMap<string, MediaType>): string | null {
  if (need.kind === "character") return anilistLink(`anilist:c${need.number}`, null);
  return anilistLink(`anilist:${need.number}`, types.get(need.number) ?? need.fromAddress);
}

export interface Linked {
  items: unknown[];
  anime: number;
  manga: number;
  character: number;
  /** Media AniList did not answer for and whose address does not say. */
  unresolved: string[];
  /** Media whose address's folder says otherwise than AniList: AniList's is kept. */
  disagreed: string[];
}

/** [items] with each card of [needs] given its page; every other card, and every other field, as it was. */
export function withLinks(items: readonly unknown[], needs: readonly AnilistNeed[], types: ReadonlyMap<string, MediaType>): Linked {
  const out = [...items];
  const result: Linked = { items: out, anime: 0, manga: 0, character: 0, unresolved: [], disagreed: [] };
  for (const need of needs) {
    const link = linkFor(need, types);
    if (need.kind === "media" && need.fromAddress !== null && types.has(need.number) && types.get(need.number) !== need.fromAddress) result.disagreed.push(need.number);
    if (link === null) {
      result.unresolved.push(need.number);
      continue;
    }
    const card = out[need.at] as Card;
    out[need.at] = { ...card, attribution: { ...card.attribution, link } };
    result[need.kind === "character" ? "character" : link.includes("/manga/") ? "manga" : "anime"]++;
  }
  return result;
}

export const MEDIA_TYPE_QUERY = "query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids) { id type siteUrl } } }";

/** Each media AniList answered with, to its type; anything else in the answer is ignored. */
export function mediaTypesOf(body: unknown): Map<string, MediaType> {
  const media = (((body as { data?: { Page?: { media?: unknown } } } | null)?.data?.Page?.media) ?? []) as unknown;
  const types = new Map<string, MediaType>();
  for (const row of Array.isArray(media) ? media : []) {
    const { id, type } = (row ?? {}) as { id?: unknown; type?: unknown };
    if (typeof id === "number" && Number.isInteger(id) && (type === "ANIME" || type === "MANGA")) types.set(String(id), type);
  }
  return types;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** AniList's type of each of [numbers], asked one request at a time; a request that keeps failing leaves its ids out. */
async function askTypes(numbers: readonly string[], log: (line: string) => void): Promise<Map<string, MediaType>> {
  const types = new Map<string, MediaType>();
  for (let at = 0; at < numbers.length; at += IDS_PER_REQUEST) {
    const batch = numbers.slice(at, at + IDS_PER_REQUEST);
    if (at > 0) await sleep(PAUSE_MS);
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const response = await fetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: MEDIA_TYPE_QUERY, variables: { ids: batch.map(Number) } }),
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => ({ ok: false, status: 0, headers: new Headers(), error }) as const);
      if (response.ok) {
        const answered = mediaTypesOf(await (response as Response).json());
        answered.forEach((type, id) => types.set(id, type));
        log(`  AniList: ${batch.length} ids asked, ${answered.size} answered`);
        break;
      }
      const wait = response.status === 429 ? retryAfterMs(response.headers.get("Retry-After"), Date.now()) ?? 60_000 : 5_000 * attempt;
      log(`  AniList answered ${response.status || "nothing"} (try ${attempt} of ${MAX_TRIES}); waiting ${Math.round(wait / 1000)} s`);
      if (attempt === MAX_TRIES) break;
      await sleep(Math.min(wait + 1000, 120_000));
    }
  }
  return types;
}

type Kind = "list" | "ranking" | "board";
interface Place {
  doc: FirebaseFirestore.QueryDocumentSnapshot;
  kind: Kind;
  fields: { field: string; items: unknown[]; needs: AnilistNeed[] }[];
}

function readArgs(argv: string[]): { rest: string[]; backup: string } {
  const rest: string[] = [];
  let backup = `${DEFAULT_BACKUPS}/anilist-links-${new Date().toISOString().slice(0, 10)}`;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at]!.split(/=(.*)/s, 2);
    if (flag === "--backup") backup = (inline ?? argv[++at] ?? backup).replace(/\\/g, "/");
    else rest.push(argv[at]!);
  }
  return { rest, backup };
}

async function main(): Promise<number> {
  const { rest, backup } = readArgs(process.argv.slice(2));
  const options = readBackfillOptions(rest);
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}. ${dryRun ? "Dry run: nothing is changed." : "APPLY: AniList pages written to the cards without one."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId });
  const db = getFirestore();
  const [lists, rankings, boards] = await Promise.all([db.collection("publishedLists").get(), db.collection("rankings").get(), db.collectionGroup("boards").get()]);
  const live = boards.docs.filter((doc) => doc.get("deleted") !== true);
  console.log(`${lists.size} lists, ${rankings.size} rankings, ${live.length} boards kept (${boards.size - live.length} thrown away, not read).`);

  const places: Place[] = [];
  const add = (doc: FirebaseFirestore.QueryDocumentSnapshot, kind: Kind, named: [string, unknown][]) => {
    const fields = named.flatMap(([field, raw]) => {
      if (!Array.isArray(raw)) return [];
      const needs = linksNeeded(raw);
      return needs.length > 0 ? [{ field, items: raw as unknown[], needs }] : [];
    });
    if (fields.length > 0) places.push({ doc, kind, fields });
  };
  lists.docs.forEach((doc) => add(doc, "list", [["items", doc.get("items")]]));
  rankings.docs.forEach((doc) => add(doc, "ranking", [["snapshot.items", doc.get("snapshot.items")], ["addedCards", doc.get("addedCards")]]));
  live.forEach((doc) => add(doc, "board", [["items", doc.get("items")]]));

  const media = [...new Set(places.flatMap((place) => place.fields.flatMap((one) => one.needs.flatMap((need) => (need.kind === "media" ? [need.number] : [])))))].sort((a, b) => Number(a) - Number(b));
  const characters = new Set(places.flatMap((place) => place.fields.flatMap((one) => one.needs.flatMap((need) => (need.kind === "character" ? [need.number] : [])))));
  console.log(`Cards without a page: ${places.reduce((sum, place) => sum + place.fields.reduce((n, one) => n + one.needs.length, 0), 0)}, of ${media.length} distinct anime or manga and ${characters.size} characters.`);
  const types = media.length > 0 ? await askTypes(media, (line) => console.log(line)) : new Map<string, MediaType>();
  const unanswered = media.filter((number) => !types.has(number));
  console.log(`AniList named ${types.size} of ${media.length}: ${[...types.values()].filter((type) => type === "ANIME").length} anime, ${[...types.values()].filter((type) => type === "MANGA").length} manga${unanswered.length > 0 ? `; not answered: ${unanswered.join(", ")}` : ""}.`);

  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const totals = new Map<Kind, { docs: number; cards: number; anime: number; manga: number; character: number; unresolved: Set<string>; disagreed: Set<string>; tooLarge: number }>();
  for (const place of places) {
    const total = totals.get(place.kind) ?? { docs: 0, cards: 0, anime: 0, manga: 0, character: 0, unresolved: new Set(), disagreed: new Set(), tooLarge: 0 };
    totals.set(place.kind, total);
    total.docs++;
    const fields: Record<string, unknown> = {};
    const old: Record<string, unknown> = {};
    const counts = { cards: 0, anime: 0, manga: 0, character: 0, unresolved: 0 };
    for (const one of place.fields) {
      const linked = withLinks(one.items, one.needs, types);
      counts.cards += one.needs.length;
      counts.anime += linked.anime;
      counts.manga += linked.manga;
      counts.character += linked.character;
      counts.unresolved += linked.unresolved.length;
      linked.unresolved.forEach((number) => total.unresolved.add(number));
      linked.disagreed.forEach((number) => total.disagreed.add(number));
      if (linked.anime + linked.manga + linked.character === 0) continue;
      fields[one.field] = linked.items;
      old[one.field] = one.items;
    }
    total.cards += counts.cards;
    total.anime += counts.anime;
    total.manga += counts.manga;
    total.character += counts.character;
    const fits = place.kind !== "board" || fitsWithCopies({ ...place.doc.data(), ...fields });
    if (!fits) total.tooLarge++;
    const name = place.kind === "board" ? `${place.doc.ref.parent.parent?.id.slice(0, 6)}…/boards/${place.doc.id}` : place.doc.ref.path;
    const title = String(place.doc.get(place.kind === "ranking" ? "snapshot.title" : "title") ?? "").slice(0, 40);
    console.log(`  ${name} "${title}": ${counts.cards} cards without a page: ${counts.anime} anime, ${counts.manga} manga, ${counts.character} characters${counts.unresolved > 0 ? `, ${counts.unresolved} unknown` : ""}${fits ? "" : "; too large with them: left as it is"}`);
    if (Object.keys(fields).length === 0 || !fits) continue;
    saved[place.doc.ref.path] = old;
    updates.push({ ref: place.doc.ref, fields, readAt: place.doc.updateTime, revise: place.kind === "list" });
  }
  for (const kind of ["list", "ranking", "board"] as const) {
    const total = totals.get(kind);
    const label = { list: "publishedLists", ranking: "rankings", board: "boards" }[kind];
    if (total === undefined) {
      console.log(`${label}: nothing to do.`);
      continue;
    }
    console.log(`${label}: ${total.docs} documents, ${total.cards} cards: ${total.anime} anime, ${total.manga} manga, ${total.character} characters${total.unresolved.size > 0 ? `; unknown: ${[...total.unresolved].join(", ")}` : ""}${total.disagreed.size > 0 ? `; address said otherwise than AniList (AniList's kept): ${[...total.disagreed].join(", ")}` : ""}${total.tooLarge > 0 ? `; ${total.tooLarge} boards too large` : ""}.`);
  }

  if (updates.length === 0) {
    console.log("Nothing to change.");
    return 0;
  }
  mkdirSync(backup, { recursive: true });
  const file = `${backup}/${dryRun ? "dry-run" : "apply"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ project: options.projectId, documents: saved }, null, 2));
  console.log(`Old values of ${updates.length} documents saved to ${file}`);
  if (dryRun) {
    console.log("Dry run: nothing was changed. Add --apply to do it.");
    return 0;
  }
  const { written, leftAlone } = await writeGuarded(db, updates, (line) => console.log(line));
  console.log(`Done: ${written} documents written, ${leftAlone} left alone (changed since they were read). Run it again to pick those up.`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
