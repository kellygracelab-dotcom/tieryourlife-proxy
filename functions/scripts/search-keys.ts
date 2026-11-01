/**
 * A one-off: lists and topics stored before search had words get the keys of
 * their own names, so they are found at once; the sweep (src/sweepSearch.ts)
 * then adds the other languages. Touches only documents without keys. A dry
 * run unless `--execute`.
 *
 *   npm run search-keys -- --project tieryourlife
 *   npm run search-keys -- --project tieryourlife --execute
 *
 * Runs on application default credentials.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { searchFieldsFor } from "../src/search";

const SOURCES = [
  { collection: "publishedLists", names: (data: FirebaseFirestore.DocumentData) => [String(data.title ?? "")] },
  {
    collection: "topics",
    names: (data: FirebaseFirestore.DocumentData) => [
      String(data.name ?? ""),
      ...Object.values((data.names ?? {}) as Record<string, unknown>).filter((one): one is string => typeof one === "string"),
    ],
  },
] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf("--project") + 1];
  if (!args.includes("--project") || !projectId) throw new Error("Which project? --project <id>");
  const execute = args.includes("--execute");
  const app = initializeApp({ credential: applicationDefault(), projectId }, "search-keys");
  const db = getFirestore(app);

  for (const source of SOURCES) {
    const all = await db.collection(source.collection).get();
    const missing = all.docs.filter((doc) => doc.get("searchKeys") === undefined);
    console.log(`${source.collection}: ${missing.length} of ${all.size} without keys`);
    for (const doc of missing) {
      const names = source.names(doc.data());
      console.log(`${execute ? "SET " : "WOULD SET"}  ${source.collection}/${doc.id}  ${names[0]}`);
      if (execute) await doc.ref.update(searchFieldsFor(names));
    }
  }
  console.log(execute ? "Done." : "Dry run: nothing was changed. Add --execute to set them.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
