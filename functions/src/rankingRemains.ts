/**
 * What a reader's ranking leaves behind when it goes, withdrawn, with its
 * list, or with its reader's account: the likes people gave it and its own
 * folder of picture copies. Nothing here touches a count: the ranking that
 * held the likes is gone, and its list's count is its remover's to keep.
 */
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { RANKING_LIKES, rankingFolderOf } from "./rankingLikes";
import { isOwnedRanking } from "./rankings";

const BATCH = 400;

/** Every like whose [field] is [value]: of one ranking, of one list's rankings, or of one person's. */
export async function removeLikesWhere(field: "rankingId" | "listId" | "rankedBy", value: string): Promise<void> {
  const db = getFirestore();
  for (;;) {
    const page = await db.collection(RANKING_LIKES).where(field, "==", value).select().limit(BATCH).get();
    if (page.empty) return;
    const batch = db.batch();
    page.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (page.size < BATCH) return;
  }
}

/** The copies of the pictures a ranking's added cards show, all of them. */
export async function discardRankingFolder(rankingId: string): Promise<void> {
  await getStorage().bucket().deleteFiles({ prefix: `published/${rankingFolderOf(rankingId)}/`, force: true });
}

/** One ranking's likes and folder, once the ranking itself is gone. */
export async function discardRankingRemains(rankingId: string): Promise<void> {
  await removeLikesWhere("rankingId", rankingId);
  await discardRankingFolder(rankingId);
}

/**
 * A list that is gone takes the app's rankings of it with it, their likes
 * and their pictures too; nobody can open them without it. The website's
 * rankings, kept by code and without an account, are the website's: its
 * pages outlive the list. The list's own count goes with the list.
 */
export async function discardRankingsOf(listId: string): Promise<void> {
  const db = getFirestore();
  const carrying = (await db.collection("rankings").where("listId", "==", listId).get()).docs.filter((doc) => isOwnedRanking(doc.data()));
  for (let at = 0; at < carrying.length; at += BATCH) {
    const batch = db.batch();
    carrying.slice(at, at + BATCH).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  await removeLikesWhere("listId", listId);
  for (const doc of carrying) await discardRankingFolder(doc.id);
}
