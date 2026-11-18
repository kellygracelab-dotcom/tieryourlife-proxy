/**
 * The photo a person uploaded for their face, kept as one slot with the account
 * (Danylo, 19.11.2026: choosing the letter wiped an uploaded face for good;
 * `qa-results/design-audit-2026-11-16/FACE-PHOTO-2026-11-19.md`). The face worn
 * is still the account's `photoURL`; the slot is what "Your photo" puts back,
 * whatever is worn meanwhile. Only a new upload or "Remove your photo" changes
 * it, and the photo it held then goes from every list and ranking still
 * showing it, from the account's face, and from Storage.
 *
 * Kept beside the colour in `accounts/{uid}/settings/appearance` as `photo`.
 */
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { isPictureId } from "./safety";
import { storageMediaUrl } from "./publicMedia";

export interface PhotoSlot {
  /** The upload's id: the copy is `avatars/{uid}/{pictureId}`. */
  pictureId: string;
  /** The copy's address, the one a client puts on the account as its face. */
  url: string;
  /** When it was uploaded, the server's ms. */
  setAt: number;
}

const BATCH_LIMIT = 400;
/** Firestore's most values for one `in`. */
const IN_LIMIT = 30;

export const photoPathOf = (uid: string, pictureId: string): string => `avatars/${uid}/${pictureId}`;

const appearanceOf = (uid: string) => getFirestore().collection("accounts").doc(uid).collection("settings").doc("appearance");

/** A slot as stored, or null for none or a broken one. */
export function readPhotoSlot(value: unknown): PhotoSlot | null {
  if (typeof value !== "object" || value === null) return null;
  const slot = value as Record<string, unknown>;
  if (!isPictureId(slot.pictureId) || typeof slot.url !== "string" || typeof slot.setAt !== "number") return null;
  return { pictureId: slot.pictureId, url: slot.url, setAt: slot.setAt };
}

/** Whether [url] is the Storage address of [path] in [bucket], whatever its token and query. */
export function pointsAt(url: unknown, bucket: string, path: string): boolean {
  if (typeof url !== "string") return false;
  const prefix = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}`;
  const normal = storageMediaUrl(url);
  return normal === prefix || normal.startsWith(`${prefix}?`) || normal.startsWith(`${prefix}#`);
}

/** Puts a new upload in the slot; the photo it replaces goes everywhere it was shown, in favour of the new one. */
export async function keepUploadedPhoto(uid: string, pictureId: string, url: string, nowMs = Date.now()): Promise<PhotoSlot> {
  const db = getFirestore();
  const ref = appearanceOf(uid);
  const slot: PhotoSlot = { pictureId, url, setAt: nowMs };
  const previous = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const before = readPhotoSlot(doc.exists ? doc.get("photo") : null);
    transaction.set(ref, { photo: slot }, { merge: true });
    return before;
  });
  if (previous !== null && previous.pictureId !== pictureId) await retirePhoto(uid, previous, url);
  return slot;
}

/** Empties the slot; the photo it held goes everywhere, a face showing it becoming the letter. Null when it was empty. */
export async function removeUploadedPhoto(uid: string): Promise<PhotoSlot | null> {
  const db = getFirestore();
  const ref = appearanceOf(uid);
  const previous = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const before = readPhotoSlot(doc.exists ? doc.get("photo") : null);
    if (before !== null) transaction.set(ref, { photo: null }, { merge: true });
    return before;
  });
  if (previous !== null) await retirePhoto(uid, previous, null);
  return previous;
}

/**
 * The lists and rankings showing [old] show [replacement] instead (null: the
 * letter), and so does the account when it wears it; then the copy is deleted,
 * so no file is left behind and nothing points at a missing one.
 */
export async function retirePhoto(uid: string, old: PhotoSlot, replacement: string | null): Promise<void> {
  const db = getFirestore();
  const bucket = getStorage().bucket();
  const path = photoPathOf(uid, old.pictureId);
  const showing = (value: unknown) => value === old.url || pointsAt(value, bucket.name, path);

  const [lists, rankings] = await Promise.all([
    db.collection("publishedLists").where("authorUid", "==", uid).get(),
    db.collection("rankings").where("uid", "==", uid).get(),
  ]);
  // Other people's rankings of their lists keep the author's face in their snapshot.
  const listIds = lists.docs.map((doc) => doc.id);
  const ofTheirLists: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let start = 0; start < listIds.length; start += IN_LIMIT) {
    const chunk = await db.collection("rankings").where("listId", "in", listIds.slice(start, start + IN_LIMIT)).get();
    ofTheirLists.push(...chunk.docs);
  }
  const changes = [
    ...[...lists.docs, ...rankings.docs].filter((doc) => showing(doc.get("authorPhotoUrl"))).map((doc) => ({ ref: doc.ref, field: "authorPhotoUrl" })),
    ...ofTheirLists.filter((doc) => showing(doc.get("snapshot.authorPhotoUrl"))).map((doc) => ({ ref: doc.ref, field: "snapshot.authorPhotoUrl" })),
  ];
  for (let start = 0; start < changes.length; start += BATCH_LIMIT) {
    const batch = db.batch();
    changes.slice(start, start + BATCH_LIMIT).forEach(({ ref, field }) => batch.update(ref, { [field]: replacement }));
    await batch.commit();
  }

  try {
    const user = await getAuth().getUser(uid);
    if (showing(user.photoURL ?? null)) await getAuth().updateUser(uid, { photoURL: replacement });
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
  }

  await bucket.file(path).delete({ ignoreNotFound: true });
}
