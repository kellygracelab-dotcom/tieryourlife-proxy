/**
 * The rules that decide whether a generation may happen. Deliberately pure: no
 * Firestore, no clock, no network. Everything it needs is passed in, so the
 * cases that matter can be tested without an emulator. `ledger.ts` is the only
 * file that turns these decisions into writes.
 */

/** Three rather than ten while nobody is paying: enough to see what the feature does, not enough to be a free image service. */
export const FREE_GENERATION_GRANT = 3;

/**
 * Generations the whole service will pay for in a single UTC day: the number
 * that actually bounds the bill, whatever the count of installs or guest identities.
 */
export const DAILY_GENERATION_CEILING = 100;

/**
 * How long a reservation holds the account. Longer than the function's own 300
 * second timeout, so a request that is still running is never treated as gone.
 */
export const IN_FLIGHT_LEASE_MS = 6 * 60 * 1000;

export interface AccountSnapshot {
  /** False before the account has ever reserved a generation. */
  exists: boolean;
  credits: number;
  /** When the current reservation expires, or null when nothing is in flight. */
  inFlightUntilMs: number | null;
}

export type ReserveDecision =
  | { outcome: "reserved"; creditsAfter: number; inFlightUntilMs: number }
  | { outcome: "no_credits" }
  | { outcome: "busy"; retryAfterSeconds: number }
  | { outcome: "daily_ceiling" };

export interface ReserveInput {
  account: AccountSnapshot;
  dailyCount: number;
  nowMs: number;
}

/**
 * Credits an account is entitled to before it has spent anything. A missing
 * document means a first-time caller, not a broken one.
 */
export function startingCredits(account: AccountSnapshot): number {
  return account.exists ? account.credits : FREE_GENERATION_GRANT;
}

export function decideReservation({ account, dailyCount, nowMs }: ReserveInput): ReserveDecision {
  // A live reservation is checked first: answering "you already have one
  // running" is more useful than any of the other refusals.
  if (account.inFlightUntilMs !== null && account.inFlightUntilMs > nowMs) {
    return {
      outcome: "busy",
      retryAfterSeconds: Math.ceil((account.inFlightUntilMs - nowMs) / 1000),
    };
  }

  const credits = startingCredits(account);
  // An empty balance is reported before the service-wide ceiling: it stays true
  // whatever the rest of the world is doing, and it is the one the caller can act on.
  if (credits <= 0) {
    return { outcome: "no_credits" };
  }

  if (dailyCount >= DAILY_GENERATION_CEILING) {
    return { outcome: "daily_ceiling" };
  }

  return {
    outcome: "reserved",
    creditsAfter: credits - 1,
    inFlightUntilMs: nowMs + IN_FLIGHT_LEASE_MS,
  };
}

/** Changes a finished generation makes, relative to what the reservation left. */
export interface Settlement {
  /** Credits handed back to the account. */
  creditDelta: number;
  /** Rolled back off the service-wide daily counter. */
  dailyCountDelta: number;
  /** Added to the account's lifetime count of delivered images. */
  generatedDelta: number;
}

/**
 * A failure gives the credit back; a success keeps it spent. A run that dies
 * without settling keeps it spent too: once the request reached Gemini we
 * cannot tell whether it was billed.
 */
export function decideSettlement(succeeded: boolean): Settlement {
  return succeeded
    ? { creditDelta: 0, dailyCountDelta: 0, generatedDelta: 1 }
    : { creditDelta: 1, dailyCountDelta: -1, generatedDelta: 0 };
}

/** UTC day the ceiling is counted against, as a Firestore document id. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * What one account ends up with after taking over a guest's balance (Firebase
 * cannot link a guest onto an existing Google account, so the guest uid is
 * left behind with its balance). Not a sum: every credit today is the free
 * grant, and adding would make signing out and in a way of printing them.
 * Bought credits add; the free grant is counted once at its higher remainder.
 */
export interface CarryInput {
  destination: AccountSnapshot;
  destinationPurchased: number;
  guestCredits: number;
  guestPurchased: number;
}

export function decideCarry({
  destination,
  destinationPurchased,
  guestCredits,
  guestPurchased,
}: CarryInput): { credits: number; purchased: number; moved: boolean } {
  const held = startingCredits(destination);
  const freeHere = Math.max(0, held - destinationPurchased);
  const freeThere = Math.max(0, guestCredits - guestPurchased);

  const purchased = destinationPurchased + guestPurchased;
  const credits = purchased + Math.max(freeHere, freeThere);

  return { credits, purchased, moved: credits > held };
}
