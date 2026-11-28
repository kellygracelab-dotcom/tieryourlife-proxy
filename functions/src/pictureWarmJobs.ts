import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { collageUrlOf, webPicture } from "./community";
import { handlePictureWarm, PICTURE_WARM_JOBS, warmPictures as askSite, type PictureWarmWork } from "./pictureWarm";

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
    // Two lists at once at most, three asks each: six asks of the site's function together.
    maxInstances: 2,
    concurrency: 1,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await handlePictureWarm(snapshot.ref, pictureWarmWork);
  },
);

/** The collage as the feed card names it (community.ts `collageOf`), read when the job runs. */
export const pictureWarmWork: PictureWarmWork = {
  async collageOf(listId) {
    const list = await getFirestore().collection("publishedLists").doc(listId).get();
    if (!list.exists) return null;
    const previews = ((list.get("previewImages") as unknown[] | undefined) ?? []).filter((one) => webPicture(one) !== null) as string[];
    const updatedAt = list.get("updatedAt") as { toMillis(): number } | undefined;
    return collageUrlOf(listId, webPicture(list.get("coverImageUrl")), previews, updatedAt?.toMillis() ?? 0);
  },
  warm: (addresses) => askSite(addresses),
};
