import { ownPictureIdOf } from "./publishing";

/**
 * Rules for which stored pictures are still somebody's. Pure, like the rest of
 * the deciding in this repo; `sweepPictures` does the listing and deleting.
 */

/**
 * A picture that nothing points at is not necessarily rubbish -- it may have
 * arrived seconds ago, with the board that mentions it still on its way up.
 * Nothing is touched until it has had a day to be claimed.
 */
export const UNCLAIMED_GRACE_MS = 24 * 60 * 60 * 1000;

/** The account's own picture ids a stored board points at: cards, the cover, and own pictures named by address. */
export function picturesOfBoard(board: Record<string, unknown>, uid: string): string[] {
  const ids: string[] = [];
  const byAddress = (url: unknown) => {
    if (typeof url !== "string") return;
    let id: string | null = null;
    try {
      id = ownPictureIdOf(url, uid);
    } catch {
      id = null;
    }
    if (id !== null) ids.push(id);
  };
  const items = Array.isArray(board.items) ? (board.items as { pictureId?: unknown; imageUrl?: unknown }[]) : [];
  for (const item of items) {
    if (typeof item.pictureId === "string" && item.pictureId) ids.push(item.pictureId);
    byAddress(item.imageUrl);
  }
  if (typeof board.coverPictureId === "string" && board.coverPictureId) ids.push(board.coverPictureId);
  byAddress(board.coverImageUrl);
  if (Array.isArray(board.coverImageUrls)) board.coverImageUrls.forEach(byAddress);
  return ids;
}

/**
 * How long an own picture no kept board names stays before it goes (20.11.2026). A board can live only on
 * a device -- not yet synced, kept offline, or beyond the account's limit -- and the server never sees it;
 * deleting its pictures after a day left those cards empty. The sweep marks such a picture first
 * (`retiredAt`, as published copies are marked) and removes it this long after, if still nothing names it.
 */
export const UNCLAIMED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredPicture {
  id: string;
  uploadedAtMs: number;
  /** When the sweep first found nothing naming it; null while something does, or before it looked. */
  retiredAtMs: number | null;
}

export interface SweepDecision {
  /** Nothing names these now: mark them, and keep them. */
  retire: string[];
  /** Named again: drop the mark. */
  unretire: string[];
  /** Marked at least [UNCLAIMED_KEEP_MS] ago and named by nothing since. */
  remove: string[];
}

/**
 * What the daily sweep does with an account's pictures.
 *
 * [referenced] is every picture id named by any of that account's boards,
 * including the ones in its trash -- a board somebody threw away can be
 * restored for thirty days, and restoring it to a set of blank tiles is not
 * restoring it. [atLimit]: the account keeps as many boards as it may, so
 * any more live only on its devices; nothing of it is removed then.
 */
export function decideSweep(stored: StoredPicture[], referenced: Set<string>, nowMs: number, atLimit: boolean): SweepDecision {
  const decision: SweepDecision = { retire: [], unretire: [], remove: [] };
  for (const picture of stored) {
    if (referenced.has(picture.id)) {
      if (picture.retiredAtMs !== null) decision.unretire.push(picture.id);
    } else if (picture.retiredAtMs === null) {
      if (nowMs - picture.uploadedAtMs >= UNCLAIMED_GRACE_MS) decision.retire.push(picture.id);
    } else if (!atLimit && nowMs - picture.retiredAtMs >= UNCLAIMED_KEEP_MS) {
      decision.remove.push(picture.id);
    }
  }
  return decision;
}
