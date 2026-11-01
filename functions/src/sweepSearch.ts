import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { parseTranslations, searchKeysFor, SEARCH_TRANSLATED, translationPrompt } from "./search";

const geminiApiKey = defineSecret("GEMINI_API_KEY");

/** Config rather than code, so a retired model is a deploy of the same build. */
const MODEL = process.env.SEARCH_MODEL ?? "gemini-3.5-flash-lite";
const BATCH = 20;
const PER_RUN = 100;

/** Where the names live, and the field each one's own name is in. */
const SOURCES = [
  { collection: "publishedLists", name: "title" },
  { collection: "topics", name: "name" },
] as const;

/**
 * Adds every language to the search keys of what was published or proposed
 * since the last run: "звёздные войны" finds Star Wars. A name keeps the keys
 * of its own words meanwhile, so a new list is found at once in the language
 * it was written in. What fails is tried again next run.
 */
export const sweepSearch = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Etc/UTC",
    region: "europe-west1",
    secrets: [geminiApiKey],
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const db = getFirestore();
    let done = 0;
    for (const source of SOURCES) {
      const waiting = await db.collection(source.collection).where("searchVersion", "<", SEARCH_TRANSLATED).limit(PER_RUN).get();
      for (let start = 0; start < waiting.docs.length; start += BATCH) {
        const docs = waiting.docs.slice(start, start + BATCH);
        const names = docs.map((doc) => String(doc.get(source.name) ?? ""));
        const translated = await translate(names);
        if (translated === null) continue;
        await Promise.all(
          docs.map(async (doc, at) => {
            const own = Object.values((doc.get("names") as Record<string, unknown> | undefined) ?? {}).filter((one): one is string => typeof one === "string");
            const keys = searchKeysFor([names[at], ...own, ...translated[at]]);
            // Only if nobody renamed it meanwhile: a rename starts the keys again.
            await doc.ref
              .update({ searchKeys: keys, searchVersion: SEARCH_TRANSLATED }, { lastUpdateTime: doc.updateTime })
              .then(() => done++)
              .catch(() => undefined);
          }),
        );
      }
    }
    // Picture search answers are kept three days (src/pictureSearch.ts); older ones only take room.
    const stale = await db.collection("pictureCache").where("at", "<", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)).limit(400).get();
    if (!stale.empty) {
      const batch = db.batch();
      stale.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`Search sweep: translated ${done}, dropped ${stale.size} old picture answers`);
  },
);

async function translate(names: readonly string[]): Promise<string[][] | null> {
  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey.value() },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: translationPrompt(names) }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    if (!upstream.ok) {
      console.error("Search translation refused", upstream.status, await upstream.text());
      return null;
    }
    const body = (await upstream.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const parsed = parseTranslations(text, names.length);
    if (parsed === null) console.error("Search translation was not the shape asked for", text.slice(0, 500));
    return parsed;
  } catch (error) {
    console.error("Search translation failed", error);
    return null;
  }
}
