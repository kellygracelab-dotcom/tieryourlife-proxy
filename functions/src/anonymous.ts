/**
 * Lists published without a name. The author is still stored, because they
 * still own the list; what goes out to everybody else is nobody. Pure, like
 * the rest of the deciding here; `community.ts` does the reads.
 */

export interface Authored {
  authorUid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  anonymous?: boolean;
}

export interface ShownAuthor {
  authorUid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  anonymous: boolean;
}

export function isAnonymous(list: { anonymous?: unknown }): boolean {
  return list.anonymous === true;
}

/** Only `true` asks for it; anything else is a list with its author's name on it. */
export function readAnonymous(value: unknown): boolean {
  return value === true;
}

/** Who a list is by, as everybody but its author is told. */
export function shownAuthor(list: Authored): ShownAuthor {
  if (isAnonymous(list)) return { authorUid: "", authorName: "", authorPhotoUrl: null, anonymous: true };
  return { authorUid: list.authorUid, authorName: list.authorName, authorPhotoUrl: list.authorPhotoUrl ?? null, anonymous: false };
}

/** Who a list is by, as its own author is told: themselves, and whether it goes out without their name. */
export function ownAuthor(list: Authored): ShownAuthor {
  return {
    authorUid: list.authorUid,
    authorName: list.authorName,
    authorPhotoUrl: list.authorPhotoUrl ?? null,
    anonymous: isAnonymous(list),
  };
}

/** How many reads one page may take to fill itself past rows it does not show. */
export const MAX_FILL_ROUNDS = 5;

/**
 * A page of the rows `keep` lets through, read in pages of the same size
 * until it is full or the rows run out. A page carries on from its last
 * shown row, never from a hidden one: a cursor that named an anonymous list
 * on its author's page would say whose it is. Rows hidden for longer than
 * `rounds` reads end the answer rather than costing more.
 */
export async function fillVisible<T>(
  fetch: (after: T | null) => Promise<T[]>,
  keep: (row: T) => boolean,
  pageSize: number,
  rounds: number = MAX_FILL_ROUNDS,
): Promise<{ rows: T[]; more: boolean }> {
  const rows: T[] = [];
  let after: T | null = null;
  for (let round = 0; round < rounds; round++) {
    const read = await fetch(after);
    for (const row of read) {
      if (!keep(row)) continue;
      rows.push(row);
      if (rows.length === pageSize) return { rows, more: true };
    }
    if (read.length < pageSize) return { rows, more: false };
    after = read[read.length - 1];
  }
  return { rows, more: rows.length > 0 };
}
