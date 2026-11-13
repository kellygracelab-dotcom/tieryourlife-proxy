/**
 * Faces still shown from a Google account (lh3.googleusercontent.com), copied
 * into the person's own `avatars/{uid}/` as publishing and ranking now do
 * (`checkedFace`), and the documents pointed at the copy: a list's
 * `authorPhotoUrl`, a ranking's `authorPhotoUrl` (the ranker's) and its
 * snapshot's (the list author's). The old values are saved first under
 * `--backup`; a list's `revision` moves. A face that cannot be copied now stays
 * as it is; one refused is left for staff, never removed here.
 *
 * A dry run unless `--apply`.
 *
 *   npm run copy-account-faces -- --project tieryourlife
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { checkedFace, realOutsideTools } from "../src/outsidePictures";
import { readBackfillOptions, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const DEFAULT_BACKUPS = "D:\MyProjects\TierYourLife\backups";

/** Whether [url] is a picture Google keeps for an account, not one of ours. */
export function onGoogle(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).hostname === "lh3.googleusercontent.com";
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((one) => one === "--backup" || one.startsWith("--backup="));
  const backup = at < 0 ? join(DEFAULT_BACKUPS, `account-faces-${new Date().toISOString().slice(0, 10)}`) : argv[at]!.includes("=") ? argv[at]!.split("=")[1]! : argv[at + 1]!;
  const options = readBackfillOptions(argv.filter((_one, index) => at < 0 || (index !== at && (argv[at]!.includes("=") || index !== at + 1))));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}. ${dryRun ? "Dry run: nothing is copied or changed." : "APPLY: Google faces copied into avatars/ and pointed at."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();
  const [lists, rankings] = await Promise.all([db.collection("publishedLists").get(), db.collection("rankings").get()]);
  const authorOf = new Map(lists.docs.map((doc) => [doc.id, String(doc.get("authorUid") ?? "")]));

  // Every face on Google: where it is, whose it is.
  const found: { doc: FirebaseFirestore.QueryDocumentSnapshot; field: string; uid: string; url: string; list: boolean }[] = [];
  for (const doc of lists.docs) {
    if (onGoogle(doc.get("authorPhotoUrl"))) found.push({ doc, field: "authorPhotoUrl", uid: authorOf.get(doc.id)!, url: doc.get("authorPhotoUrl"), list: true });
  }
  for (const doc of rankings.docs) {
    const ranker = String(doc.get("uid") ?? doc.id.split("_")[1] ?? "");
    if (onGoogle(doc.get("authorPhotoUrl"))) found.push({ doc, field: "authorPhotoUrl", uid: ranker, url: doc.get("authorPhotoUrl"), list: false });
    if (onGoogle(doc.get("snapshot.authorPhotoUrl"))) found.push({ doc, field: "snapshot.authorPhotoUrl", uid: authorOf.get(String(doc.get("listId"))) ?? "", url: doc.get("snapshot.authorPhotoUrl"), list: false });
  }
  console.log(`${lists.size} lists, ${rankings.size} rankings: ${found.length} faces on Google.`);

  const updates = new Map<string, GuardedUpdate>();
  const saved: Record<string, Record<string, unknown>> = {};
  let copied = 0;
  for (const one of found) {
    if (!one.uid) {
      console.log(`  ${one.doc.ref.path} ${one.field}: whose face is unknown, left as it is`);
      continue;
    }
    const copy = dryRun ? null : await checkedFace(one.uid, one.url, realOutsideTools(one.uid));
    console.log(`  ${one.doc.ref.path} ${one.field} (${one.uid.slice(0, 6)}...): ${dryRun ? "to copy" : copy === null ? "refused: left as it is" : copy === one.url ? "not copied now: left as it is" : "copied"}`);
    if (dryRun || copy === null || copy === one.url) continue;
    copied++;
    const update = updates.get(one.doc.ref.path) ?? { ref: one.doc.ref, fields: {}, readAt: one.doc.updateTime, revise: one.list };
    update.fields[one.field] = copy;
    updates.set(one.doc.ref.path, update);
    (saved[one.doc.ref.path] ??= {})[one.field] = one.url;
  }
  mkdirSync(backup, { recursive: true });
  const file = join(backup, `${dryRun ? "dry-run" : "apply"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ project: options.projectId, found: found.map((one) => ({ path: one.doc.ref.path, field: one.field, url: one.url })), documents: saved }, null, 2));
  console.log(`Saved to ${file}`);
  if (dryRun) {
    console.log("Dry run: nothing was changed. Add --apply to do it.");
    return 0;
  }
  const { written, leftAlone } = await writeGuarded(db, [...updates.values()], (line) => console.log(line));
  console.log(`${copied} faces copied; ${written} documents written, ${leftAlone} left alone (changed since they were read: run it again).`);
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
