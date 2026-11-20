import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { decideSweep, picturesOfBoard, type StoredPicture } from "./pictures";
import { RETIRED_AT, retiredAtOf } from "./publishedPictures";
import { MAX_BOARDS_PER_ACCOUNT } from "./sync";
import { sweepRemovedPhotos } from "./facePhoto";

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

    const totals = { retired: 0, unretired: 0, removed: 0, keptAtLimit: 0 };
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
      const one = await sweepAccount(bucket, db, uid, nowMs);
      totals.retired += one.retired;
      totals.unretired += one.unretired;
      totals.removed += one.removed;
      totals.keptAtLimit += one.keptAtLimit;
    }

    // Face photos removed with "Remove your photo" whose Undo window is over (`facePhoto.ts`).
    const removedFaces = await sweepRemovedPhotos(nowMs).catch((error) => {
      console.warn("Removed face photos not swept", error);
      return 0;
    });

    console.log(`Picture sweep: ${totals.removed} unclaimed pictures removed, ${totals.retired} marked, ${totals.unretired} named again, ${totals.keptAtLimit} kept for accounts at the board limit, across ${accounts} accounts; ${removedFaces} removed face photos`);
  },
);

interface AccountSweep {
  retired: number;
  unretired: number;
  removed: number;
  keptAtLimit: number;
}

async function sweepAccount(
  bucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>,
  db: FirebaseFirestore.Firestore,
  uid: string,
  nowMs: number,
): Promise<AccountSweep> {
  const done: AccountSweep = { retired: 0, unretired: 0, removed: 0, keptAtLimit: 0 };
  const prefix = `users/${uid}/pictures/`;
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) {
    return done;
  }

  const boards = await db.collection("accounts").doc(uid).collection("boards").get();
  const referenced = new Set<string>();
  let live = 0;
  boards.forEach((board) => {
    if (board.get("deleted") !== true) live++;
    picturesOfBoard(board.data(), uid).forEach((id) => referenced.add(id));
  });
  // Every board the account may keep is kept, so any further ones live only on its devices (20.11.2026).
  const atLimit = live >= MAX_BOARDS_PER_ACCOUNT;

  const stored: StoredPicture[] = files.map((file) => ({
    id: file.name.slice(prefix.length),
    uploadedAtMs: Date.parse(file.metadata.timeCreated ?? "") || nowMs,
    retiredAtMs: retiredAtOf((file.metadata.metadata ?? null) as Record<string, unknown> | null),
  }));
  const decision = decideSweep(stored, referenced, nowMs, atLimit);
  if (atLimit) done.keptAtLimit = stored.filter((picture) => picture.retiredAtMs !== null && !referenced.has(picture.id)).length;

  const byId = new Map(files.map((file) => [file.name.slice(prefix.length), file]));
  const mark = (id: string, value: string | null) =>
    Promise.resolve()
      .then(() => byId.get(id)!.setMetadata({ metadata: { [RETIRED_AT]: value } }))
      .then(() => true, (error) => (console.warn(`Could not mark ${prefix}${id}`, error), false));
  await Promise.all([
    ...decision.retire.map((id) => mark(id, String(nowMs)).then((ok) => ok && done.retired++)),
    ...decision.unretire.map((id) => mark(id, null).then((ok) => ok && done.unretired++)),
    ...decision.remove.map((id) =>
      byId.get(id)!.delete().then(() => done.removed++, (error) => console.warn(`Could not delete ${prefix}${id}`, error)),
    ),
  ]);
  return done;
}
