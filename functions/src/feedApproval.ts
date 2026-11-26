/**
 * Approval before the feed (Danylo, 26.11.2026). A new list of an ordinary account waits for the owner
 * or a moderator before it reaches any feed: New, sections and topics, search, Following, the fresh row,
 * a section's collage, suggested authors. Its address opens it at once and its author may share it. An
 * Update of a list does not wait again; the owner's, a moderator's and the house's lists never wait.
 *
 * This is not `underReview`: that one answers its address with 404 and stays for reports and holds.
 *
 * The switch is `config/feedApproval` `{on: boolean}`, read at most every [SWITCH_READ_MS] per instance;
 * no document means on (under the demo emulators it means off and is read every time, so the website's
 * and the app's suites against this proxy see their lists in the feed; a test turns it on). Off, new
 * lists go straight to the feed; lists already waiting stay in the queue
 * until approved or taken down. Lists published before 26.11.2026 have no mark and count as approved.
 */

import { getFirestore } from "firebase-admin/firestore";
import { isDemoEmulator } from "./emulator";

export const FEED_APPROVAL_SWITCH = "config/feedApproval";
const SWITCH_READ_MS = 30_000;

let known: { readAtMs: number; on: boolean } | null = null;

/** Whether new lists wait for approval now. A switch that cannot be read is on: the cautious side. */
export async function feedApprovalOn(nowMs: number = Date.now(), demo: boolean = isDemoEmulator()): Promise<boolean> {
  if (!demo && known && nowMs - known.readAtMs < SWITCH_READ_MS) return known.on;
  const doc = await getFirestore().doc(FEED_APPROVAL_SWITCH).get().catch(() => null);
  const on = doc === null ? true : doc.exists ? doc.get("on") !== false : !demo;
  known = { readAtMs: nowMs, on };
  return on;
}

/** Forgets the switch this instance read; for tests. */
export function forgetFeedApproval(): void {
  known = null;
}

/** Whether a list waits for approval: marked so when it was published, and not approved since. */
export function awaitsApproval(list: { awaitingApproval?: unknown }): boolean {
  return list.awaitingApproval === true;
}

/** Whether a list may be shown in a feed: not hidden after reports, and not waiting for approval. */
export function inFeeds(list: { underReview?: unknown; awaitingApproval?: unknown }): boolean {
  return list.underReview !== true && !awaitsApproval(list);
}

/**
 * Whether a list published now waits: a new list of an ordinary account (not the house's, not by the
 * owner or a moderator) while the switch is on.
 */
export function waitsOnPublish(on: boolean, newPersonalList: boolean, staff: boolean): boolean {
  return on && newPersonalList && !staff;
}

/**
 * One log line for anything staff should look at: a report, a flag on a list's words, a list waiting
 * for approval. Its `message` is `COMMUNITY_REVIEW`, for an alert on the logs (the owner's to set up).
 * No names, no text: what kind, and which list.
 */
export function noteCommunityReview(kind: "report" | "wording" | "approval", listId: string): void {
  console.log(JSON.stringify({ severity: "NOTICE", message: "COMMUNITY_REVIEW", kind, listId }));
}
