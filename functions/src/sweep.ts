import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { decideSweep, lastSeen } from "./guests";

/** Firebase's own ceiling for one page of users, and for one batch delete. */
const PAGE_SIZE = 1000;
const DELETE_BATCH = 1000;

/**
 * Nothing here is user-facing, so a run that finds too much stops rather than
 * running for an hour. The next day picks up where it left off.
 */
const MAX_PER_RUN = 5000;

/**
 * Sweeps abandoned guest identities once a day.
 *
 * Firebase's own anonymous cleanup lives behind an Identity Platform upgrade,
 * which changes how the project is billed. This does the same job in the one
 * place that already has the Admin SDK.
 */
export const sweepGuests = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Etc/UTC",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async () => {
    const nowMs = Date.now();
    const auth = getAuth();
    const doomed: string[] = [];

    let pageToken: string | undefined;
    do {
      const page = await auth.listUsers(PAGE_SIZE, pageToken);
      for (const user of page.users) {
        if (decideSweep(toCandidate(user, nowMs), nowMs).sweep) {
          doomed.push(user.uid);
        }
      }
      pageToken = page.pageToken;
    } while (pageToken && doomed.length < MAX_PER_RUN);

    if (doomed.length === 0) {
      console.log("Guest sweep: nothing abandoned");
      return;
    }

    let deleted = 0;
    const failures: string[] = [];
    for (let from = 0; from < doomed.length; from += DELETE_BATCH) {
      const batch = doomed.slice(from, from + DELETE_BATCH);
      const result = await auth.deleteUsers(batch);
      deleted += result.successCount;
      result.errors.forEach((error) => failures.push(batch[error.index]));
    }

    // The ledger row outlives the identity otherwise, and nothing can ever
    // reach it again: an anonymous account cannot be signed back into.
    const gone = new Set(doomed.filter((uid) => !failures.includes(uid)));
    await forgetLedgerRows(gone);

    console.log(`Guest sweep: deleted ${deleted} of ${doomed.length} abandoned guests`);
    if (failures.length > 0) {
      console.warn(`Guest sweep: ${failures.length} could not be deleted and will be tried again tomorrow`);
    }
  },
);

function toCandidate(user: UserRecord, nowMs: number) {
  return {
    uid: user.uid,
    anonymous: user.providerData.length === 0,
    lastSeenMs: lastSeen(user.metadata, nowMs),
  };
}

async function forgetLedgerRows(uids: Set<string>): Promise<void> {
  const db = getFirestore();
  const rows = [...uids];
  // Firestore takes 500 writes per batch, half of Auth's delete limit.
  for (let from = 0; from < rows.length; from += 500) {
    const batch = db.batch();
    rows.slice(from, from + 500).forEach((uid) => batch.delete(db.collection("accounts").doc(uid)));
    await batch.commit();
  }
}
