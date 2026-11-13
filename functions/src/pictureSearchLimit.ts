/**
 * How many picture searches one person may send to the catalogues. The
 * catalogues count requests by address, and every search comes from the
 * same few servers, so one person searching without end would use up what
 * everybody shares. An answer already cached costs nothing and is not counted.
 */
import { dayKey } from "./quota";

export const PICTURE_SEARCHES_PER_MINUTE = 40;
export const PICTURE_SEARCHES_PER_DAY = 1000;

/** One person's searches on one UTC day, kept in `pictureSearches/{day}/users/{uid}`. */
export interface SearchCount {
  count: number;
  minute: number;
  minuteCount: number;
}

export type SearchCharge = { allowed: true; next: SearchCount } | { allowed: false; retryAfterSeconds: number };

/** Whether one more search fits, given what this day's document holds; when it does not, how long until one would. */
export function chargeSearch(before: Partial<SearchCount> | undefined, nowMs: number): SearchCharge {
  const minute = Math.floor(nowMs / 60_000);
  const count = typeof before?.count === "number" ? before.count : 0;
  const minuteCount = before?.minute === minute && typeof before.minuteCount === "number" ? before.minuteCount : 0;
  if (count >= PICTURE_SEARCHES_PER_DAY) {
    const tomorrow = Date.parse(`${dayKey(nowMs)}T00:00:00Z`) + 24 * 60 * 60 * 1000;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((tomorrow - nowMs) / 1000)) };
  }
  if (minuteCount >= PICTURE_SEARCHES_PER_MINUTE) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000)) };
  }
  return { allowed: true, next: { count: count + 1, minute, minuteCount: minuteCount + 1 } };
}
