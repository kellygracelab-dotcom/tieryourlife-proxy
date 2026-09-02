import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { discardPublished } from "./publishedPictures";

const ACCOUNTS = "accounts";
const PUBLISHED = "publishedLists";
const REPORTS = "reports";
const FOLLOWS = "follows";
const TAKES = "takes";

/** Firestore's own ceiling for one batch. */
const BATCH = 500;

/**
 * Everything this service holds about one person, removed.
 *
 * The order is the design. The identity goes last, because everything before
 * it is authorised by that identity: delete the account first and a failure
 * halfway leaves somebody unable to sign in, unable to try again, and with
 * their boards still here. Deleting the data first means a failure is simply a
 * failed attempt, and pressing the button again picks up where it stopped --
 * every step below is safe to repeat.
 *
 * What is deliberately left behind: the take counts on other people's lists.
 * The document naming this person as the taker goes, so nothing points back at
 * them; the number it contributed to stays, because it is now an anonymous
 * total that belongs to somebody else's list rather than a fact about them.
 */
export async function eraseAccount(uid: string): Promise<void> {
  const db = getFirestore();

  // Their published lists, and the feed's copies of their pictures with them.
  const published = await db.collection(PUBLISHED).where("authorUid", "==", uid).get();
  for (const doc of published.docs) {
    await discardPublished(doc.id);
    await removeWhere(REPORTS, "listId", "==", doc.id);
    await doc.ref.delete();
  }

  // Both directions: who they followed, and who followed them.
  await removeWhere(FOLLOWS, "follower", "==", uid);
  await removeWhere(FOLLOWS, "author", "==", uid);
  await removeWhere(TAKES, "taker", "==", uid);
  await removeWhere(REPORTS, "reporterUid", "==", uid);

  // Their boards, then the account document the balance lives on.
  await removeCollection(db.collection(ACCOUNTS).doc(uid).collection("boards"));
  await db.collection(ACCOUNTS).doc(uid).delete();

  // Their pictures, and the face they gave the community.
  const bucket = getStorage().bucket();
  await bucket.deleteFiles({ prefix: `users/${uid}/`, force: true });
  await bucket.deleteFiles({ prefix: `avatars/${uid}/`, force: true });

  // Last, and only once the rest is gone.
  await getAuth().deleteUser(uid);
}

async function removeWhere(
  collection: string,
  field: string,
  op: FirebaseFirestore.WhereFilterOp,
  value: string,
): Promise<void> {
  const db = getFirestore();
  for (;;) {
    const page = await db.collection(collection).where(field, op, value).limit(BATCH).get();
    if (page.empty) {
      return;
    }
    const batch = db.batch();
    page.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (page.size < BATCH) {
      return;
    }
  }
}

async function removeCollection(collection: FirebaseFirestore.CollectionReference): Promise<void> {
  for (;;) {
    const page = await collection.limit(BATCH).get();
    if (page.empty) {
      return;
    }
    const batch = getFirestore().batch();
    page.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (page.size < BATCH) {
      return;
    }
  }
}
