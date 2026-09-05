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
 * Three, so one person cannot silence anybody they dislike -- except the one
 * complaint that cannot wait: a list reported as sexual content.
 */
export const REPORTS_BEFORE_HIDING = 3;
export const HIDES_ON_FIRST: Reason = "sexual";

export interface HideInput {
  reasons: Reason[];
  /** True once somebody has looked at this snapshot and left it up. */
  reviewed: boolean;
}

/**
 * A snapshot that has been looked at and kept is never hidden again, or three
 * accounts could keep a list invisible for ever; the complaints still arrive
 * and are shown. Reviewing is per snapshot: republishing makes a new one, or
 * one approval would be a shield to hide anything behind.
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

export interface ListStanding {
  hidden: boolean;
  reviewed: boolean;
  /**
   * The picture the list shows in the feed, so a moderator can see what was
   * complained about without opening it. The whole complaint is often the
   * picture; making somebody travel to it is making them decide blind.
   */
  coverImageUrl: string | null;
  authorUid: string | null;
  authorPhotoUrl: string | null;
}

export interface QueuedList {
  listId: string;
  listTitle: string;
  authorName: string;
  authorUid: string | null;
  authorPhotoUrl: string | null;
  coverImageUrl: string | null;
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
 * One row per list rather than per complaint: the decision is about a list.
 * How many complained is kept, being the difference between one person
 * taking offence and a queue forming.
 */
export function groupReports(
  reports: QueuedReport[],
  state: Map<string, ListStanding>,
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
      const known = state.get(newest[0].listId) ?? {
        hidden: false,
        reviewed: false,
        coverImageUrl: null,
        authorUid: null,
        authorPhotoUrl: null,
      };
      return {
        listId: newest[0].listId,
        listTitle: newest[0].listTitle,
        authorName: newest[0].authorName,
        authorUid: known.authorUid,
        authorPhotoUrl: known.authorPhotoUrl,
        coverImageUrl: known.coverImageUrl,
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
