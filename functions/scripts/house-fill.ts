/**
 * Fills the house lists out with more cards, each with a picture that is
 * surely that thing, after the cards already there. Two steps:
 *
 * Asking: each planned card (src/houseFill.ts, PlannedCard) is searched for
 * by the houseFill function, which holds the catalogue keys, and the hit
 * that is surely it is written to the found file; the ones without such a hit
 * are listed there with what came closest.
 *
 *   npm run house-fill -- --project tieryourlife --plan plan.json --found found.json
 *
 * Writing: the found cards go into their lists as the publish path stores a
 * replaced list, each write in the audit log. A dry run unless `--execute`.
 *
 *   npm run house-fill -- --project tieryourlife --found found.json
 *   npm run house-fill -- --project tieryourlife --found found.json --execute
 *
 * Runs on application default credentials.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { auditEntry } from "../src/audit";
import { EDITORIAL_UID } from "../src/editorial";
import { cardOf, extendList, HOUSE_FILL_JOBS, HOUSE_FILL_UID, MAX_JOB_QUERIES, pickHit, type PlannedCard } from "../src/houseFill";
import type { PictureHit } from "../src/pictureSources";
import type { PublishedItem } from "../src/publishing";

const ANSWER_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 5_000;
/** AniList answers thirty requests a minute. */
const SPACING_MS: Partial<Record<string, number>> = { anime: 2_000 };

interface Found {
  id: string;
  cards: PublishedItem[];
  missed: { title: string; typed: string; near: string[] }[];
}

function argument(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1]! : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = argument(args, "--project");
  const foundFile = argument(args, "--found");
  if (!projectId) throw new Error("Which project? --project <id>");
  if (!foundFile) throw new Error("Which found file? --found <path>");
  const app = initializeApp({ credential: applicationDefault(), projectId }, "house-fill");
  const db = getFirestore(app);
  const planFile = argument(args, "--plan");
  if (planFile) {
    await ask(db, JSON.parse(readFileSync(planFile, "utf-8")) as { id: string; cards: PlannedCard[] }[], foundFile);
  } else {
    await write(db, JSON.parse(readFileSync(foundFile, "utf-8")) as Found[], args.includes("--execute"));
  }
}

async function ask(db: Firestore, plan: { id: string; cards: PlannedCard[] }[], foundFile: string): Promise<void> {
  const found: Found[] = [];
  for (const list of plan) {
    const entry: Found = { id: list.id, cards: [], missed: [] };
    for (let start = 0; start < list.cards.length; start += MAX_JOB_QUERIES) {
      const cards = list.cards.slice(start, start + MAX_JOB_QUERIES);
      const answers = await answered(db, cards);
      cards.forEach((card, index) => {
        const hits = (answers[index]?.hits ?? []) as PictureHit[];
        const hit = pickHit(card, hits);
        if (hit) {
          entry.cards.push(cardOf(card.title, hit));
          console.log(`  found   ${card.title}  <-  ${hit.title} (${hit.subtitle ?? ""}) ${hit.imageUrl}`);
        } else {
          const near = hits.slice(0, 4).map((one) => `${one.kind}: ${one.title} (${one.subtitle ?? ""})`);
          entry.missed.push({ title: card.title, typed: card.typed ?? card.title, near });
          console.log(`  MISSED  ${card.title}${answers[index]?.ok === false ? " (no catalogue answered)" : ""}  near: ${near.join(" | ")}`);
        }
      });
    }
    console.log(`${list.id}: ${entry.cards.length} found, ${entry.missed.length} missed`);
    found.push(entry);
  }
  writeFileSync(foundFile, JSON.stringify(found, null, 2));
}

async function answered(db: Firestore, cards: PlannedCard[]): Promise<{ ok: boolean; hits: unknown[] }[]> {
  const queries = cards.map((card) => ({ typed: card.typed ?? card.title, scope: card.scope, ...(card.exact ? { exact: true } : {}) }));
  const ref = await db.collection(HOUSE_FILL_JOBS).add({
    queries,
    spacingMs: Math.max(0, ...queries.map((query) => SPACING_MS[query.scope] ?? 0)),
    createdBy: HOUSE_FILL_UID,
    createdAt: FieldValue.serverTimestamp(),
  });
  const until = Date.now() + ANSWER_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const answers = (await ref.get()).get("answers");
    if (Array.isArray(answers) && answers.length !== cards.length) throw new Error(`${HOUSE_FILL_JOBS}/${ref.id}: answers do not line up with the cards`);
    if (Array.isArray(answers)) return answers;
  }
  throw new Error(`${HOUSE_FILL_JOBS}/${ref.id} was not answered in time`);
}

async function write(db: Firestore, found: Found[], execute: boolean): Promise<void> {
  for (const entry of found) {
    const ref = db.collection("publishedLists").doc(entry.id);
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(ref);
      if (!doc.exists || doc.get("authorUid") !== EDITORIAL_UID) return "not a house list";
      const list = doc.data() as { title: string; category: string; tiers: unknown[]; items: PublishedItem[]; previewImages?: string[] };
      const extension = extendList(list, entry.cards);
      if (!extension.ok) return `refused: ${extension.detail}`;
      const before = list.items.length;
      if (execute && extension.added.length > 0) {
        transaction.update(ref, { ...extension.fields, updatedAt: FieldValue.serverTimestamp(), underReview: false, reviewed: false });
        transaction.set(db.collection("auditLog").doc(), {
          ...auditEntry(HOUSE_FILL_UID, "owner", "list.editorial_edit", `publishedLists/${entry.id}`, { itemCount: before }, {
            title: list.title,
            category: list.category,
            itemCount: extension.fields.itemCount,
          }),
          at: FieldValue.serverTimestamp(),
        });
      }
      const skipped = extension.duplicates.length > 0 ? `; already shown: ${extension.duplicates.join(", ")}` : "";
      return `${execute ? "SET" : "WOULD SET"} ${list.title}: ${before} -> ${extension.fields.itemCount} cards${skipped}`;
    });
    console.log(`${entry.id}  ${result}`);
  }
  console.log(execute ? "Done." : "Dry run: nothing was changed. Add --execute to write them.");
  // Cards written here keep their catalogue addresses: the copies we may keep are made by the backfill.
  if (execute) console.log(`Now copy the pictures we may keep: npm run catalogue-pictures -- --project <project> --list ${found.map((entry) => entry.id).join(",")} --apply`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
