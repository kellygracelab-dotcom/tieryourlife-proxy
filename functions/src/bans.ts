/**
 * Who may not publish, and until when. Pure: `community.ts` reads and writes
 * the documents. A ban is on publishing and nothing else: boards, ranking and
 * the account stay.
 */

/** How long a ban can be, in the moderator's words. */
export const BAN_LENGTHS = ["week", "month", "three_months", "six_months", "forever"] as const;

export type BanLength = (typeof BAN_LENGTHS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Months as thirty days: a ban is a length of time, not a date in a diary. */
const LENGTH_IN_DAYS: Record<Exclude<BanLength, "forever">, number> = {
  week: 7,
  month: 30,
  three_months: 90,
  six_months: 180,
};

export interface Ban {
  /** When it lifts, or null for one that does not. */
  until: number | null;
  bannedAt: number;
  /** The complaint that led here, for the moderator's own memory. */
  reason: string | null;
}

export function isBanLength(value: unknown): value is BanLength {
  return typeof value === "string" && (BAN_LENGTHS as readonly string[]).includes(value);
}

/** The ban a moderator's choice makes, starting now. */
export function banFrom(length: BanLength, nowMs: number, reason: string | null): Ban {
  return {
    until: length === "forever" ? null : nowMs + LENGTH_IN_DAYS[length] * DAY_MS,
    bannedAt: nowMs,
    reason,
  };
}

/**
 * Expiry is decided when somebody tries to publish rather than by a sweep:
 * a job that has not run yet would keep somebody banned past their time.
 */
export function isBanned(ban: Ban | null, nowMs: number): ban is Ban {
  if (ban === null) return false;
  return ban.until === null || ban.until > nowMs;
}

/** What the app is told, so it can say when rather than only that. */
export interface BanNotice {
  code: "BANNED";
  until: number | null;
}

export function noticeFor(ban: Ban): BanNotice {
  return { code: "BANNED", until: ban.until };
}
