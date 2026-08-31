/**
 * When a complaint takes a list out of the feed, and when it stops being able
 * to. Pure, like the rest of the deciding here; `community.ts` does the writes.
 */
/** Five, because five is what a person reads before choosing at random. */
export const REPORT_REASONS = [
  "sexual",
  "violence",
  "hate",
  "spam",
  "other",
] as const;
export type Reason = (typeof REPORT_REASONS)[number];

/**
 * How many people have to complain before a list goes out of the feed while
 * somebody looks at it.
 *
 * Three, so that one person cannot silence anybody they dislike — except for
 * the one complaint that cannot wait for a second opinion. A list reported as
 * sexual content is the case the whole system exists for, and three strangers
 * seeing it first is three too many.
 */
export const REPORTS_BEFORE_HIDING = 3;
export const HIDES_ON_FIRST: Reason = "sexual";

export interface HideInput {
  reasons: Reason[];
  /** True once somebody has looked at this snapshot and left it up. */
  reviewed: boolean;
}

/**
 * Whether this list should be out of the feed right now.
 *
 * A snapshot that has been looked at and kept is never hidden again, however
 * many complaints arrive afterwards. Without that, anyone with three accounts
 * could keep a list they disliked invisible for ever, and the reviewing would
 * mean nothing. The complaints still arrive and are still shown -- the queue
 * is how somebody notices a list being reported over and over -- they simply
 * no longer act on their own.
 *
 * Reviewing is per snapshot, not per person: republishing makes a new one, and
 * a new one has not been looked at. Otherwise one approval would be a shield
 * to hide anything behind afterwards.
 */
export function decideHide({ reasons, reviewed }: HideInput): boolean {
  if (reviewed) return false;
  if (reasons.includes(HIDES_ON_FIRST)) return true;
  return reasons.length >= REPORTS_BEFORE_HIDING;
}

export interface QueuedReport {
  listId: string;
  listTitle: string;
  authorName: string;
  reason: Reason;
  note: string | null;
  createdAtMs: number;
}

export interface QueuedList {
  listId: string;
  listTitle: string;
  authorName: string;
  /** Newest first, because the last thing said is the most useful. */
  reasons: Reason[];
  notes: string[];
  reportCount: number;
  /** When the most recent complaint arrived. The queue is ordered by it. */
  newestAtMs: number;
  hidden: boolean;
  reviewed: boolean;
}

/**
 * The queue, one row per list rather than one per complaint.
 *
 * The decision is about a list, so the row is a list. Three people complaining
 * about one board used to arrive as three rows with the same title and the same
 * two buttons, and pressing either of them answered all three anyway.
 *
 * How many complained is not lost, because it is the useful part: it is the
 * difference between one person taking offence and a queue forming.
 */
export function groupReports(
  reports: QueuedReport[],
  state: Map<string, { hidden: boolean; reviewed: boolean }>,
): QueuedList[] {
  const byList = new Map<string, QueuedReport[]>();
  for (const report of reports) {
    const kept = byList.get(report.listId);
    if (kept) kept.push(report);
    else byList.set(report.listId, [report]);
  }

  return [...byList.values()]
    .map((filed) => {
      const newest = [...filed].sort((a, b) => b.createdAtMs - a.createdAtMs);
      const known = state.get(newest[0].listId) ?? { hidden: false, reviewed: false };
      return {
        listId: newest[0].listId,
        listTitle: newest[0].listTitle,
        authorName: newest[0].authorName,
        reasons: newest.map((one) => one.reason),
        notes: newest.map((one) => one.note).filter((note): note is string => note !== null),
        reportCount: newest.length,
        newestAtMs: newest[0].createdAtMs,
        hidden: known.hidden,
        reviewed: known.reviewed,
      };
    })
    .sort((a, b) => {
      // A list nobody can see is waiting on this queue in a way the others are
      // not: until somebody looks, its author is being punished by three
      // strangers. Those come first however old they are.
      if (a.hidden !== b.hidden) return a.hidden ? -1 : 1;
      return b.newestAtMs - a.newestAtMs;
    });
}
