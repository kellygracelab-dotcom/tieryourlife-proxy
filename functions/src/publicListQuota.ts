/** Prepared policy only: no runtime limit is enabled until its quantity is approved. */
export const PUBLIC_LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PublicListQuota =
  | { allowed: true; events: number[] }
  | { allowed: false; limit: number; windowMs: number; retryAt: number };

/** Only a genuinely new public list calls this. Retrying one board, rankings and private saves do not. */
export function decidePublicListQuota(events: readonly number[], limit: number | null, nowMs: number): PublicListQuota {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid public-list quota");
  const live = events.filter((at) => Number.isSafeInteger(at) && at > nowMs - PUBLIC_LIST_WINDOW_MS && at <= nowMs).sort((a, b) => a - b);
  if (limit !== null && live.length >= limit) {
    return { allowed: false, limit, windowMs: PUBLIC_LIST_WINDOW_MS, retryAt: live[live.length - limit] + PUBLIC_LIST_WINDOW_MS };
  }
  return { allowed: true, events: [...live, nowMs] };
}

/** The adapter must read/write one author's event document in the SAME transaction that creates the list. */
export interface PublicListQuotaSlot {
  readEvents(): Promise<number[]>;
  writeEvents(events: number[]): void;
}

export async function claimPublicListQuota(slot: PublicListQuotaSlot, limit: number | null, nowMs: number): Promise<PublicListQuota> {
  // Disabled means no new document, retained history or accidental limit in production.
  if (limit === null) return { allowed: true, events: [] };
  const decision = decidePublicListQuota(await slot.readEvents(), limit, nowMs);
  if (decision.allowed) slot.writeEvents(decision.events);
  return decision;
}
