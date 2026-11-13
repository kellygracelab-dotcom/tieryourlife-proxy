/**
 * Lists published before cards had an `attribution`: each card gets one,
 * worked out as publishing now does, and each catalogue picture we may keep
 * (an openly licensed iNaturalist photo, a Commons file) is copied into the
 * list's own folder and shown from there. Nothing is deleted: a copied card
 * keeps its catalogue address in `attribution.originalUrl`, and the old values
 * of every document it changes are saved first under `--backup` (default
 * D:\MyProjects\TierYourLife\backups\catalogue-pictures-<date>). `updatedAt`
 * is left alone, so no list moves in the feed; its `revision` moves, so an
 * editor's older copy is not published over it. A second run finds nothing to
 * do; a picture not copied this time is copied by the next one.
 *
 * Which catalogues are copied follows `config/pictureCopies` (src/pictureCopies.ts);
 * `--sources tmdb,anilist` copies only those of them this time; in a dry run it
 * shows what those would copy even while switched off, counted by catalogue,
 * before a switch is turned on. The cover and
 * the collage are copied as the cards are. Ranking snapshots too: each into its
 * own folder, `published/ranking-{id}/`, as a website ranking outlives its list;
 * their credits are kept as they are. Boards accounts keep too, into the one
 * shared folder `published/catalogue/` (`src/boardPictures.ts`), in place: a
 * board's revision and fingerprint do not move, and a board that would not
 * fit with its pictures moved is left as it is.
 *
 * A dry run unless `--apply`; a dry run copies nothing. `--list a,b` limits it
 * to those lists and their rankings; the house's go first anyway.
 *
 *   npm run catalogue-pictures -- --project tieryourlife
 *   npm run catalogue-pictures -- --project tieryourlife --list AzFH5kWWVPXS2Fl8XXwE --apply
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  askCommons,
  attributionsOf,
  catalogueCopyTools,
  commonsFilesOf,
  copiesWanted,
  copyCataloguePictures,
  coverCopiesWanted,
  withCatalogueCopies,
  type CardPicture,
} from "../src/cataloguePictures";
import { COPY_SOURCES, copySwitches, type CopySwitches } from "../src/pictureCopies";
import { copyToShared, fitsWithCopies } from "../src/boardPictures";
import { pictureFields, shownPictures, stillToCopy } from "../src/pictureCopyUpkeep";
import { EDITORIAL_UID } from "../src/editorial";
import { realOutsideTools } from "../src/outsidePictures";
import { HOUSE_FILL_JOBS } from "../src/houseFill";
import { catalogueIdOf, catalogueSourceOf, type PictureAttribution } from "../src/pictureAttribution";
import { readBackfillOptions, Samples, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const DEFAULT_BACKUPS = "D:\\MyProjects\\TierYourLife\\backups";
/** Copying a whole list may take minutes; nothing waits for an answer here. */
const LIST_COPY_WINDOW_MS = 10 * 60 * 1000;

type Item = { imageUrl: string | null; credit?: unknown; attribution?: PictureAttribution } & Record<string, unknown>;

export interface ListPictures {
  items: Item[];
  coverImageUrl: string | null;
  previewImages: string[];
}

/**
 * The stored list's cards as publishing reads them, each with the catalogue id
 * [ids] knows for its address, as if the client had sent it back.
 */
export function cardsOf(items: readonly Item[], ids: ReadonlyMap<string, string> = new Map()): CardPicture[] {
  return items.map((item) => {
    const id = typeof item.imageUrl === "string" ? ids.get(item.imageUrl) : undefined;
    return {
      imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
      ...(typeof item.credit === "string" ? { credit: item.credit } : {}),
      ...(item.attribution ? { previous: item.attribution } : {}),
      ...(id ? { sent: { id } } : {}),
    };
  });
}

/**
 * Each catalogue address the house fill's searches answered with, to the id of
 * the hit that showed it, in the shape cards keep (`tmdb:movie:603`). An address
 * two different hits showed is left out: no id is better than a guessed one.
 */
export function idsFromJobs(jobs: readonly unknown[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const job of jobs) {
    const answers = ((job ?? {}) as { answers?: unknown }).answers;
    for (const answer of Array.isArray(answers) ? answers : []) {
      const hits = ((answer ?? {}) as { hits?: unknown }).hits;
      for (const hit of Array.isArray(hits) ? hits : []) {
        const { id, kind, imageUrl } = (hit ?? {}) as { id?: unknown; kind?: unknown; imageUrl?: unknown };
        if (typeof imageUrl !== "string" || typeof id !== "string") continue;
        const source = catalogueSourceOf(imageUrl);
        if (source === null) continue;
        const shaped = source === "tmdb" && typeof kind === "string" ? id.replace(/^tmdb:/, `tmdb:${kind}:`) : id;
        if (catalogueIdOf(source, shaped) === null) continue;
        seen.set(imageUrl, (seen.get(imageUrl) ?? new Set()).add(shaped));
      }
    }
  }
  return new Map([...seen].flatMap(([url, ids]) => (ids.size === 1 ? [[url, [...ids][0]] as [string, string]] : [])));
}

/** The list with each card's attribution in place; a card that has none keeps whatever it had. */
export function withAttributions(list: ListPictures, attributions: readonly (PictureAttribution | null)[]): ListPictures {
  return {
    ...list,
    items: list.items.map((item, at) => {
      const attribution = attributions[at];
      return attribution ? { ...item, attribution } : item;
    }),
  };
}

/**
 * [value] as JSON with every object's keys in one order: Firestore keeps no
 * order of a map's keys, so a card read back may list its fields otherwise
 * than they were written, and is still the same card.
 */
export function sameJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : inner,
  );
}

/** The fields that change, as they will be written, and as they were. */
export function changedFields(before: ListPictures, after: ListPictures): { fields: Record<string, unknown>; old: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const key of ["items", "coverImageUrl", "previewImages"] as const) {
    if (sameJson(before[key]) !== sameJson(after[key])) fields[key] = after[key];
  }
  return { fields, old: Object.fromEntries(Object.keys(fields).map((key) => [key, before[key as keyof ListPictures]])) };
}

/**
 * The catalogues this run copies: those switched on in [stored], of [sources]
 * when it names some; a dry run naming [sources] counts them as if switched on.
 */
export function switchesFor(stored: CopySwitches, sources: ReadonlySet<string> | null, dryRun: boolean): CopySwitches {
  return Object.fromEntries(
    COPY_SOURCES.map((source) => [source, sources !== null && dryRun ? sources.has(source) : stored[source] && (sources === null || sources.has(source))]),
  ) as CopySwitches;
}

/** How many of [urls] each catalogue gives. */
function countBySource(into: Map<string, number>, urls: readonly string[]): void {
  urls.forEach((url) => {
    const source = catalogueSourceOf(url) ?? "web";
    into.set(source, (into.get(source) ?? 0) + 1);
  });
}

const bySourceText = (counts: ReadonlyMap<string, number>) => [...counts].map(([source, n]) => `${source} ${n}`).join(", ") || "none";

function readArgs(argv: string[]): { rest: string[]; backup: string; lists: Set<string> | null; sources: Set<string> | null } {
  const rest: string[] = [];
  let sources: Set<string> | null = null;
  let backup = join(DEFAULT_BACKUPS, `catalogue-pictures-${new Date().toISOString().slice(0, 10)}`);
  let lists: Set<string> | null = null;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++at] ?? "";
    if (flag === "--backup") backup = value();
    else if (flag === "--list") lists = new Set(value().split(",").map((id) => id.trim()).filter(Boolean));
    else if (flag === "--sources") sources = new Set(value().split(",").map((id) => id.trim()).filter(Boolean));
    else rest.push(argv[at]);
  }
  return { rest, backup, lists, sources };
}

async function main(): Promise<number> {
  const { rest, backup, lists, sources } = readArgs(process.argv.slice(2));
  const options = readBackfillOptions(rest);
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}, bucket ${options.bucket}. ${dryRun ? "Dry run: nothing is copied or changed." : "APPLY: attributions written, pictures we may keep copied."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();
  const tools = catalogueCopyTools(realOutsideTools("catalogue-backfill"));
  const stored = await copySwitches();
  const switches = switchesFor(stored, sources, dryRun);
  console.log(`Copying: ${COPY_SOURCES.filter((source) => switches[source]).join(", ") || "nothing"} (${sources !== null && dryRun ? `as if switched on: ${[...sources].join(", ")}; switched on now: ${COPY_SOURCES.filter((source) => stored[source]).join(", ")}` : `config/pictureCopies${sources === null ? "" : `, only ${[...sources].join(", ")}`}`}).`);

  const docs = (await db.collection("publishedLists").get()).docs
    .filter((doc) => lists === null || lists.has(doc.id))
    .sort((left, right) => Number(right.get("authorUid") === EDITORIAL_UID) - Number(left.get("authorUid") === EDITORIAL_UID));
  if (lists !== null && docs.length < lists.size) console.log(`Not found: ${[...lists].filter((id) => !docs.some((doc) => doc.id === id)).join(" ")}`);

  const ids = idsFromJobs((await db.collection(HOUSE_FILL_JOBS).get()).docs.map((doc) => doc.data()));
  console.log(`House fill searches name the catalogue id of ${ids.size} addresses.`);

  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const samples = new Samples(40);
  const totals = { cards: 0, attributed: 0, withId: 0, wanted: 0, copied: 0 };
  const bySource = new Map<string, number>();
  const idsBySource = new Map<string, number>();
  const wantedBySource = new Map<string, number>();
  for (const doc of docs) {
    const data = doc.data();
    const list: ListPictures = {
      // A card whose picture is not an address is read as one without art, and kept as it is.
      items: Array.isArray(data.items) ? (data.items as Item[]) : [],
      coverImageUrl: typeof data.coverImageUrl === "string" ? data.coverImageUrl : null,
      previewImages: Array.isArray(data.previewImages) ? data.previewImages.filter((url): url is string => typeof url === "string") : [],
    };
    const cards = cardsOf(list.items, ids);
    const files = commonsFilesOf(cards);
    const attributions = attributionsOf(cards, files.length > 0 ? await askCommons(files) : new Map());
    const wanted = [...new Set([...copiesWanted(cards, attributions, switches), ...coverCopiesWanted([list.coverImageUrl, ...list.previewImages], switches)])];
    const copied = dryRun || wanted.length === 0
      ? { copies: new Map<string, string>(), saved: [] }
      : await copyCataloguePictures(`published/${doc.id}/`, wanted, tools, { withinMs: LIST_COPY_WINDOW_MS });
    const after = withCatalogueCopies(withAttributions(list, attributions), copied.copies);
    const { fields, old } = changedFields(list, after);

    totals.cards += list.items.length;
    totals.attributed += attributions.filter(Boolean).length;
    totals.withId += attributions.filter((one) => one?.id).length;
    totals.wanted += wanted.length;
    countBySource(wantedBySource, wanted);
    totals.copied += copied.copies.size;
    attributions.forEach((one) => one && bySource.set(one.source, (bySource.get(one.source) ?? 0) + 1));
    attributions.forEach((one) => one?.id && idsBySource.set(one.source, (idsBySource.get(one.source) ?? 0) + 1));
    const house = data.authorUid === EDITORIAL_UID ? "house" : "user";
    samples.add(`${doc.id} (${house}) ${String(data.title ?? "").slice(0, 40)}: ${list.items.length} cards, ${attributions.filter(Boolean).length} attributed, ${wanted.length} to copy${dryRun ? "" : `, ${copied.copies.size} copied`}; ${Object.keys(fields).join(", ") || "nothing to change"}`);
    if (Object.keys(fields).length === 0) continue;
    saved[doc.ref.path] = old;
    updates.push({ ref: doc.ref, fields, readAt: doc.updateTime, revise: true });
  }
  console.log(`publishedLists: ${docs.length} lists, ${totals.cards} cards, ${totals.attributed} attributed, ${totals.withId} with a catalogue id (${[...bySource].map(([source, n]) => `${source} ${n}, ${idsBySource.get(source) ?? 0} with id`).join("; ")}), ${totals.wanted} pictures we may copy (${bySourceText(wantedBySource)})${dryRun ? "" : `, ${totals.copied} copied`}.`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

  // Ranking snapshots: their cards' catalogue pictures, each ranking into a folder of its own.
  const rankingDocs = (await db.collection("rankings").get()).docs.filter((doc) => lists === null || lists.has(String(doc.get("listId"))));
  const rankingSamples = new Samples(40);
  let rankingWanted = 0;
  let rankingCopied = 0;
  const rankingBySource = new Map<string, number>();
  for (const doc of rankingDocs) {
    const items = doc.get("snapshot.items") as Item[] | undefined;
    if (!Array.isArray(items)) continue;
    const snapshot: ListPictures = { items, coverImageUrl: null, previewImages: [] };
    const wanted = copiesWanted(cardsOf(items), items.map((item) => item?.attribution ?? null), switches);
    if (wanted.length === 0) continue;
    const copied = dryRun
      ? { copies: new Map<string, string>(), saved: [] }
      : await copyCataloguePictures(`published/ranking-${doc.id}/`, wanted, tools, { withinMs: LIST_COPY_WINDOW_MS });
    rankingWanted += wanted.length;
    countBySource(rankingBySource, wanted);
    rankingCopied += copied.copies.size;
    rankingSamples.add(`${doc.ref.path}: ${items.length} cards, ${wanted.length} to copy${dryRun ? "" : `, ${copied.copies.size} copied`}`);
    const after = withCatalogueCopies(snapshot, copied.copies);
    if (sameJson(after.items) === sameJson(items)) continue;
    saved[doc.ref.path] = { "snapshot.items": items };
    updates.push({ ref: doc.ref, fields: { "snapshot.items": after.items }, readAt: doc.updateTime });
  }
  console.log(`rankings: ${rankingDocs.length} snapshots, ${rankingWanted} pictures to copy (${bySourceText(rankingBySource)})${dryRun ? "" : `, ${rankingCopied} copied`}.`);
  rankingSamples.lines.forEach((line) => console.log(`  ${line}`));

  // Boards kept in accounts: one shared copy per catalogue address, written in place.
  const boardDocs = lists === null ? (await db.collectionGroup("boards").get()).docs.filter((doc) => doc.get("deleted") !== true) : [];
  const boardSamples = new Samples(40);
  const boardBySource = new Map<string, number>();
  let boardWanted = 0;
  let boardCopied = 0;
  let boardsTooLarge = 0;
  for (const doc of boardDocs) {
    const before = shownPictures(doc.data(), "board");
    const wanted = stillToCopy(before, switches);
    if (wanted.length === 0) continue;
    boardWanted += wanted.length;
    countBySource(boardBySource, wanted);
    const copies = dryRun ? new Map<string, string>() : await copyToShared(wanted, tools, LIST_COPY_WINDOW_MS);
    boardCopied += copies.size;
    const after = withCatalogueCopies(before as ListPictures, copies);
    const fields = pictureFields(before, after, "board");
    const fits = fitsWithCopies({ ...doc.data(), ...fields });
    if (!fits) boardsTooLarge++;
    boardSamples.add(`${doc.ref.parent.parent?.id.slice(0, 6)}…/boards/${doc.id}: ${before.items.length} cards, ${wanted.length} to copy${dryRun ? "" : `, ${copies.size} copied`}${fits ? "" : ", too large to move: left as it is"}`);
    if (Object.keys(fields).length === 0 || !fits) continue;
    saved[doc.ref.path] = pictureFields(after, before, "board");
    updates.push({ ref: doc.ref, fields, readAt: doc.updateTime });
  }
  console.log(`boards: ${boardDocs.length} kept, ${boardWanted} pictures to copy (${bySourceText(boardBySource)})${dryRun ? "" : `, ${boardCopied} copied`}${boardsTooLarge > 0 ? `; ${boardsTooLarge} too large to move` : ""}.`);
  boardSamples.lines.forEach((line) => console.log(`  ${line}`));

  if (updates.length === 0) {
    console.log("Nothing to change.");
    return 0;
  }
  mkdirSync(backup, { recursive: true });
  const file = join(backup, `${dryRun ? "dry-run" : "apply"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ project: options.projectId, documents: saved }, null, 2));
  console.log(`Old values of ${updates.length} lists saved to ${file}`);
  if (dryRun) {
    console.log("Dry run: nothing was changed. Add --apply to do it.");
    return 0;
  }
  const { written, leftAlone } = await writeGuarded(db, updates, (line) => console.log(line));
  console.log(`Done: ${written} lists written, ${leftAlone} left alone (changed since they were read). Run it again to pick those up.`);
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
