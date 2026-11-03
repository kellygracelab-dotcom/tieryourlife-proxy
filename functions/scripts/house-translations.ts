/**
 * Writes the house lists' translations from a file shaped
 * `[{ id, translations: { locale: { source: text } } }]`, under the rules of
 * PUT /lists/editorial/:id/translations: checked the same way, search keys
 * rebuilt, every write in the audit log. A dry run unless `--execute`.
 *
 *   npm run house-translations -- --project tieryourlife --file ../../house-lists-translations.json
 *   npm run house-translations -- --project tieryourlife --file ../../house-lists-translations.json --execute
 *
 * Runs on application default credentials.
 */
import { readFileSync } from "node:fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { auditEntry } from "../src/audit";
import { decideTranslations, EDITORIAL_UID, searchAfterTranslations, titleNames, translatableStrings } from "../src/editorial";

const SCRIPT_UID = "script:house-translations";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf("--project") + 1];
  const file = args[args.indexOf("--file") + 1];
  if (!args.includes("--project") || !projectId) throw new Error("Which project? --project <id>");
  if (!args.includes("--file") || !file) throw new Error("Which file? --file <path>");
  const execute = args.includes("--execute");
  const entries = JSON.parse(readFileSync(file, "utf-8")) as { id: string; translations: unknown }[];
  const app = initializeApp({ credential: applicationDefault(), projectId }, "house-translations");
  const db = getFirestore(app);

  for (const entry of entries) {
    const ref = db.collection("publishedLists").doc(entry.id);
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(ref);
      if (!doc.exists || doc.get("authorUid") !== EDITORIAL_UID) return "not a house list";
      const { translations: _old, ...list } = doc.data() as Parameters<typeof translatableStrings>[0] & { title: string; translations?: unknown };
      const decision = decideTranslations({
        raw: entry.translations,
        strings: translatableStrings(list),
        listBytes: Buffer.byteLength(JSON.stringify(list)),
      });
      if (!decision.ok) return `refused ${decision.status} ${decision.detail}`;
      const counts = Object.fromEntries(Object.entries(decision.translations).map(([locale, kept]) => [locale, Object.keys(kept).length]));
      if (execute) {
        transaction.update(ref, {
          translations: decision.translations,
          ...searchAfterTranslations(list.title, titleNames(list.title, decision.translations)),
        });
        transaction.set(db.collection("auditLog").doc(), {
          ...auditEntry(SCRIPT_UID, "owner", "list.editorial_translate", `publishedLists/${entry.id}`, null, { title: list.title, entries: counts, dropped: decision.dropped }),
          at: FieldValue.serverTimestamp(),
        });
      }
      return `${execute ? "SET" : "WOULD SET"} ${list.title}: ${JSON.stringify(counts)}, dropped ${decision.dropped}`;
    });
    console.log(`${entry.id}  ${result}`);
  }
  console.log(execute ? "Done." : "Dry run: nothing was changed. Add --execute to write them.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
