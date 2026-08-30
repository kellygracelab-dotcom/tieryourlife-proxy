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

export interface StoredPicture {
  id: string;
  uploadedAtMs: number;
}

/**
 * Which of an account's pictures may go.
 *
 * [referenced] is every picture id named by any of that account's boards,
 * including the ones in its trash -- a board somebody threw away can be
 * restored for thirty days, and restoring it to a set of blank tiles is not
 * restoring it.
 */
export function decideDiscard(
  stored: StoredPicture[],
  referenced: Set<string>,
  nowMs: number,
): string[] {
  return stored
    .filter((picture) => !referenced.has(picture.id))
    .filter((picture) => nowMs - picture.uploadedAtMs >= UNCLAIMED_GRACE_MS)
    .map((picture) => picture.id);
}
