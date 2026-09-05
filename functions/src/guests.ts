/**
 * Which guest identities have been abandoned. Every install signs in
 * anonymously; the ones that pile up are those left behind when somebody
 * signs into a Google account that already exists, which cannot be merged.
 * Pure: `sweep.ts` turns these decisions into deletions.
 */

/**
 * How long an identity has to go untouched before it counts as abandoned. A
 * token refreshes whenever the app runs, so this is "the app has not been
 * opened in a month", not "nobody has signed in".
 */
export const ABANDONED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface GuestCandidate {
  uid: string;
  /** True when no sign-in provider has ever been linked. */
  anonymous: boolean;
  /** Last token refresh, then last sign-in, then creation. Epoch millis. */
  lastSeenMs: number;
}

export type SweepDecision =
  | { sweep: true }
  | { sweep: false; because: "has_an_account" | "still_in_use" };

export function decideSweep(candidate: GuestCandidate, nowMs: number): SweepDecision {
  // An identity with a provider on it is somebody's account, whatever it
  // started as. Age is not a reason to touch it.
  if (!candidate.anonymous) {
    return { sweep: false, because: "has_an_account" };
  }
  if (nowMs - candidate.lastSeenMs < ABANDONED_AFTER_MS) {
    return { sweep: false, because: "still_in_use" };
  }
  return { sweep: true };
}

/**
 * The three timestamps Firebase keeps, newest first. A record with none of them
 * reads as brand new rather than as ancient: guessing old here would delete a
 * live identity, and guessing new only delays a sweep by a day.
 */
export function lastSeen(
  metadata: { lastRefreshTime?: string | null; lastSignInTime?: string | null; creationTime?: string | null },
  nowMs: number,
): number {
  for (const stamp of [metadata.lastRefreshTime, metadata.lastSignInTime, metadata.creationTime]) {
    if (!stamp) {
      continue;
    }
    const parsed = Date.parse(stamp);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return nowMs;
}
