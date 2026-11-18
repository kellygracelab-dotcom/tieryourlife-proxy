/**
 * Fills the uploaded-photo slot (`facePhoto.ts`) of accounts from before it
 * existed. An upload's copy is `avatars/{uid}/{pictureId}` (a copy of another
 * picture is `w-…`, not an upload) and stayed in Storage when the letter or a
 * card replaced it as the face, so the slot takes the copy the account wears,
 * else its newest upload. A slot already set, or emptied by "Remove your
 * photo", is left alone. Nothing is deleted or changed but the slot.
 *
 * A dry run unless `--apply`.
 *
 *   npm run face-slots -- --project tieryourlife
 *
 * Runs on application default credentials.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { pointsAt, type PhotoSlot } from "../src/facePhoto";
import { addressOf } from "../src/publishedPictures";
import { isPictureId } from "../src/safety";
import { readBackfillOptions } from "./backfillOptions";

export interface AvatarFile {
  uid: string;
  pictureId: string;
  createdMs: number;
}

/** The uploads among `avatars/` file names, by account. */
export function uploadsByAccount(files: readonly { name: string; createdMs: number }[]): Map<string, AvatarFile[]> {
  const byUid = new Map<string, AvatarFile[]>();
  for (const file of files) {
    const [top, uid, pictureId, ...rest] = file.name.split("/");
    if (top !== "avatars" || !uid || rest.length > 0 || !isPictureId(pictureId) || pictureId.startsWith("w-")) continue;
    byUid.set(uid, [...(byUid.get(uid) ?? []), { uid, pictureId, createdMs: file.createdMs }]);
  }
  return byUid;
}

/** The upload the slot should hold: the one worn, else the newest. */
export function chooseUpload(uploads: readonly AvatarFile[], worn: string | null, bucket: string): AvatarFile | null {
  const wornOne = uploads.find((one) => pointsAt(worn, bucket, `avatars/${one.uid}/${one.pictureId}`));
  if (wornOne) return wornOne;
  return [...uploads].sort((a, b) => b.createdMs - a.createdMs || (a.pictureId < b.pictureId ? 1 : -1))[0] ?? null;
}

async function main(): Promise<number> {
  const options = readBackfillOptions(process.argv.slice(2));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  console.log(`Project ${options.projectId}. ${options.apply ? "APPLY: empty photo slots are filled." : "Dry run: nothing is written."}`);
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const bucket = getStorage().bucket();
  const db = getFirestore();
  const [files] = await bucket.getFiles({ prefix: "avatars/" });
  const byUid = uploadsByAccount(files.map((file) => ({ name: file.name, createdMs: Date.parse(String(file.metadata.timeCreated ?? "")) || 0 })));

  const counts = { accounts: byUid.size, filled: 0, worn: 0, newest: 0, alreadySet: 0, noAccount: 0 };
  for (const [uid, uploads] of byUid) {
    const ref = db.collection("accounts").doc(uid).collection("settings").doc("appearance");
    const doc = await ref.get();
    if (doc.exists && doc.get("photo") !== undefined) {
      counts.alreadySet++;
      continue;
    }
    let worn: string | null;
    try {
      worn = (await getAuth().getUser(uid)).photoURL ?? null;
    } catch {
      counts.noAccount++;
      continue;
    }
    const chosen = chooseUpload(uploads, worn, bucket.name)!;
    const isWorn = pointsAt(worn, bucket.name, `avatars/${uid}/${chosen.pictureId}`);
    counts[isWorn ? "worn" : "newest"]++;
    const slot: PhotoSlot = { pictureId: chosen.pictureId, url: addressOf(bucket.name, `avatars/${uid}/${chosen.pictureId}`), setAt: chosen.createdMs || Date.now() };
    console.log(`${uid}: ${uploads.length} upload(s), slot ${chosen.pictureId} (${isWorn ? "worn" : "newest, not worn"})`);
    if (options.apply) {
      // Only into an empty slot: an upload or a removal since the dry run wins.
      await db.runTransaction(async (transaction) => {
        const now = await transaction.get(ref);
        if (now.exists && now.get("photo") !== undefined) return;
        transaction.set(ref, { photo: slot }, { merge: true });
      });
      counts.filled++;
    }
  }
  console.log(JSON.stringify(counts));
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
