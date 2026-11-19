/** A count per account per UTC day, kept in `{collection}/{day}/accounts/{uid}`, one field per thing counted. */
import { getFirestore } from "firebase-admin/firestore";
import { dayKey } from "./quota";

/** The next UTC midnight after [nowMs]. */
export function nextDayMs(nowMs: number): number {
  const day = new Date(nowMs);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/** Whether [count] more fit under [limit], given [used] as stored; pure, for tests. */
export function fitsInDay(used: unknown, count: number, limit: number): boolean {
  const before = typeof used === "number" && Number.isFinite(used) ? used : 0;
  return before + count <= limit;
}

/** Counts [count] more of [field] for [uid] today when they fit under [limit]; false, counting nothing, when not. */
export async function countToday(collection: string, uid: string, field: string, count: number, limit: number, nowMs = Date.now()): Promise<boolean> {
  if (count <= 0) return true;
  const db = getFirestore();
  const ref = db.doc(`${collection}/${dayKey(nowMs)}/accounts/${uid}`);
  return db.runTransaction(async (transaction) => {
    const used = (await transaction.get(ref)).get(field);
    if (!fitsInDay(used, count, limit)) return false;
    transaction.set(ref, { [field]: (typeof used === "number" ? used : 0) + count }, { merge: true });
    return true;
  });
}
