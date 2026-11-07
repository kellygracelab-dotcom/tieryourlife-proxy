import { MAX_LISTS_PER_AUTHOR } from "./publishing";

/** What one publish transaction reads and writes to keep its author under the limit. */
export interface AuthorSlot {
  readLock(): Promise<void>;
  countLists(): Promise<number>;
  writeLock(): void;
}

/**
 * A count inside a transaction locks the lists it found, not the one a
 * parallel publish is adding. Every new list of an author also writes the
 * author's lock document, so of two publishes at once one is retried, and
 * its count then includes the other's list.
 */
export async function claimListSlot(slot: AuthorSlot, limit: number = MAX_LISTS_PER_AUTHOR): Promise<boolean> {
  const [, count] = await Promise.all([slot.readLock(), slot.countLists()]);
  if (count >= limit) return false;
  slot.writeLock();
  return true;
}
