/**
 * The "New from the community" row above Popular (Marketing's decision, 23.11.2026,
 * `_coordination/community-order-2026-11-23/DECISION.md`, with the coordinator's amendment).
 * Pure: `community.ts` reads the lists and the bans, this decides which go out and in what order,
 * once for the website and the app alike.
 *
 * The numbers are where it starts; they are looked at again after two or three weeks of `home.fresh`
 * and of the takes people's lists get.
 */

import { EDITORIAL_UID } from "./editorial";

/** How far back a publication counts as new. */
export const FRESH_DAYS = 14;
/** Publications read a page at a time, newest first; the rules below are applied to them in memory. */
export const FRESH_READ = 60;
/** The most pages read: the house publishes in batches, which must not push people's lists out of reach. */
export const FRESH_PAGES = 5;
/** The most the row holds: a shop window, not a feed, so no pages. */
export const FRESH_MAX = 12;
/** The most one author has in the row; authors take turns. */
export const FRESH_PER_AUTHOR = 3;
export const FRESH_MIN_CARDS = 8;
/** The share of cards that must have a picture. */
export const FRESH_PICTURE_SHARE = 0.8;
/** Without a cover, the collage needs this many pictures. */
export const FRESH_MIN_PREVIEWS = 4;

export interface FreshCandidate {
  authorUid: string;
  anonymous?: boolean;
  underReview?: boolean;
  /** Waiting for approval (src/feedApproval.ts): in no feed yet. */
  awaitingApproval?: boolean;
  items?: unknown[];
  coverImageUrl?: string | null;
  previewImages?: string[];
}

const isWebPicture = (value: unknown): boolean => typeof value === "string" && value.startsWith("https://");

/** Whether a list may be in the row, its author's ban aside: a person's, named, in the feed, and looking like something. */
export function freshEligible(list: FreshCandidate): boolean {
  if (list.authorUid === EDITORIAL_UID || list.anonymous === true || list.underReview === true || list.awaitingApproval === true) return false;
  const items = Array.isArray(list.items) ? list.items : [];
  if (items.length < FRESH_MIN_CARDS) return false;
  const pictured = items.filter((item) => isWebPicture((item as { imageUrl?: unknown } | null)?.imageUrl)).length;
  if (pictured < FRESH_PICTURE_SHARE * items.length) return false;
  const previews = (list.previewImages ?? []).filter(isWebPicture).length;
  return isWebPicture(list.coverImageUrl) || previews >= FRESH_MIN_PREVIEWS;
}

/**
 * The row from eligible lists given newest publication first: at most FRESH_PER_AUTHOR of each
 * author's newest, then every author's newest, then every author's second, and so on, each turn
 * with the most recently publishing author first, cut to FRESH_MAX. One busy author cannot take
 * the whole top.
 */
export function freshRow<T extends { authorUid: string }>(newestFirst: readonly T[]): T[] {
  const byAuthor = new Map<string, T[]>();
  for (const list of newestFirst) {
    const own = byAuthor.get(list.authorUid) ?? [];
    if (own.length < FRESH_PER_AUTHOR) own.push(list);
    byAuthor.set(list.authorUid, own);
  }
  const turns: T[] = [];
  for (let turn = 0; turn < FRESH_PER_AUTHOR; turn++) {
    for (const own of byAuthor.values()) if (own[turn] !== undefined) turns.push(own[turn]!);
  }
  // The authors were met newest publication first, so every turn is already in that order.
  return turns.slice(0, FRESH_MAX);
}
