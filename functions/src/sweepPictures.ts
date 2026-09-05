import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { decideDiscard, type StoredPicture } from "./pictures";

/**
 * Storage knows nothing about boards, so nothing else deletes these; without
 * this the pictures of every removed card stay forever and the bill grows.
 */
export const sweepPictures = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Etc/UTC",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const nowMs = Date.now();
    const db = getFirestore();
    const bucket = getStorage().bucket();

    let discarded = 0;
    let accounts = 0;

    // Driven by who has boards rather than who has files: an account with no
    // boards has nothing to compare against, and a failed read is no reason to delete.
    const owners = await db.collectionGroup("boards").select().get();
    const uids = new Set(
      owners.docs
        .map((doc) => doc.ref.parent.parent?.id)
        .filter((uid): uid is string => typeof uid === "string"),
    );

    for (const uid of uids) {
      accounts++;
      discarded += await sweepAccount(bucket, db, uid, nowMs);
    }

    console.log(`Picture sweep: discarded ${discarded} unclaimed pictures across ${accounts} accounts`);
  },
);

async function sweepAccount(
  bucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>,
  db: FirebaseFirestore.Firestore,
  uid: string,
  nowMs: number,
): Promise<number> {
  const prefix = `users/${uid}/pictures/`;
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) {
    return 0;
  }

  const boards = await db.collection("accounts").doc(uid).collection("boards").get();
  const referenced = new Set<string>();
  boards.forEach((board) => {
    const items = (board.data().items ?? []) as { pictureId?: string | null }[];
    items.forEach((item) => {
      if (item.pictureId) referenced.add(item.pictureId);
    });
  });

  const stored: StoredPicture[] = files.map((file) => ({
    id: file.name.slice(prefix.length),
    uploadedAtMs: Date.parse(file.metadata.timeCreated ?? "") || nowMs,
  }));

  const doomed = new Set(decideDiscard(stored, referenced, nowMs));
  if (doomed.size === 0) {
    return 0;
  }

  await Promise.all(
    files
      .filter((file) => doomed.has(file.name.slice(prefix.length)))
      .map((file) => file.delete().catch((error) => console.warn(`Could not delete ${file.name}`, error))),
  );
  return doomed.size;
}
