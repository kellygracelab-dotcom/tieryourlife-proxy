/**
 * The staff's view of one section's lists: everything in it, lists under
 * review included, narrowed to a topic, to the lists with none, or to the
 * lists whose topic is not one of the section's approved topics. Pure;
 * `community.ts` does the reads.
 */
import { sortOrder, type Sort } from "./follows";
import { isSectionId } from "./sections";
import { isAnonymous } from "./anonymous";
import { isTopicId } from "./topics";

/**
 * A topic, the lists with no topic at all, the lists whose topic is not an
 * approved topic of this section ("other"), or every list of the section.
 */
export type TopicFilter = string | "none" | "other" | null;

export type AdminListsQuery =
  | { ok: true; section: string; topic: TopicFilter; sort: Sort; after: string | null }
  | { ok: false; detail: "section" | "topic" | "after" };

export function readAdminListsQuery(query: Record<string, unknown>): AdminListsQuery {
  if (!isSectionId(query.section)) return { ok: false, detail: "section" };
  const topic = query.topic === undefined || query.topic === "" ? null : query.topic;
  if (topic !== null && !isTopicId(topic)) return { ok: false, detail: "topic" };
  const after = query.after === undefined || query.after === "" ? null : query.after;
  if (after !== null && !isTopicId(after)) return { ok: false, detail: "after" };
  return { ok: true, section: query.section, topic: topic as TopicFilter, sort: sortOrder(query.sort), after: after as string | null };
}

/** Whether a filter is read by the section rather than by one topic. */
export function readsBySection(topic: TopicFilter): boolean {
  return topic === null || topic === "none" || topic === "other";
}

/**
 * Whether a list belongs on the page. A topic's lists are read by topic, so
 * the section is checked here; "none" is a list whose topic is missing or
 * null, and "other" one whose topic is set but not among `approvedHere`, the
 * section's approved topics as far as they were read for this page.
 */
export function adminKeeps(
  list: { category?: unknown; topicId?: unknown },
  section: string,
  topic: TopicFilter,
  approvedHere: ReadonlySet<string> = new Set(),
): boolean {
  if (list.category !== section) return false;
  if (topic === null) return true;
  if (topic === "none") return list.topicId === undefined || list.topicId === null;
  if (topic === "other") return typeof list.topicId === "string" && list.topicId !== "" && !approvedHere.has(list.topicId);
  return list.topicId === topic;
}

/**
 * Who published a list, for the staff. On a list published without its
 * author's name only the owner is told: undoing that is the owner's alone,
 * as it is on the anonymous lists page. A moderator gets null there.
 */
export function publishedByFor(
  list: { authorUid: string; authorName: string; anonymous?: unknown },
  owner: boolean,
): { uid: string; name: string } | null {
  return isAnonymous(list) && !owner ? null : { uid: list.authorUid, name: list.authorName };
}
