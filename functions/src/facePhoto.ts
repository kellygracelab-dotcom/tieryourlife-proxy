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

/** A removed photo kept for Undo: its copy stays this long, then goes. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export interface RemovedPhoto extends PhotoSlot {
  removedAt: number;
  /** Whether the account wore it when it was removed: Undo puts it back on. */
  wasWorn: boolean;
}

export function readRemovedPhoto(value: unknown): RemovedPhoto | null {
  const slot = readPhotoSlot(value);
  const record = value as Record<string, unknown> | null;
  if (slot === null || typeof record?.removedAt !== "number") return null;
  return { ...slot, removedAt: record.removedAt, wasWorn: record.wasWorn === true };
}

/**
 * "Remove your photo": the slot empties and every face showing the photo
 * becomes the letter at once; its copy is kept for [UNDO_WINDOW_MS] so Undo can
 * put it back, then deleted (`finishRemoval`). A photo removed earlier and
 * still kept goes now: only the last removal can be undone. Null when the slot was empty.
 */
export async function removeUploadedPhoto(uid: string, nowMs = Date.now()): Promise<RemovedPhoto | null> {
  const db = getFirestore();
  const ref = appearanceOf(uid);
  const { before, earlier } = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const before = readPhotoSlot(doc.exists ? doc.get("photo") : null);
    const earlier = readRemovedPhoto(doc.exists ? doc.get("removedPhoto") : null);
    if (before !== null) transaction.set(ref, { photo: null, removedPhoto: { ...before, removedAt: nowMs, wasWorn: false } }, { merge: true });
    return { before, earlier };
  });
  if (before === null) return null;
  if (earlier !== null && earlier.pictureId !== before.pictureId) await deleteCopy(uid, earlier.pictureId);
  const wasWorn = await unshowPhoto(uid, before, null);
  const removed: RemovedPhoto = { ...before, removedAt: nowMs, wasWorn };
  if (wasWorn) await ref.set({ removedPhoto: removed }, { merge: true });
  return removed;
}

export type Restore =
  | { ok: true; photo: PhotoSlot; wasWorn: boolean }
  | { ok: false; why: "nothing" | "taken"; photo: PhotoSlot | null };

/**
 * Undo of "Remove your photo": the photo goes back in the slot while its copy
 * is kept. The client wears it again when `wasWorn`, as choosing "Your photo".
 * Nothing to put back after the window; a photo uploaded meanwhile stays.
 */
export async function restoreUploadedPhoto(uid: string, nowMs = Date.now()): Promise<Restore> {
  const db = getFirestore();
  const ref = appearanceOf(uid);
  const doc = await ref.get();
  const current = readPhotoSlot(doc.exists ? doc.get("photo") : null);
  const removed = readRemovedPhoto(doc.exists ? doc.get("removedPhoto") : null);
  if (current !== null) return { ok: false, why: "taken", photo: current };
  if (removed === null || nowMs - removed.removedAt > UNDO_WINDOW_MS) return { ok: false, why: "nothing", photo: null };
  const [exists] = await getStorage().bucket().file(photoPathOf(uid, removed.pictureId)).exists();
  if (!exists) return { ok: false, why: "nothing", photo: null };
  return db.runTransaction(async (transaction): Promise<Restore> => {
    const now = await transaction.get(ref);
    const photo = readPhotoSlot(now.get("photo"));
    const still = readRemovedPhoto(now.get("removedPhoto"));
    if (photo !== null) return { ok: false, why: "taken", photo };
    if (still === null || still.pictureId !== removed.pictureId) return { ok: false, why: "nothing", photo: null };
    const slot: PhotoSlot = { pictureId: still.pictureId, url: still.url, setAt: still.setAt };
    transaction.set(ref, { photo: slot, removedPhoto: null }, { merge: true });
    return { ok: true, photo: slot, wasWorn: still.wasWorn };
  });
}

/** Deletes a removed photo's copy once Undo's window is over; true when it did. */
export async function finishRemoval(uid: string, stored: unknown, nowMs = Date.now()): Promise<boolean> {
  const removed = readRemovedPhoto(stored);
  if (removed === null || nowMs - removed.removedAt <= UNDO_WINDOW_MS) return false;
  const ref = appearanceOf(uid);
  const gone = await getFirestore().runTransaction(async (transaction) => {
    const now = readRemovedPhoto((await transaction.get(ref)).get("removedPhoto"));
    if (now === null || now.pictureId !== removed.pictureId) return false;
    transaction.set(ref, { removedPhoto: null }, { merge: true });
    return true;
  });
  if (gone) await deleteCopy(uid, removed.pictureId);
  return gone;
}

/** Every account's removed photo past its window; once a day, with the picture sweep. */
export async function sweepRemovedPhotos(nowMs = Date.now()): Promise<number> {
  const docs = await getFirestore().collectionGroup("settings").get();
  let finished = 0;
  for (const doc of docs.docs) {
    const [top, uid, settings, name, ...rest] = doc.ref.path.split("/");
    if (top !== "accounts" || !uid || settings !== "settings" || name !== "appearance" || rest.length > 0) continue;
    if (await finishRemoval(uid, doc.get("removedPhoto"), nowMs)) finished++;
  }
  return finished;
}

/** A new upload replaced [old]: it shows [replacement] everywhere, and its copy goes now (no Undo for a replacement). */
export async function retirePhoto(uid: string, old: PhotoSlot, replacement: string | null): Promise<void> {
  await unshowPhoto(uid, old, replacement);
  await deleteCopy(uid, old.pictureId);
}

const deleteCopy = (uid: string, pictureId: string) =>
  getStorage().bucket().file(photoPathOf(uid, pictureId)).delete({ ignoreNotFound: true });

/**
 * The lists and rankings showing [old] show [replacement] instead (null: the
 * letter), and so does the account when it wears it. True when the account wore it.
 */
async function unshowPhoto(uid: string, old: PhotoSlot, replacement: string | null): Promise<boolean> {
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
    if (!showing(user.photoURL ?? null)) return false;
    await getAuth().updateUser(uid, { photoURL: replacement });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    return false;
  }
}
