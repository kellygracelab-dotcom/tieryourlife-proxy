/**
 * Lists published before cards had an `attribution`: each card gets one,
 * worked out as publishing now does, and each catalogue picture we may keep
 * (an openly licensed iNaturalist photo, a Commons file) is copied into the
 * list's own folder and shown from there. Nothing is deleted: a copied card
 * keeps its catalogue address in `attribution.originalUrl`, and the old values
 * of every document it changes are saved first under `--backup` (default
 * D:\MyProjects\TierYourLife\backups\catalogue-pictures-<date>). `updatedAt`
 * is left alone, so no list moves in the feed. A second run finds nothing to
 * do; a picture not copied this time is copied by the next one.
 *
 * A dry run unless `--apply`; a dry run copies nothing. `--list a,b` limits it
 * to those lists; the house's go first anyway.
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
  withCatalogueCopies,
  type CardPicture,
} from "../src/cataloguePictures";
import { EDITORIAL_UID } from "../src/editorial";
import { realOutsideTools } from "../src/outsidePictures";
import type { PictureAttribution } from "../src/pictureAttribution";
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

/** The stored list's cards as publishing reads them. */
export function cardsOf(items: readonly Item[]): CardPicture[] {
  return items.map((item) => ({
    imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : null,
    ...(typeof item.credit === "string" ? { credit: item.credit } : {}),
    ...(item.attribution ? { previous: item.attribution } : {}),
  }));
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

/** The fields that change, as they will be written, and as they were. */
export function changedFields(before: ListPictures, after: ListPictures): { fields: Record<string, unknown>; old: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const key of ["items", "coverImageUrl", "previewImages"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fields[key] = after[key];
  }
  return { fields, old: Object.fromEntries(Object.keys(fields).map((key) => [key, before[key as keyof ListPictures]])) };
}

function readArgs(argv: string[]): { rest: string[]; backup: string; lists: Set<string> | null } {
  const rest: string[] = [];
  let backup = join(DEFAULT_BACKUPS, `catalogue-pictures-${new Date().toISOString().slice(0, 10)}`);
  let lists: Set<string> | null = null;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++at] ?? "";
    if (flag === "--backup") backup = value();
    else if (flag === "--list") lists = new Set(value().split(",").map((id) => id.trim()).filter(Boolean));
    else rest.push(argv[at]);
  }
  return { rest, backup, lists };
}

async function main(): Promise<number> {
  const { rest, backup, lists } = readArgs(process.argv.slice(2));
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

  const docs = (await db.collection("publishedLists").get()).docs
    .filter((doc) => lists === null || lists.has(doc.id))
    .sort((left, right) => Number(right.get("authorUid") === EDITORIAL_UID) - Number(left.get("authorUid") === EDITORIAL_UID));
  if (lists !== null && docs.length < lists.size) console.log(`Not found: ${[...lists].filter((id) => !docs.some((doc) => doc.id === id)).join(" ")}`);

  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const samples = new Samples(40);
  const totals = { cards: 0, attributed: 0, wanted: 0, copied: 0 };
  const bySource = new Map<string, number>();
  for (const doc of docs) {
    const data = doc.data();
    const list: ListPictures = {
      // A card whose picture is not an address is read as one without art, and kept as it is.
      items: Array.isArray(data.items) ? (data.items as Item[]) : [],
      coverImageUrl: typeof data.coverImageUrl === "string" ? data.coverImageUrl : null,
      previewImages: Array.isArray(data.previewImages) ? data.previewImages.filter((url): url is string => typeof url === "string") : [],
    };
    const cards = cardsOf(list.items);
    const files = commonsFilesOf(cards);
    const attributions = attributionsOf(cards, files.length > 0 ? await askCommons(files) : new Map());
    const wanted = copiesWanted(cards, attributions);
    const copied = dryRun || wanted.length === 0
      ? { copies: new Map<string, string>(), saved: [] }
      : await copyCataloguePictures(`published/${doc.id}/`, wanted, tools, { withinMs: LIST_COPY_WINDOW_MS });
    const after = withCatalogueCopies(withAttributions(list, attributions), copied.copies);
    const { fields, old } = changedFields(list, after);

    totals.cards += list.items.length;
    totals.attributed += attributions.filter(Boolean).length;
    totals.wanted += wanted.length;
    totals.copied += copied.copies.size;
    attributions.forEach((one) => one && bySource.set(one.source, (bySource.get(one.source) ?? 0) + 1));
    const house = data.authorUid === EDITORIAL_UID ? "house" : "user";
    samples.add(`${doc.id} (${house}) ${String(data.title ?? "").slice(0, 40)}: ${list.items.length} cards, ${attributions.filter(Boolean).length} attributed, ${wanted.length} to copy${dryRun ? "" : `, ${copied.copies.size} copied`}; ${Object.keys(fields).join(", ") || "nothing to change"}`);
    if (Object.keys(fields).length === 0) continue;
    saved[doc.ref.path] = old;
    updates.push({ ref: doc.ref, fields, readAt: doc.updateTime });
  }
  console.log(`publishedLists: ${docs.length} lists, ${totals.cards} cards, ${totals.attributed} attributed (${[...bySource].map(([source, n]) => `${source} ${n}`).join(", ")}), ${totals.wanted} pictures we may copy${dryRun ? "" : `, ${totals.copied} copied`}.`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

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
