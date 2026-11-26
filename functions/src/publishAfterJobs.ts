import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { listNamesNow, syncCredits } from "./community";
import { revisionOf } from "./listRevision";
import { handlePublishAfter, PUBLISH_AFTER_JOBS } from "./publishAfter";
import { retireUnusedPublished } from "./publishedPictures";

/**
 * An Update's credits and retiring, after its answer (src/publishAfter.ts). Written only by the lists
 * function with the Admin SDK; the rules let no client write a job. Retried on failure, three tries.
 */
export const publishAfter = onDocumentCreated(
  {
    document: `${PUBLISH_AFTER_JOBS}/{id}`,
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retry: true,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await handlePublishAfter(snapshot.ref, {
      async readList(listId) {
        const doc = await getFirestore().collection("publishedLists").doc(listId).get();
        return doc.exists ? { revision: revisionOf(doc.data()), names: listNamesNow(listId, doc.data() ?? {}) } : null;
      },
      syncCredits,
      retire: (listId, keeping, candidates) => retireUnusedPublished(listId, keeping, candidates),
    });
  },
);
