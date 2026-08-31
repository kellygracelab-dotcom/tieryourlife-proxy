/**
 * Who may follow whom, and how a feed of the people you follow is put
 * together. Pure, like the rest of the deciding here; `community.ts` does the
 * reads and writes.
 */

/**
 * How many authors one person's feed will draw from.
 *
 * Firestore answers `in` with at most thirty values, so a following feed is
 * already several queries merged. The ceiling is on how many of those we are
 * willing to run for one page -- at two hundred that is seven, which is a lot
 * for a screen but still a fixed, knowable cost. Nobody following that many
 * people is reading all of them anyway, and a limit that can be stated is
 * better than a page that quietly gets slower the more you follow.
 */
export const MAX_FOLLOWING = 200;

/** Firestore's own ceiling on an `in` clause. Not ours to choose. */
export const FOLLOWED_PER_QUERY = 30;

export const SORTS = ["recent", "popular"] as const;
export type Sort = (typeof SORTS)[number];

/** Anything that is not one of the two means "newest first", not an error. */
export function sortOrder(raw: unknown): Sort {
  return SORTS.find((known) => known === raw) ?? "recent";
}

export type FollowRefusal = "not_signed_in" | "yourself" | "invalid" | "too_many";

export type FollowDecision = { ok: true } | { ok: false; reason: FollowRefusal };

export interface Follower {
  uid: string;
  isAnonymous: boolean;
  /** How many people they already follow. */
  following: number;
}

/**
 * Whether this person may follow that one.
 *
 * Following is kept behind an account rather than allowed to guests. It is a
 * list that has to survive the phone it was made on, and a guest is an
 * identity this app hands out and sweeps away -- letting one build a following
 * list would be promising to keep something we delete.
 */
export function decideFollow(follower: Follower, authorUid: string): FollowDecision {
  if (follower.isAnonymous) {
    return { ok: false, reason: "not_signed_in" };
  }
  if (!isUid(authorUid)) {
    return { ok: false, reason: "invalid" };
  }
  if (authorUid === follower.uid) {
    return { ok: false, reason: "yourself" };
  }
  if (follower.following >= MAX_FOLLOWING) {
    return { ok: false, reason: "too_many" };
  }
  return { ok: true };
}

/**
 * A Firebase uid, near enough to refuse the obviously wrong without pretending
 * to know the format better than Firebase does.
 */
export function isUid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{8,128}$/.test(value);
}

/**
 * Deterministic, so following twice writes the same document and following is
 * idempotent without reading first. A join rather than a nested id: `follows`
 * is queried from both ends -- who I follow, and how many follow them.
 */
export function followId(follower: string, author: string): string {
  return `${follower}_${author}`;
}

export function chunked<T>(values: T[], size: number = FOLLOWED_PER_QUERY): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < values.length; at += size) {
    chunks.push(values.slice(at, at + size));
  }
  return chunks;
}

export interface Ranked {
  id: string;
  updatedAt: number;
  takeCount: number;
}

/**
 * One page out of several already-sorted pages.
 *
 * The following feed asks Firestore once per thirty authors, so what comes
 * back is several sorted runs rather than one. Merging them here keeps the
 * ordering the reader was promised; doing it any other way would show the
 * first thirty authors' lists ahead of everyone else's regardless of date.
 *
 * Ties break on id so that two lists saved in the same millisecond always come
 * back in the same order -- a page boundary that wobbles repeats a list or
 * skips one.
 */
export function mergePages<T extends Ranked>(pages: T[][], sort: Sort, pageSize: number): T[] {
  const seen = new Set<string>();
  const all: T[] = [];
  for (const page of pages) {
    for (const item of page) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }
  }
  return all.sort((left, right) => compare(left, right, sort)).slice(0, pageSize);
}

function compare(left: Ranked, right: Ranked, sort: Sort): number {
  const by = sort === "popular"
    ? right.takeCount - left.takeCount
    : right.updatedAt - left.updatedAt;
  return by !== 0 ? by : (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * Where the next page starts, said in values rather than as a document.
 *
 * The plain feed can resume from the last document it handed out, because it
 * ran one query. A merged feed cannot: the document that ended the page is in
 * one of the runs and means nothing to the others, so every run has to be
 * resumed from the same pair of values instead.
 */
export function cursorOf(page: Ranked[], pageSize: number, sort: Sort): string | null {
  if (page.length < pageSize) {
    return null;
  }
  const last = page[page.length - 1];
  return `${sort === "popular" ? last.takeCount : last.updatedAt}:${last.id}`;
}

export interface Cursor {
  value: number;
  id: string;
}

/** A cursor we did not write, or one somebody edited, starts from the top. */
export function readCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string") {
    return null;
  }
  const at = raw.indexOf(":");
  const value = Number(raw.slice(0, at));
  const id = raw.slice(at + 1);
  return at > 0 && Number.isFinite(value) && id.length > 0 ? { value, id } : null;
}
