/**
 * What the owner and the moderators did, kept so a decision can be looked up
 * later and answered for. Pure: `community.ts` writes each entry beside the
 * change it records, in the same batch or transaction where it can.
 */

export const AUDIT_ACTIONS = [
  "section.approve",
  "section.decline",
  "section.merge",
  "section.create",
  "section.edit",
  "section.order",
  "section.delete",
  "section.approve_as_topic",
  "topic.create",
  "topic.edit",
  "topic.merge",
  "topic.delete",
  "topic.approve",
  "topic.reject",
  "moderator.appoint",
  "moderator.remove",
  "report.takedown",
  "report.dismiss",
  "ban.set",
  "list.move",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  who: string;
  role: string;
  what: AuditAction;
  /** `collection/id` of the thing changed. */
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Bookkeeping, or addresses that work as keys: never worth a line in the log,
 * and a proposal picture's address would hand its token to whoever reads it.
 */
export const NOT_AUDITED: readonly string[] = [
  "unfinished",
  "proposalPicture",
  "proposalPictureUrl",
  "updatedAt",
  "approvedAt",
  "decidedAt",
  "decidedBy",
  "dismissedAt",
  "createdAt",
  "nameLower",
  "titleLower",
];

/** A value Firestore will store as it is: not a sentinel like a server timestamp or an increment. */
function isPlain(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPlain);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value as object).every(isPlain);
}

/**
 * Only what a change changes: the fields `after` sets to a value other than
 * the one `before` held, each side with just those. Nothing changed is null
 * on both sides.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (NOT_AUDITED.includes(key) || !isPlain(value)) continue;
    const previous = before?.[key] ?? null;
    if (JSON.stringify(previous) === JSON.stringify(value)) continue;
    was[key] = previous;
    now[key] = value;
  }
  if (Object.keys(now).length === 0) return { before: null, after: null };
  return { before: before === null ? null : was, after: now };
}

/** The log lines about one person, by the document they were made about. */
export function auditTargetsOf(uid: string): string[] {
  return [`roles/${uid}`, `bans/${uid}`];
}

/** One side of a log line without the person's name in it. */
export function withoutNames(side: unknown): Record<string, unknown> | null {
  if (typeof side !== "object" || side === null) return null;
  const kept = { ...(side as Record<string, unknown>) };
  delete kept.name;
  return kept;
}

export function auditEntry(
  who: string,
  role: string,
  what: AuditAction,
  target: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditEntry {
  return { who, role, what, target, before, after };
}
