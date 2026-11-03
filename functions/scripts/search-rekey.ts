/**
 * A one-off after search learned words from the middle of kana, Han and
 * Hangul, and kept the voicing marks of kana: every list and topic gets the
 * keys of the names it stores, on top of the keys it has. The house lists,
 * and whatever was swept while the marks were dropped, go back to the sweep
 * (src/sweepSearch.ts), which builds their keys again from scratch. A dry run
 * unless `--execute`.
 *
 *   npm run search-rekey -- --project tieryourlife
 *   npm run search-rekey -- --project tieryourlife --execute
 *
 * Runs on application default credentials.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { EDITORIAL_UID, titleNames } from "../src/editorial";
import { MAX_KEYS, SEARCH_WORDS_ONLY, searchKeysFor } from "../src/search";

/** Kana and Hangul: the keys the old folding may have stripped or split. */
const REFOLDED = /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

const SOURCES = [
  {
    collection: "publishedLists",
    names: (data: FirebaseFirestore.DocumentData) => {
      const title = String(data.title ?? "");
      return [title, ...Object.values(titleNames(title, data.translations))];
    },
  },
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
  const app = initializeApp({ credential: applicationDefault(), projectId }, "search-rekey");
  const db = getFirestore(app);

  for (const source of SOURCES) {
    const all = await db.collection(source.collection).get();
    let rekeyed = 0;
    let resweep = 0;
    let failed = 0;
    for (const doc of all.docs) {
      const data = doc.data();
      const held = Array.isArray(data.searchKeys) ? (data.searchKeys as unknown[]).filter((key): key is string => typeof key === "string") : [];
      const keys = [...new Set([...searchKeysFor(source.names(data)), ...held])].slice(0, MAX_KEYS);
      const house = data.authorUid === EDITORIAL_UID;
      const swept = data.searchVersion !== SEARCH_WORDS_ONLY && held.some((key) => REFOLDED.test(key));
      const sweep = (house || swept) && data.searchVersion !== SEARCH_WORDS_ONLY;
      const added = keys.length - held.length;
      if (added === 0 && !sweep) continue;
      rekeyed += added > 0 ? 1 : 0;
      resweep += sweep ? 1 : 0;
      console.log(`${execute ? "SET " : "WOULD SET"}  ${source.collection}/${doc.id}  +${added} keys${sweep ? ", to the sweep" : ""}  ${source.names(data)[0]}`);
      if (!execute) continue;
      await doc.ref
        .update({ searchKeys: keys, ...(sweep ? { searchVersion: SEARCH_WORDS_ONLY } : {}) }, { lastUpdateTime: doc.updateTime })
        .catch((error: unknown) => {
          failed++;
          console.error(`  changed meanwhile, left alone: ${String(error)}`);
        });
    }
    console.log(`${source.collection}: ${all.size} in all, ${rekeyed} gain keys, ${resweep} go to the sweep${execute ? `, ${failed} left alone` : ""}`);
  }
  console.log(execute ? "Done." : "Dry run: nothing was changed. Add --execute to set them.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
