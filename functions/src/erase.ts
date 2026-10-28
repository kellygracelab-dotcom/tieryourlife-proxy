import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { discardPublished } from "./publishedPictures";
import { proposalAfterErasure, type SectionStatus } from "./sections";

const ACCOUNTS = "accounts";
const PUBLISHED = "publishedLists";
const REPORTS = "reports";
const FOLLOWS = "follows";
const TAKES = "takes";
const SECTION_FOLLOWS = "sectionFollows";
const TOPIC_FOLLOWS = "topicFollows";
const TOPICS = "topics";
const SECTIONS = "sections";
const SECTION_PROPOSERS = "sectionProposers";

/** Firestore's own ceiling for one batch. */
const BATCH = 500;

/**
 * The documents that name this person in one field, removed outright: whom
 * they followed and who followed them, the sections they followed, what they
 * took and what they reported.
 */
export const NAMED_IN: readonly { collection: string; field: string }[] = [
  { collection: FOLLOWS, field: "follower" },
  { collection: FOLLOWS, field: "author" },
  { collection: SECTION_FOLLOWS, field: "follower" },
  { collection: TAKES, field: "taker" },
  { collection: REPORTS, field: "reporterUid" },
];

/**
 * Follows that a count stands on: each one removed takes one off the count
 * on the thing followed, as unfollowing does, so an erased account leaves no
 * follower behind in the numbers either.
 */
export const COUNTED_FOLLOWS: readonly {
  collection: string;
  field: string;
  countedOn: { collection: string; idField: string; counter: string };
}[] = [
  { collection: TOPIC_FOLLOWS, field: "follower", countedOn: { collection: TOPICS, idField: "topicId", counter: "followerCount" } },
];

/**
 * Everything this service holds about one person, removed. The identity goes
 * last, because everything before it is authorised by that identity, and
 * every step is safe to repeat, so a failure halfway is just a failed
 * attempt. Take counts on other people's lists stay: the document naming
 * this person goes, the anonymous total does not.
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

  // Everything that names them, then the follows a count stands on.
  for (const named of NAMED_IN) {
    await removeWhere(named.collection, named.field, "==", uid);
  }
  for (const follows of COUNTED_FOLLOWS) {
    await removeCounted(follows, uid);
  }

  // The sections they proposed: one nobody approved goes with them; an
  // approved or merged one stays, without their name on it. Whatever is left
  // of their own picture goes either way, merged while waiting included.
  const proposed = await db.collection(SECTIONS).where("proposerUid", "==", uid).get();
  for (const doc of proposed.docs) {
    await getStorage().bucket().deleteFiles({ prefix: `proposals/${doc.id}/`, force: true });
    if (proposalAfterErasure(doc.get("status") as SectionStatus) === "remove") {
      await doc.ref.delete();
    } else {
      await doc.ref.update({ proposerUid: null, proposerName: null, proposalPicture: null, proposalPictureUrl: null });
    }
  }
  await db.collection(SECTION_PROPOSERS).doc(uid).delete();

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

/** One follow at a time, each with its count, inside a transaction: the same steps as unfollowing. */
async function removeCounted(follows: (typeof COUNTED_FOLLOWS)[number], uid: string): Promise<void> {
  const db = getFirestore();
  const mine = await db.collection(follows.collection).where(follows.field, "==", uid).get();
  for (const doc of mine.docs) {
    const followedId = doc.get(follows.countedOn.idField);
    await db.runTransaction(async (transaction) => {
      const follow = await transaction.get(doc.ref);
      if (!follow.exists) return;
      const followed = typeof followedId === "string" && followedId.length > 0
        ? db.collection(follows.countedOn.collection).doc(followedId)
        : null;
      const target = followed ? await transaction.get(followed) : null;
      transaction.delete(doc.ref);
      if (followed && target?.exists) {
        transaction.update(followed, { [follows.countedOn.counter]: FieldValue.increment(-1) });
      }
    });
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
