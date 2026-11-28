import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { handlePictureWarm, PICTURE_WARM_JOBS } from "./pictureWarm";

/**
 * A list's small copies asked of the site after its publication or Update (src/pictureWarm.ts). Written
 * only by the lists function with the Admin SDK; the rules let no client write a job. One try, no retry
 * policy: a copy not made now is made on its first view.
 */
export const warmPictures = onDocumentCreated(
  {
    document: `${PICTURE_WARM_JOBS}/{id}`,
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "256MiB",
    // Two lists at once at most, three pictures each: six asks of the site's function together.
    maxInstances: 2,
    concurrency: 1,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await handlePictureWarm(snapshot.ref);
  },
);
