/**
 * Likes on the rankings of a list, and the order they put the rankings sheet
 * in: the list's author first, then the people who ranked it, the most liked
 * first and the newest first among equals. How many likes a ranking has is
 * never told to anybody, only whether the reader gave one. Pure, like the
 * rest of the deciding; `community.ts` does the reads and writes.
 */

import { shownAuthor } from "./anonymous";
import { rowsFromArrangement } from "./rankings";

/** One document per like: `{likerUid}:{rankingDocId}`, so a second like of the same ranking is the same document. */
export const RANKING_LIKES = "rankingLikes";
/** One document per account that likes, holding the times of its recent changes. */
export const LIKE_QUOTA = "likeQuota";
export const LIKES_PER_HOUR = 300;
export const LIKE_WINDOW_MS = 60 * 60 * 1000;
/**
 * How many of a list's rankings are put in order. The order is worked out in
 * memory from three small fields each, so it needs no index of its own; past
 * this, the newest are the ones ordered and the oldest are left out.
 */
export const MAX_RANKINGS_ORDERED = 2000;

export function likeId(likerUid: string, rankingId: string): string {
  return `${likerUid}:${rankingId}`;
}

/** The ranking a reader keeps beside somebody's list. */
export function rankingIdOf(listId: string, uid: string): string {
  return `${listId}_${uid}`;
}

/** Its own folder of picture copies, next to the lists': `published/ranking-{listId}_{uid}/`. */
export function rankingFolderOf(rankingId: string): string {
  return `ranking-${rankingId}`;
}

export type LikeRefusal = "not_signed_in" | "banned" | "missing" | "own" | "author";

/**
 * Who may like a ranking: somebody signed in and not banned, of a ranking that
 * is there on a list everybody can see, and neither their own ranking nor the
 * author's own placing of the list, which is the list itself.
 */
export function likeRefusal(
  caller: { uid: string; isAnonymous: boolean; banned: boolean },
  target: { uid: string; list: { authorUid: string; underReview: boolean } | null; rankingExists: boolean },
): LikeRefusal | null {
  if (caller.isAnonymous) return "not_signed_in";
  if (caller.banned) return "banned";
  if (target.list === null || target.list.underReview) return "missing";
  if (target.uid === caller.uid) return "own";
  if (target.uid === target.list.authorUid) return "author";
  if (!target.rankingExists) return "missing";
  return null;
}

/**
 * The account's changes within the last hour, with this one added; or when
 * the next may be made, once there have been [limit] of them. Only a like
 * given or taken back counts: asking for what is already so changes nothing.
 */
export function likeQuota(
  events: readonly number[],
  nowMs: number,
  limit: number = LIKES_PER_HOUR,
  windowMs: number = LIKE_WINDOW_MS,
): { allowed: true; events: number[] } | { allowed: false; retryAt: number } {
  const recent = events.filter((at) => at > nowMs - windowMs).sort((left, right) => left - right);
  if (recent.length >= limit) return { allowed: false, retryAt: recent[recent.length - limit] + windowMs };
  return { allowed: true, events: [...recent, nowMs] };
}

/** The stored times read back, anything else left out. */
export function readLikeEvents(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((at): at is number => typeof at === "number" && Number.isFinite(at)) : [];
}

/** What ordering a ranking needs to know of it. */
export interface RankingKey {
  id: string;
  likeCount: number;
  seconds: number;
  nanoseconds: number;
}

/** The most liked first; among equals the newest first; among those, by id, so the order never wavers. */
export function compareRankings(left: RankingKey, right: RankingKey): number {
  return right.likeCount - left.likeCount
    || right.seconds - left.seconds
    || right.nanoseconds - left.nanoseconds
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** A stored count read as one: never negative, never anything but a whole number. */
export function readLikeCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

const CURSOR_PREFIX = "r2.";

/**
 * Where the next page carries on: the place of the last ranking shown, not
 * its document, so a ranking withdrawn between pages loses nobody their
 * place. Opaque to clients; only a ranking the page showed is ever in it.
 */
export function likeCursor(last: RankingKey): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify([last.likeCount, last.seconds, last.nanoseconds, last.id]), "utf8").toString("base64url");
}

/** A cursor `likeCursor` wrote, or null for anything else, an older cursor among them. */
export function readLikeCursor(after: string): RankingKey | null {
  if (!after.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(after.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [likeCount, seconds, nanoseconds, id] = parsed;
    const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!whole(likeCount) || !whole(seconds) || !whole(nanoseconds) || typeof id !== "string" || id.length === 0 || id.length > 200) return null;
    return { likeCount, seconds, nanoseconds, id };
  } catch {
    return null;
  }
}

/** One page of the rankings in their order, after [after], and the cursor's place for the next one. */
export function rankingsPage<T extends RankingKey>(rankings: readonly T[], after: RankingKey | null, size: number): { page: T[]; next: T | null } {
  const ordered = [...rankings].sort(compareRankings);
  const from = after === null ? 0 : ordered.findIndex((one) => compareRankings(one, after) > 0);
  const page = from < 0 ? [] : ordered.slice(from, from + size);
  const more = from >= 0 && from + size < ordered.length;
  return { page, next: more ? page[page.length - 1] ?? null : null };
}

/** The list as its author placed it, as much of it as its rankings sheet needs. */
export interface AuthoredList {
  authorUid: string;
  authorName: string;
  authorPhotoUrl?: string | null;
  anonymous?: boolean;
  tiers?: unknown[];
  items?: unknown[];
}

/**
 * The author's own placing, at the head of the sheet: the cards of each tier
 * in the list's order, and an anonymous list's by nobody. `mine` when the
 * author is the one reading; nobody likes it.
 */
export function authorRanking(list: AuthoredList, updatedAtMs: number, reader: { uid: string; isAnonymous: boolean }) {
  const tiers = Array.isArray(list.tiers) ? list.tiers : [];
  const items = Array.isArray(list.items) ? list.items : [];
  const tierOf = (item: unknown): number | null => {
    const tier = (item as { tierIndex?: unknown } | null)?.tierIndex;
    return typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier < tiers.length ? tier : null;
  };
  const arrangement = items.map(tierOf);
  const rows = rowsFromArrangement(arrangement, tiers.length);
  const shown = shownAuthor({ ...list, authorPhotoUrl: list.authorPhotoUrl ?? null });
  return {
    uid: shown.authorUid,
    authorName: shown.authorName,
    authorPhotoUrl: shown.authorPhotoUrl,
    arrangement,
    rows,
    tierLabels: tiers.map((tier) => {
      const label = (tier as { label?: unknown } | null)?.label;
      return typeof label === "string" ? label : "";
    }),
    updatedAtMs,
    mine: !reader.isAnonymous && reader.uid.length > 0 && reader.uid === list.authorUid,
    isAuthor: true,
    likedByMe: false,
  };
}
