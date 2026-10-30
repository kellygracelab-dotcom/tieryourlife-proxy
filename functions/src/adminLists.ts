/**
 * The staff's view of one section's lists: everything in it, lists under
 * review included, narrowed to a topic or to the lists with none. Pure;
 * `community.ts` does the reads.
 */
import { sortOrder, type Sort } from "./follows";
import { isSectionId } from "./sections";
import { isTopicId } from "./topics";

/** A topic, the lists with no topic at all, or every list of the section. */
export type TopicFilter = string | "none" | null;

export type AdminListsQuery =
  | { ok: true; section: string; topic: TopicFilter; sort: Sort; after: string | null }
  | { ok: false; detail: "section" | "topic" | "after" };

export function readAdminListsQuery(query: Record<string, unknown>): AdminListsQuery {
  if (!isSectionId(query.section)) return { ok: false, detail: "section" };
  const topic = query.topic === undefined || query.topic === "" ? null : query.topic === "none" ? "none" : query.topic;
  if (topic !== null && topic !== "none" && !isTopicId(topic)) return { ok: false, detail: "topic" };
  const after = query.after === undefined || query.after === "" ? null : query.after;
  if (after !== null && !isTopicId(after)) return { ok: false, detail: "after" };
  return { ok: true, section: query.section, topic: topic as TopicFilter, sort: sortOrder(query.sort), after: after as string | null };
}

/**
 * Whether a list belongs on the page. A topic's lists are read by topic, so
 * the section is checked here; "none" is a list whose topic is missing or null.
 */
export function adminKeeps(list: { category?: unknown; topicId?: unknown }, section: string, topic: TopicFilter): boolean {
  if (list.category !== section) return false;
  if (topic === null) return true;
  if (topic === "none") return list.topicId === undefined || list.topicId === null;
  return list.topicId === topic;
}
