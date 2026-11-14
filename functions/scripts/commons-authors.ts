/**
 * Commons authors written with addresses in them ("Name (https://…)", or an
 * address alone, as frames from YouTube videos credit their channel), made
 * plain names by the rule publication now follows (`authorName` in
 * `pictureCredit.ts`): on published lists' cards, ranking snapshots and added
 * cards, and boards kept in accounts (in place: a board's revision and
 * fingerprint never move, and a board that would no longer fit is left as it
 * is). Only `attribution.author` changes; the licence and the file's page
 * stay. An editor's own credit (`manual: true`) is theirs and never touched.
 * The old values are saved first under `--backup`; a list's `revision` moves.
 *
 * A dry run unless `--apply`.
 *
 *   npm run commons-authors -- --project tieryourlife
 *
 * Runs on application default credentials.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { fitsWithCopies } from "../src/boardPictures";
import { authorName } from "../src/pictureCredit";
import { readBackfillOptions, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const DEFAULT_BACKUPS = "D:/MyProjects/TierYourLife/backups";

export interface AuthorChange {
  index: number;
  title: string;
  before: string;
  after: string;
}

/** [items] with each Commons author made a plain name, and what changed; the same array when nothing did. */
export function withPlainAuthors(items: readonly unknown[]): { items: unknown[]; changes: AuthorChange[] } {
  const changes: AuthorChange[] = [];
  const next = items.map((raw, index) => {
    const card = (raw ?? {}) as { title?: unknown; attribution?: Record<string, unknown> };
    const credit = card.attribution;
    if (!credit || credit.source !== "wikimedia" || credit.manual === true || typeof credit.author !== "string") return raw;
    const after = authorName(credit.author);
    if (after === credit.author) return raw;
    changes.push({ index, title: String(card.title ?? ""), before: credit.author, after });
    const { author: _old, ...rest } = credit;
    return { ...card, attribution: after === "" ? rest : { ...rest, author: after } };
  });
  return { items: changes.length > 0 ? next : [...items], changes };
}

function readArgs(argv: string[]): { rest: string[]; backup: string } {
  const rest: string[] = [];
  let backup = `${DEFAULT_BACKUPS}/commons-authors-${new Date().toISOString().slice(0, 10)}`;
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
  console.log(`Project ${options.projectId}. ${dryRun ? "Dry run: nothing is changed." : "APPLY: Commons authors made plain names."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId });
  const db = getFirestore();
  const [lists, rankings, boards] = await Promise.all([db.collection("publishedLists").get(), db.collection("rankings").get(), db.collectionGroup("boards").get()]);
  const live = boards.docs.filter((doc) => doc.get("deleted") !== true);
  console.log(`${lists.size} lists, ${rankings.size} rankings, ${live.length} boards kept.`);

  type Kind = "list" | "ranking" | "board";
  const updates: GuardedUpdate[] = [];
  const saved: Record<string, Record<string, unknown>> = {};
  const totals: Record<Kind, { docs: number; cards: number; tooLarge: number }> = { list: { docs: 0, cards: 0, tooLarge: 0 }, ranking: { docs: 0, cards: 0, tooLarge: 0 }, board: { docs: 0, cards: 0, tooLarge: 0 } };
  const visit = (doc: FirebaseFirestore.QueryDocumentSnapshot, kind: Kind, named: [string, unknown][]) => {
    const fields: Record<string, unknown> = {};
    const old: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const [field, raw] of named) {
      if (!Array.isArray(raw)) continue;
      const { items, changes } = withPlainAuthors(raw);
      if (changes.length === 0) continue;
      fields[field] = items;
      old[field] = raw;
      for (const one of changes) lines.push(`    ${field}[${one.index}] ${one.title.slice(0, 40)}: ${JSON.stringify(one.before)} -> ${JSON.stringify(one.after)}`);
    }
    if (lines.length === 0) return;
    const fits = kind !== "board" || fitsWithCopies({ ...doc.data(), ...fields });
    const name = kind === "board" ? `${doc.ref.parent.parent?.id.slice(0, 6)}…/boards/${doc.id}` : doc.ref.path;
    const title = String(doc.get(kind === "ranking" ? "snapshot.title" : "title") ?? "").slice(0, 40);
    console.log(`  ${name} "${title}": ${lines.length} authors${fits ? "" : "; too large with them: left as it is"}`);
    lines.forEach((line) => console.log(line));
    if (!fits) {
      totals[kind].tooLarge++;
      return;
    }
    totals[kind].docs++;
    totals[kind].cards += lines.length;
    saved[doc.ref.path] = old;
    updates.push({ ref: doc.ref, fields, readAt: doc.updateTime, revise: kind === "list" });
  };
  lists.docs.forEach((doc) => visit(doc, "list", [["items", doc.get("items")]]));
  rankings.docs.forEach((doc) => visit(doc, "ranking", [["snapshot.items", doc.get("snapshot.items")], ["addedCards", doc.get("addedCards")]]));
  live.forEach((doc) => visit(doc, "board", [["items", doc.get("items")]]));
  for (const [kind, label] of [["list", "publishedLists"], ["ranking", "rankings"], ["board", "boards"]] as const) {
    const total = totals[kind];
    console.log(`${label}: ${total.docs} documents, ${total.cards} authors${total.tooLarge > 0 ? `; ${total.tooLarge} boards too large` : ""}.`);
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
