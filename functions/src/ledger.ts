import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import {
  type AccountSnapshot,
  type ReserveDecision,
  dayKey,
  decideReservation,
  decideSettlement,
  startingCredits,
} from "./quota";

/**
 * The only file that writes the ledger. Every rule it applies comes from
 * `quota.ts`; this one is the Firestore plumbing around those decisions.
 *
 * Two collections, both written exclusively by this backend — `firestore.rules`
 * denies clients outright, and the Admin SDK bypasses rules:
 *
 *   accounts/{uid}   credits, inFlightUntil, totalGenerated
 *   usage/{YYYY-MM-DD}  generations reserved service-wide that UTC day
 */

const ACCOUNTS = "accounts";
const USAGE = "usage";

interface AccountDocument {
  credits?: number;
  inFlightUntil?: Timestamp | null;
  totalGenerated?: number;
}

interface UsageDocument {
  generations?: number;
}

function toAccountSnapshot(snapshot: DocumentSnapshot): AccountSnapshot {
  const data = (snapshot.data() ?? {}) as AccountDocument;
  const inFlightUntil = data.inFlightUntil ?? null;
  return {
    exists: snapshot.exists,
    credits: data.credits ?? 0,
    inFlightUntilMs: inFlightUntil ? inFlightUntil.toMillis() : null,
  };
}

/**
 * Takes one credit and holds the account for the length of the lease. Returns
 * what the caller must do next; only `reserved` may go on to spend money.
 */
export async function reserveGeneration(uid: string, nowMs: number): Promise<ReserveDecision> {
  const db = getFirestore();
  const accountRef = db.collection(ACCOUNTS).doc(uid);
  const usageRef = db.collection(USAGE).doc(dayKey(nowMs));

  return db.runTransaction(async (transaction) => {
    const [accountSnapshot, usageSnapshot] = await transaction.getAll(accountRef, usageRef);
    const usage = (usageSnapshot.data() ?? {}) as UsageDocument;

    const decision = decideReservation({
      account: toAccountSnapshot(accountSnapshot),
      dailyCount: usage.generations ?? 0,
      nowMs,
    });

    if (decision.outcome !== "reserved") {
      return decision;
    }

    transaction.set(
      accountRef,
      {
        credits: decision.creditsAfter,
        inFlightUntil: Timestamp.fromMillis(decision.inFlightUntilMs),
        updatedAt: FieldValue.serverTimestamp(),
        ...(accountSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    transaction.set(usageRef, { generations: FieldValue.increment(1) }, { merge: true });

    return decision;
  });
}

/**
 * Closes a reservation and returns the balance left. Always call this once a
 * reservation was made — a lease left hanging locks the account until it expires.
 */
export async function settleGeneration(
  uid: string,
  succeeded: boolean,
  nowMs: number,
): Promise<number> {
  const db = getFirestore();
  const accountRef = db.collection(ACCOUNTS).doc(uid);
  const usageRef = db.collection(USAGE).doc(dayKey(nowMs));
  const settlement = decideSettlement(succeeded);

  return db.runTransaction(async (transaction) => {
    const accountSnapshot = await transaction.get(accountRef);
    const credits = ((accountSnapshot.data() ?? {}) as AccountDocument).credits ?? 0;

    transaction.set(
      accountRef,
      {
        credits: credits + settlement.creditDelta,
        inFlightUntil: null,
        totalGenerated: FieldValue.increment(settlement.generatedDelta),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (settlement.dailyCountDelta !== 0) {
      transaction.set(
        usageRef,
        { generations: FieldValue.increment(settlement.dailyCountDelta) },
        { merge: true },
      );
    }

    return credits + settlement.creditDelta;
  });
}

/**
 * Balance for the studio to display. Deliberately does not create the account:
 * opening a screen should not write, and a caller who has never generated is
 * told what the first generation would find.
 */
export async function readCredits(uid: string): Promise<number> {
  const snapshot = await getFirestore().collection(ACCOUNTS).doc(uid).get();
  return startingCredits(toAccountSnapshot(snapshot));
}
