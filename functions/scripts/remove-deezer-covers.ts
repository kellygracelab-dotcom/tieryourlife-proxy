/**
 * A one-off, only on Danylo's word: Deezer's covers taken off the public
 * lists and rankings, now that publishing drops them too. A card that had one
 * stays, by its title, without art; a cover goes; the collage loses them and,
 * when it followed the cards, is drawn again from the cards' art as publish
 * draws it. Each document is written only as it was read, and a second run
 * finds nothing to do. A dry run unless `--apply`. Either way the old values
 * of every document it would change are saved first, by path, under
 * `--backup` (default D:\MyProjects\TierYourLife\backups\deezer-removal-<date>).
 *
 *   npm run remove-deezer-covers -- --project tieryourlife
 *   npm run remove-deezer-covers -- --project tieryourlife --apply
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { isDeezerPicture } from "../src/pictureSources";
import { MAX_PREVIEW_IMAGES } from "../src/publishing";
import { deezerAddressesIn } from "./count-deezer-covers";
import { readBackfillOptions, Samples, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const COLLECTIONS = ["publishedLists", "rankings"];
const DEFAULT_BACKUPS = "D:\\MyProjects\\TierYourLife\\backups";
/** Fields this takes Deezer out of; anything else holding a Deezer address is only reported. */
const HANDLED = /^(items\[\]\.imageUrl|coverImageUrl|coverImageUrls\[\]|previewImages\[\]|collage\[\])$/;

const isDeezer = (value: unknown): boolean => typeof value === "string" && isDeezerPicture(value);
const pictures = (value: unknown): string[] => (Array.isArray(value) ? value.filter((url): url is string => typeof url === "string") : []);
const cardArt = (items: readonly Record<string, unknown>[]): string[] =>
  items.map((item) => item?.imageUrl).filter((url): url is string => typeof url === "string").slice(0, MAX_PREVIEW_IMAGES);

export interface Removal {
  /** The fields as they will be written. */
  fields: Record<string, unknown>;
  /** The same fields as they were. */
  before: Record<string, unknown>;
  cards: number;
}

/** What a stored list or ranking becomes without Deezer's covers, or null when it holds none where this looks. */
export function withoutDeezer(data: Record<string, unknown>): Removal | null {
  const fields: Record<string, unknown> = {};
  let cards = 0;
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : null;
  const itemsAfter = items?.map((item) => {
    if (!isDeezer(item?.imageUrl)) return item;
    cards++;
    return { ...item, imageUrl: null };
  }) ?? null;
  if (items !== null && cards > 0) fields.items = itemsAfter;
  if (isDeezer(data.coverImageUrl)) fields.coverImageUrl = null;
  for (const name of ["coverImageUrls", "collage"]) {
    if (pictures(data[name]).some(isDeezer)) fields[name] = pictures(data[name]).filter((url) => !isDeezer(url));
  }
  if (Array.isArray(data.previewImages)) {
    const previous = pictures(data.previewImages);
    // Followed the cards' art, as publish draws it when the author chose none: drawn again from what is left.
    const derived = items !== null && JSON.stringify(previous) === JSON.stringify(cardArt(items));
    const chosen = previous.filter((url) => !isDeezer(url));
    const next = derived || chosen.length === 0 ? cardArt(itemsAfter ?? []) : chosen;
    if (JSON.stringify(next) !== JSON.stringify(previous)) fields.previewImages = next;
  }
  if (Object.keys(fields).length === 0) return null;
  return { fields, before: Object.fromEntries(Object.keys(fields).map((key) => [key, data[key] ?? null])), cards };
}

function readArgs(argv: string[]): { rest: string[]; backup: string } {
  const at = argv.findIndex((one) => one === "--backup" || one.startsWith("--backup="));
  const date = new Date().toISOString().slice(0, 10);
  if (at < 0) return { rest: argv, backup: join(DEFAULT_BACKUPS, `deezer-removal-${date}`) };
  const inline = argv[at].split("=")[1];
  const value = inline ?? argv[at + 1];
  return { rest: argv.filter((_, index) => index !== at && (inline !== undefined || index !== at + 1)), backup: value };
}

async function main(): Promise<number> {
  const { rest, backup } = readArgs(process.argv.slice(2));
  const options = readBackfillOptions(rest);
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}. ${dryRun ? "Dry run: nothing is changed." : "APPLY: Deezer's covers are taken off."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();

  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const samples = new Samples();
  const changing: string[] = [];
  const untouched = new Map<string, number>();
  let cards = 0;
  for (const name of COLLECTIONS) {
    const docs = (await db.collection(name).get()).docs;
    let here = 0;
    for (const doc of docs) {
      const data = doc.data();
      for (const { path } of deezerAddressesIn(data)) {
        const field = path.replace(/\[\d+\]/g, "[]");
        if (!HANDLED.test(field)) {
          untouched.set(`${name} ${field}`, (untouched.get(`${name} ${field}`) ?? 0) + 1);
        }
      }
      const removal = withoutDeezer(data);
      if (removal === null) continue;
      here++;
      cards += removal.cards;
      changing.push(doc.id);
      saved[doc.ref.path] = removal.before;
      samples.add(`${doc.ref.path}  ${removal.cards} cards; ${Object.keys(removal.fields).join(", ")}`);
      updates.push({ ref: doc.ref, fields: removal.fields, readAt: doc.updateTime });
    }
    console.log(`${name}: ${docs.length} documents, ${here} to change.`);
  }
  console.log(`In all: ${updates.length} documents, ${cards} cards left without art.`);
  if (untouched.size > 0) console.log(`Deezer addresses in fields this leaves alone: ${[...untouched].map(([field, n]) => `${field} (${n})`).join(", ")}`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

  // The site's share cards were drawn with the old pictures.
  const [shareCards] = await getStorage().bucket().getFiles({ prefix: "share/l/" });
  const drawn = changing.filter((id) => shareCards.some((file) => file.name.startsWith(`share/l/${id}/`)));
  console.log(`Share cards already drawn for ${drawn.length} of these lists${drawn.length > 0 ? `: ${drawn.join(" ")}` : ""}. This leaves them alone.`);

  if (updates.length === 0) {
    console.log("Nothing to do.");
    return 0;
  }
  mkdirSync(backup, { recursive: true });
  const file = join(backup, `${dryRun ? "dry-run" : "apply"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ project: options.projectId, documents: saved }, null, 2));
  console.log(`Old values saved to ${file}`);

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
