import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { discardCopiesIn, discardPublished, isPhotoCopiedFrom, withoutPhotosFrom } from "./publishedPictures";
import { nextRevision } from "./listRevision";
import { LIKE_QUOTA, RANKING_LIKES, rankingFolderOf } from "./rankingLikes";
import { discardRankingFolder, discardRankingsOf, removeLikesWhere } from "./rankingRemains";
import { proposalAfterErasure, type SectionStatus } from "./sections";
import { auditTargetsOf, withoutNames } from "./audit";
import { ERASED_PROPOSER, topicAfterErasure, type TopicStatus } from "./topics";
import { keepBanPastErasure } from "./banIdentities";
import { markErased } from "./auth";

const ACCOUNTS = "accounts";
const PUBLISHED = "publishedLists";
const REPORTS = "reports";
const FOLLOWS = "follows";
const TAKES = "takes";
const SECTION_FOLLOWS = "sectionFollows";
const TOPIC_FOLLOWS = "topicFollows";
const TOPICS = "topics";
const RANKINGS = "rankings";
const PUBLISH_HOLDS = "publishHolds";
const SECTIONS = "sections";
const SECTION_PROPOSERS = "sectionProposers";
const PUBLISH_LOCKS = "publishLocks";
const AUDIT_LOG = "auditLog";
const ROLES = "roles";

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
  { collection: PUBLISH_HOLDS, field: "authorUid" },
];

/** Documents kept under the person's own uid: their recent proposals, the moderator's role, their publish lock and their recent likes. */
export const OWN_DOCUMENTS: readonly string[] = [SECTION_PROPOSERS, ROLES, PUBLISH_LOCKS, LIKE_QUOTA];

/**
 * Follows, rankings and likes that a count stands on: each one removed takes
 * one off the count on the thing followed, ranked or liked, as unfollowing,
 * withdrawing a ranking or taking a like back does, so an erased account
 * leaves nobody behind in the numbers either.
 */
export const COUNTED_FOLLOWS: readonly {
  collection: string;
  field: string;
  countedOn: { collection: string; idField: string; counter: string };
}[] = [
  { collection: TOPIC_FOLLOWS, field: "follower", countedOn: { collection: TOPICS, idField: "topicId", counter: "followerCount" } },
  { collection: RANKINGS, field: "uid", countedOn: { collection: PUBLISHED, idField: "listId", counter: "rankingCount" } },
  { collection: RANKING_LIKES, field: "uid", countedOn: { collection: RANKINGS, idField: "rankingId", counter: "likeCount" } },
];

/**
 * Where other people keep copies of a list's pictures: lists made from it,
 * and the cards readers added to their rankings, each in its own folder.
 */
const COPY_HOLDERS: readonly { collection: string; items: "items" | "addedCards"; folderOf: (id: string) => string }[] = [
  { collection: PUBLISHED, items: "items", folderOf: (id) => id },
  { collection: RANKINGS, items: "addedCards", folderOf: rankingFolderOf },
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

  // First, so a write from another phone still holding a token cannot land behind the steps below.
  await markErased(uid);

  // A ban in force outlives the account, kept by the person's hashed sign-ins rather than the uid.
  await keepBanPastErasure(uid);

  // Their published lists, and the feed's copies of their pictures with them:
  // in other people's lists and rankings too, where a card that showed one of
  // their photographs shows none. Other people's rankings of their lists go
  // as they would with the list taken down.
  const published = await db.collection(PUBLISHED).where("authorUid", "==", uid).get();
  for (const doc of published.docs) {
    await dropPhotoCopiesOf(doc.id);
    await discardPublished(doc.id);
    await discardRankingsOf(doc.id);
    await removeWhere(REPORTS, "listId", "==", doc.id);
    await doc.ref.delete();
  }

  // Everything that names them, then the follows a count stands on.
  for (const named of NAMED_IN) {
    await removeWhere(named.collection, named.field, "==", uid);
  }
  // Their rankings' folders of pictures, and the likes given to them, before
  // the rankings themselves, so a repeated erasure still finds them.
  const ranked = await db.collection(RANKINGS).where("uid", "==", uid).select().get();
  for (const doc of ranked.docs) await discardRankingFolder(doc.id);
  await removeLikesWhere("rankedBy", uid);
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

  // The topics they proposed or made, the same way; a removed one's picture goes with it.
  const topics = await db.collection(TOPICS).where("createdBy", "==", uid).get();
  for (const doc of topics.docs) {
    if (topicAfterErasure(doc.get("status") as TopicStatus) === "remove") {
      await doc.ref.delete();
      await getStorage().bucket().deleteFiles({ prefix: `topics/${doc.id}/`, force: true });
    } else {
      await doc.ref.update({ ...ERASED_PROPOSER });
    }
  }

  for (const collection of OWN_DOCUMENTS) {
    await db.collection(collection).doc(uid).delete();
  }

  // Other people's copies of their lists now credit nobody, and the log keeps
  // their uid, which bans are kept by, without their name.
  await blankCredits(uid);
  await stripAuditNames(uid);

  // Their boards, then the account document the balance lives on.
  await removeCollection(db.collection(ACCOUNTS).doc(uid).collection("boards"));
  await removeCollection(db.collection(ACCOUNTS).doc(uid).collection("plays"));
  await db.collection(ACCOUNTS).doc(uid).delete();

  // Their pictures, and the face they gave the community.
  const bucket = getStorage().bucket();
  await bucket.deleteFiles({ prefix: `users/${uid}/`, force: true });
  await bucket.deleteFiles({ prefix: `avatars/${uid}/`, force: true });

  // Last, and only once the rest is gone. Already gone is a repeated erasure.
  await getAuth()
    .deleteUser(uid)
    .catch((error: { code?: unknown } | null) => {
      if (error?.code !== "auth/user-not-found") throw error;
    });
}

/**
 * Their photographs, copied into other people's lists and rankings that took
 * them from [listId] (`picturesFrom`), come out of those: the card shows no
 * picture, and the copy's file goes. Pictures from catalogues and other sites
 * stay where they are, being nobody's own.
 */
async function dropPhotoCopiesOf(listId: string): Promise<void> {
  const db = getFirestore();
  for (const holder of COPY_HOLDERS) {
    const copies = await db.collection(holder.collection).where("picturesFrom", "array-contains", listId).get();
    for (const copy of copies.docs) {
      const folderId = holder.folderOf(copy.id);
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(copy.ref);
        if (!fresh.exists) return;
        const items = fresh.get(holder.items);
        const previews = fresh.get("previewImages");
        const cover = fresh.get("coverImageUrl");
        const without = withoutPhotosFrom({
          items: Array.isArray(items) ? (items as { imageUrl: string | null }[]) : [],
          coverImageUrl: typeof cover === "string" ? cover : null,
          previewImages: Array.isArray(previews) ? previews.filter((url): url is string => typeof url === "string") : [],
        }, folderId, listId);
        if (without === null) return;
        transaction.update(copy.ref, holder.items === "items"
          ? { items: without.items, coverImageUrl: without.coverImageUrl, previewImages: without.previewImages, ...nextRevision() }
          : { addedCards: without.items });
      });
      await discardCopiesIn([folderId], listId, getStorage().bucket(), isPhotoCopiedFrom);
    }
  }
}

/** Copies that credited them by uid and name credit nobody; each one rewritten leaves the query. */
async function blankCredits(uid: string): Promise<void> {
  const db = getFirestore();
  for (;;) {
    const page = await db.collection(PUBLISHED).where("basedOn.authorUid", "==", uid).select().limit(BATCH).get();
    if (page.empty) {
      return;
    }
    const batch = db.batch();
    page.docs.forEach((doc) => batch.update(doc.ref, { "basedOn.authorUid": "", "basedOn.authorName": "" }));
    await batch.commit();
    if (page.size < BATCH) {
      return;
    }
  }
}

/** The log's lines about them, with the uid kept and the name taken out of both sides. */
async function stripAuditNames(uid: string): Promise<void> {
  const db = getFirestore();
  for (const target of auditTargetsOf(uid)) {
    const entries = await db.collection(AUDIT_LOG).where("target", "==", target).select("before", "after").get();
    for (let at = 0; at < entries.docs.length; at += BATCH) {
      const batch = db.batch();
      entries.docs.slice(at, at + BATCH).forEach((doc) => {
        batch.update(doc.ref, { before: withoutNames(doc.get("before")), after: withoutNames(doc.get("after")) });
      });
      await batch.commit();
    }
  }
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
