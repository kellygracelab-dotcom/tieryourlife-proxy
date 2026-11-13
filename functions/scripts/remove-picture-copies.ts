/**
 * Undoes the copies of one catalogue, of several, or of all of them, in one
 * command: switches them off in `config/pictureCopies`, shows each catalogue's
 * own address again (the card's `attribution.originalUrl`, or what the copy's
 * file says it was copied from) on every list card, cover and collage and in
 * every ranking snapshot, and deletes those copies once no list or ranking
 * shows them. Credits stay as they are. The old values of every document it
 * changes are saved first under `--backup`; a list's `revision` moves.
 * Pictures from other sites are not a catalogue's and are never undone here.
 *
 * A dry run unless `--apply`.
 *
 *   npm run remove-picture-copies -- --project tieryourlife --source tmdb
 *   npm run remove-picture-copies -- --project tieryourlife --source all --apply
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { COPY_SOURCES, PICTURE_COPIES } from "../src/pictureCopies";
import { copiesToUndo, pictureFields, readCopyMeta, shownPaths, shownPictures, withoutCopies, type CopyMeta } from "../src/pictureCopyUpkeep";
import { readBackfillOptions, Samples, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const DEFAULT_BACKUPS = "D:\\MyProjects\\TierYourLife\\backups";

/** The catalogues named by `--source`: a list of them, or `all`; null when it names none of them. */
export function readSources(raw: string | null): Set<string> | null {
  if (raw === null) return null;
  const named = raw.split(",").map((one) => one.trim()).filter(Boolean);
  if (named.includes("all")) return new Set(COPY_SOURCES);
  if (named.length === 0 || named.some((one) => !(COPY_SOURCES as readonly string[]).includes(one))) return null;
  return new Set(named);
}

function readArgs(argv: string[]): { rest: string[]; backup: string; source: string | null } {
  const rest: string[] = [];
  let backup = join(DEFAULT_BACKUPS, `picture-copies-${new Date().toISOString().slice(0, 10)}`);
  let source: string | null = null;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++at] ?? "";
    if (flag === "--backup") backup = value();
    else if (flag === "--source") source = value();
    else rest.push(argv[at]);
  }
  return { rest, backup, source };
}

async function main(): Promise<number> {
  const { rest, backup, source } = readArgs(process.argv.slice(2));
  const options = readBackfillOptions(rest);
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const sources = readSources(source);
  if (sources === null) {
    console.error(`Which catalogues? Pass --source with ${COPY_SOURCES.join(", ")} or all.`);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}, bucket ${options.bucket}. ${dryRun ? "Dry run: nothing is changed or deleted." : "APPLY: switched off, addresses given back, copies deleted."} Catalogues: ${[...sources].join(", ")}.`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();
  const bucket = getStorage().bucket();

  const [files] = await bucket.getFiles({ prefix: "published/" });
  const metas = new Map<string, CopyMeta>(files.map((file) => [file.name, readCopyMeta(file.metadata.metadata as Record<string, unknown> | undefined, file.metadata.timeCreated as string | undefined)]));
  const [lists, rankings] = await Promise.all([db.collection("publishedLists").get(), db.collection("rankings").get()]);
  const docs = [...lists.docs, ...rankings.docs];

  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const undone = new Set<string>();
  const samples = new Samples(40);
  let shown = 0;
  for (const doc of docs) {
    const ranking = doc.ref.parent.id === "rankings";
    const before = shownPictures(doc.data(), ranking);
    const originals = copiesToUndo(before, metas, sources);
    if (originals.size === 0) continue;
    const after = withoutCopies(before, originals);
    if (after === null) continue;
    const fields = pictureFields(before, after, ranking);
    if (Object.keys(fields).length === 0) continue;
    originals.forEach((_original, path) => undone.add(path));
    shown += originals.size;
    saved[doc.ref.path] = pictureFields(after, before, ranking);
    updates.push({ ref: doc.ref, fields, readAt: doc.updateTime, revise: !ranking });
    samples.add(`${doc.ref.path} ${String(doc.get("title") ?? doc.get("snapshot.title") ?? "").slice(0, 40)}: ${originals.size} copies back to the catalogue's address`);
  }
  const ofSources = files.filter((file) => sources.has(metas.get(file.name)?.source ?? "") || undone.has(file.name));
  const bySource = new Map<string, number>();
  for (const file of ofSources) {
    const name = metas.get(file.name)?.source ?? "(said by its card)";
    bySource.set(name, (bySource.get(name) ?? 0) + 1);
  }
  console.log(`${docs.length} lists and rankings; ${updates.length} show ${shown} copies of these catalogues; ${ofSources.length} copy files (${[...bySource].map(([name, n]) => `${name} ${n}`).join(", ") || "none"}).`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

  if (updates.length > 0) {
    mkdirSync(backup, { recursive: true });
    const file = join(backup, `${dryRun ? "dry-run" : "apply"}-${[...sources].join("-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ project: options.projectId, sources: [...sources], documents: saved, files: ofSources.map((one) => ({ name: one.name, ...metas.get(one.name) })) }, null, 2));
    console.log(`Old values of ${updates.length} documents saved to ${file}`);
  }
  if (dryRun) {
    console.log("Dry run: nothing was changed. Add --apply to do it.");
    return 0;
  }

  // Off first, so nothing copies them again meanwhile.
  await db.doc(PICTURE_COPIES).set({ sources: Object.fromEntries([...sources].map((one) => [one, false])) }, { merge: true });
  console.log(`Switched off in ${PICTURE_COPIES}: ${[...sources].join(", ")}.`);
  const { written, leftAlone } = await writeGuarded(db, updates, (line) => console.log(line));
  console.log(`${written} documents written, ${leftAlone} left alone (changed since they were read: run it again).`);

  const still = shownPaths(await Promise.all(docs.map((doc) => doc.ref.get())));
  let deleted = 0;
  let kept = 0;
  for (const file of ofSources) {
    if (still.has(file.name)) {
      kept++;
      continue;
    }
    await file.delete().then(() => deleted++, (error: unknown) => console.log(`  not deleted: ${file.name}: ${String(error)}`));
  }
  console.log(`Deleted ${deleted} copy files; ${kept} kept because a list or ranking still shows them (run it again).`);
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
