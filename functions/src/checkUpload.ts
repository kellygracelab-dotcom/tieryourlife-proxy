import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { HEAD_BYTES, judgeUpload, ownPictureOwner } from "./pictureBytes";
import { dayKey } from "./quota";

const UPLOAD_USAGE = "pictureUploads";

/**
 * The bucket lives in us-east1 and a Storage trigger has to sit beside it.
 * Works on the exact generation that landed, so a newer file under the same
 * name is never the one removed.
 */
export const checkUpload = onObjectFinalized(
  { region: "us-east1", memory: "256MiB", timeoutSeconds: 60 },
  async (event) => {
    const { name, bucket, generation } = event.data;
    const uid = ownPictureOwner(name);
    if (uid === null) return;

    const file = getStorage().bucket(bucket).file(name, { generation });
    const head = Number(event.data.size) > 0 ? (await file.download({ start: 0, end: HEAD_BYTES - 1 }))[0] : Buffer.alloc(0);

    const verdict = await judgeUpload(head, async () => {
      const usage = getFirestore().doc(`${UPLOAD_USAGE}/${dayKey(Date.now())}/uploads/${uid}`);
      await usage.set({ count: FieldValue.increment(1) }, { merge: true });
      return ((await usage.get()).get("count") as number | undefined) ?? 0;
    });
    if (verdict === "keep") return;

    await file.delete({ ignoreNotFound: true });
    console.warn(`Upload check: removed ${name} (${verdict})`);
  },
);
