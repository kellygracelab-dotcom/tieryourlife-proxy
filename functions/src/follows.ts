/**
 * Who may follow whom, and how a feed of the people you follow is put
 * together. Pure, like the rest of the deciding here; `community.ts` does the
 * reads and writes.
 */

/**
 * Firestore answers `in` with at most thirty values, so a following feed is
 * several queries merged; at two hundred that is seven per page, a fixed and
 * knowable cost.
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
 * Behind an account rather than allowed to guests: a following list has to
 * survive the phone, and a guest is an identity this app sweeps away.
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
 * One page out of several already-sorted runs, merged to keep the ordering
 * the reader was promised. Ties break on id so a page boundary never wobbles
 * and repeats or skips a list.
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
 * Said in values rather than as a document: the document that ended the page
 * is in one run and means nothing to the others.
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
