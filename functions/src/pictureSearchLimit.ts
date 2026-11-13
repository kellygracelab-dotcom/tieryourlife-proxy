/**
 * How many picture searches one person may send to the catalogues. The
 * catalogues count requests by address, and every search comes from the
 * same few servers, so one person searching without end would use up what
 * everybody shares. An answer already cached costs nothing, a whole search
 * that builds on its quick answer is the same search, and a refusal is not
 * counted, so asking again while refused does not push the moment back.
 *
 * No minute window: the website pastes a list as up to three searches a
 * second, and 300 titles with a retry each stay inside an hour.
 */
import { dayKey } from "./quota";

export const PICTURE_SEARCHES_PER_HOUR = 1000;
export const PICTURE_SEARCHES_PER_DAY = 3000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One person's searches on one UTC day, kept in `pictureSearches/{day}/users/{uid}`. */
export interface SearchCount {
  count: number;
  /** Hours since the epoch, UTC, that [hourCount] is for. */
  hour: number;
  hourCount: number;
}

export type SearchCharge = { allowed: true; next: SearchCount } | { allowed: false; retryAtMs: number };

/** Whether one more search fits, given what this day's document holds; when it does not, the moment the full window opens again. */
export function chargeSearch(before: Partial<SearchCount> | undefined, nowMs: number): SearchCharge {
  return charge(before, nowMs, PICTURE_SEARCHES_PER_DAY, PICTURE_SEARCHES_PER_HOUR);
}

/**
 * Pictures one person may have fetched by their address (`POST /lists/pictures/link`):
 * each costs a download and a Vision look. Kept in `pictureWeb/{day}/links/{uid}`.
 */
export const LINKED_PICTURES_PER_DAY = 400;
export const LINKED_PICTURES_PER_HOUR = 200;

export function chargeLink(before: Partial<SearchCount> | undefined, nowMs: number): SearchCharge {
  return charge(before, nowMs, LINKED_PICTURES_PER_DAY, LINKED_PICTURES_PER_HOUR);
}

/** What a person has left of today's pictures by link, and when the day starts again (UTC midnight). */
export interface LinkQuota {
  left: number;
  limit: number;
  resetsAt: number;
}

export function linkQuota(count: number | undefined, nowMs: number): LinkQuota {
  const used = typeof count === "number" && Number.isFinite(count) ? count : 0;
  return {
    left: Math.max(0, LINKED_PICTURES_PER_DAY - used),
    limit: LINKED_PICTURES_PER_DAY,
    resetsAt: Date.parse(`${dayKey(nowMs)}T00:00:00Z`) + DAY_MS,
  };
}

function charge(before: Partial<SearchCount> | undefined, nowMs: number, perDay: number, perHour: number): SearchCharge {
  const hour = Math.floor(nowMs / HOUR_MS);
  const count = typeof before?.count === "number" ? before.count : 0;
  const hourCount = before?.hour === hour && typeof before.hourCount === "number" ? before.hourCount : 0;
  if (count >= perDay) return { allowed: false, retryAtMs: Date.parse(`${dayKey(nowMs)}T00:00:00Z`) + DAY_MS };
  if (hourCount >= perHour) return { allowed: false, retryAtMs: (hour + 1) * HOUR_MS };
  return { allowed: true, next: { count: count + 1, hour, hourCount: hourCount + 1 } };
}

/** `Retry-After` for [retryAtMs]: whole seconds, never less than one. */
export function retryAfterSeconds(retryAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000));
}
