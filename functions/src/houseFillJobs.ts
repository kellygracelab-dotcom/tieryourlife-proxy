import { FieldValue } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { secretsOutsideDemo } from "./emulator";
import { HITS_KEPT, HOUSE_FILL_JOBS, HOUSE_FILL_UID, readJob } from "./houseFill";
import { igdbClientId, igdbClientSecret, igdbNamed, pictureTmdbToken, searchPictures } from "./pictureSearch";

/**
 * The house lists' picture searches, run where the catalogue keys are bound:
 * scripts/house-fill.ts writes a job, this answers each search with what the
 * app's own picture search finds. Nothing calls it but a document written
 * with the Admin SDK, since the rules let no client write one.
 */
export const houseFill = onDocumentCreated(
  {
    document: `${HOUSE_FILL_JOBS}/{id}`,
    region: "europe-west1",
    secrets: secretsOutsideDemo([pictureTmdbToken, igdbClientId, igdbClientSecret]),
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const { queries, spacingMs } = readJob(snapshot.data());
    const answers: { ok: boolean; hits: unknown[] }[] = [];
    for (const query of queries) {
      if (query === null) {
        answers.push({ ok: false, hits: [] });
        continue;
      }
      const answer = query.exact
        ? await igdbNamed(query.typed).then((items) => ({ items }), () => null)
        : await searchPictures({ typed: query.typed, scope: query.scope, language: "en", page: 1, forcedWeb: false, quick: false, uid: HOUSE_FILL_UID }).catch(() => null);
      // Through JSON, so a field a hit leaves undefined is not refused by Firestore.
      answers.push({ ok: answer !== null, hits: JSON.parse(JSON.stringify(answer?.items.slice(0, HITS_KEPT) ?? [])) });
      if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
    await snapshot.ref.update({ answers, answeredAt: FieldValue.serverTimestamp() });
  },
);
