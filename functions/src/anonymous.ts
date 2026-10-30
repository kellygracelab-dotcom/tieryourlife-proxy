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

/** What a publish says about it: true or false when it says, null when it says nothing a boolean. */
export function readAnonymous(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Whether a list goes out anonymously after this publish. Saying so decides;
 * saying nothing keeps what a republished list already was, because a phone
 * that has never heard of the flag must not turn an anonymous list public.
 * A new list says nothing and goes out with its author's name.
 */
export function anonymityAfter(asked: boolean | null, previous: { anonymous?: unknown } | null): boolean {
  if (asked !== null) return asked;
  return previous !== null && isAnonymous(previous);
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

/** Who is reading a list: enough to tell whether it is theirs. */
export interface ListReader {
  uid: string;
  isAnonymous: boolean;
}

/**
 * `mine: true` on a list the reader published, judged by the stored author
 * rather than what goes out, which for an anonymous list names nobody.
 * Nothing at all otherwise, and never for a guest, who publishes nothing.
 */
export function mineFor(list: { authorUid: string }, reader: ListReader | null): { mine?: true } {
  return reader !== null && !reader.isAnonymous && reader.uid.length > 0 && list.authorUid === reader.uid ? { mine: true } : {};
}

/**
 * Whether the reader follows the list's author, for a reader signed in and a
 * list with its author's name on it. Nothing at all for a guest, who follows
 * nobody, or for an anonymous list, where the answer would say whose it is.
 */
export function viewerFollowsFor(
  list: { authorUid: string; anonymous?: unknown },
  reader: ListReader | null,
  followed: ReadonlySet<string> | null,
): { viewerFollowsAuthor?: boolean } {
  if (reader === null || reader.isAnonymous || followed === null || isAnonymous(list)) return {};
  return { viewerFollowsAuthor: followed.has(list.authorUid) };
}

/** How many reads one page may take to fill itself past rows it does not show. */
export const MAX_FILL_ROUNDS = 5;

export interface FillOptions {
  rounds?: number;
  /**
   * When the reads run out before the page is full, carry on next time from
   * the last row read, shown or not. Right where a hidden row's id says
   * nothing about anybody; wrong on an author's page, where it would.
   */
  resumeFromHidden?: boolean;
}

/**
 * A page of the rows `keep` lets through, read in pages of the same size
 * until it is full or the rows run out, and the row the next page carries on
 * after, or null when there is nothing more. Unless told otherwise that row
 * is one the page shows, never a hidden one: a cursor that named an
 * anonymous list on its author's page would say whose it is.
 */
export async function fillVisible<T>(
  fetch: (after: T | null) => Promise<T[]>,
  keep: (row: T) => boolean,
  pageSize: number,
  options: FillOptions = {},
): Promise<{ rows: T[]; next: T | null }> {
  const rounds = options.rounds ?? MAX_FILL_ROUNDS;
  const rows: T[] = [];
  let after: T | null = null;
  for (let round = 0; round < rounds; round++) {
    const read = await fetch(after);
    for (const row of read) {
      if (!keep(row)) continue;
      rows.push(row);
      if (rows.length === pageSize) return { rows, next: row };
    }
    if (read.length < pageSize) return { rows, next: null };
    after = read[read.length - 1];
  }
  if (options.resumeFromHidden) return { rows, next: after };
  return { rows, next: rows.length > 0 ? rows[rows.length - 1] : null };
}
