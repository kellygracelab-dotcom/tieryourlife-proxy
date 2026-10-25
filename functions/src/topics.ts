/**
 * Topics: a word of somebody's own inside one of the nine sections. A new one
 * waits for a moderator; until then its lists sit under "other" with the topic
 * as a label everyone can see. Pure, like the rest of the deciding here;
 * `community.ts` does the reads and writes.
 */
import { CATEGORIES, type Category } from "./publishing";

export const MIN_TOPIC_NAME_LENGTH = 2;
export const MAX_TOPIC_NAME_LENGTH = 40;

/** Three, so one account cannot fill the queue while its first word is still being read. */
export const MAX_PENDING_TOPICS_PER_ACCOUNT = 3;

export const TOPICS_PAGE_SIZE = 20;
export const MAX_TOPICS_PAGE_SIZE = 50;

/** How many approved topics a pending one is compared with in the queue. */
export const SIMILAR_TOPICS = 3;

/** Where a list sits while its topic is still waiting. */
export const HOLDING_SECTION: Category = "other";

export const TOPIC_STATUSES = ["pending", "approved", "rejected", "merged"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/** A topic as the deciding here needs to see it. */
export interface KnownTopic {
  id: string;
  name: string;
  nameLower: string;
  status: TopicStatus;
  section: Category | null;
  createdBy: string;
}

/** A topic as the app receives it. */
export interface Topic {
  id: string;
  name: string;
  section: Category | null;
  status: TopicStatus;
  listCount: number;
  followerCount: number;
  following: boolean;
  createdBy: string;
  mergedInto: string | null;
}

/**
 * Collapsed and trimmed, two to forty characters, and something in it that is
 * a letter or a digit: a name that is only punctuation names nothing.
 */
export function cleanTopicName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length < MIN_TOPIC_NAME_LENGTH || collapsed.length > MAX_TOPIC_NAME_LENGTH) return null;
  return /[\p{L}\p{N}]/u.test(collapsed) ? collapsed : null;
}

/** A Firestore id, near enough: this string is used to address a document. */
export function isTopicId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export type TopicRequest =
  | { kind: "none" }
  | { kind: "existing"; topicId: string }
  | { kind: "new"; name: string; nameLower: string };

export type TopicRequestRefusal = "both" | "bad_name" | "bad_id";

/** What a publication asks for about its topic: nothing, one that exists, or a new word. */
export function readTopicRequest(
  topicId: unknown,
  newTopic: unknown,
): { ok: true; request: TopicRequest } | { ok: false; reason: TopicRequestRefusal } {
  const hasId = topicId !== undefined && topicId !== null && topicId !== "";
  const hasName = newTopic !== undefined && newTopic !== null && newTopic !== "";
  if (hasId && hasName) return { ok: false, reason: "both" };
  if (hasId) {
    return isTopicId(topicId) ? { ok: true, request: { kind: "existing", topicId } } : { ok: false, reason: "bad_id" };
  }
  if (hasName) {
    const name = cleanTopicName(newTopic);
    return name ? { ok: true, request: { kind: "new", name, nameLower: name.toLowerCase() } } : { ok: false, reason: "bad_name" };
  }
  return { ok: true, request: { kind: "none" } };
}

export type Attachment =
  | { kind: "none" }
  /** An approved topic carries its section; a pending one holds the list under "other". */
  | { kind: "attach"; topic: KnownTopic; category: Category }
  | { kind: "create"; name: string; nameLower: string; requestedSection: Category; category: Category }
  | { kind: "refuse"; reason: "bad_id" | "not_available" | "too_many_pending" };

export interface AttachmentInput {
  request: TopicRequest;
  /** The section the author chose for the list. */
  chosenCategory: Category;
  callerUid: string;
  /** The topic named by id, when one was. */
  byId: KnownTopic | null;
  /** An approved topic with exactly this name, when a new one was asked for. */
  approvedByName: KnownTopic | null;
  /** The caller's own pending topic with exactly this name, when a new one was asked for. */
  ownPendingByName: KnownTopic | null;
  /** How many topics of the caller's are still waiting. */
  pendingCount: number;
}

/**
 * Which topic a publication lands in. A name that already is an approved topic
 * joins it rather than queueing a twin; the caller's own pending word is
 * reused rather than queued twice; anybody else's pending word, or a rejected
 * or merged one, is not theirs to use.
 */
export function decideAttachment(input: AttachmentInput): Attachment {
  const { request } = input;
  if (request.kind === "none") return { kind: "none" };

  if (request.kind === "existing") {
    const topic = input.byId;
    if (!topic) return { kind: "refuse", reason: "bad_id" };
    if (topic.status === "approved") return { kind: "attach", topic, category: topic.section ?? input.chosenCategory };
    if (topic.status === "pending" && topic.createdBy === input.callerUid) {
      return { kind: "attach", topic, category: HOLDING_SECTION };
    }
    return { kind: "refuse", reason: "not_available" };
  }

  if (input.approvedByName) {
    const topic = input.approvedByName;
    return { kind: "attach", topic, category: topic.section ?? input.chosenCategory };
  }
  if (input.ownPendingByName) {
    return { kind: "attach", topic: input.ownPendingByName, category: HOLDING_SECTION };
  }
  if (input.pendingCount >= MAX_PENDING_TOPICS_PER_ACCOUNT) {
    return { kind: "refuse", reason: "too_many_pending" };
  }
  return {
    kind: "create",
    name: request.name,
    nameLower: request.nameLower,
    requestedSection: input.chosenCategory,
    category: HOLDING_SECTION,
  };
}

/** The first word of a name, lower-cased: what a moderator would type to look for twins. */
export function firstWordOf(name: string): string {
  return name.trim().toLowerCase().split(" ")[0] ?? "";
}

/**
 * Approved topics a pending one might be a twin of: those whose names start
 * with its first word, a few of them, itself left out.
 */
export function similarTopics(pending: KnownTopic, approved: KnownTopic[]): KnownTopic[] {
  const word = firstWordOf(pending.name);
  if (word.length === 0) return [];
  return approved
    .filter((topic) => topic.id !== pending.id && topic.status === "approved" && topic.nameLower.startsWith(word))
    .slice(0, SIMILAR_TOPICS);
}

/** How many topics one answer carries: twenty unless asked, never more than fifty. */
export function topicsPageSize(raw: unknown): number {
  const asked = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(asked) || asked < 1) return TOPICS_PAGE_SIZE;
  return Math.min(Math.trunc(asked), MAX_TOPICS_PAGE_SIZE);
}

export const TOPIC_ACTIONS = ["approve", "rename", "merge", "reject"] as const;
export type TopicAction = (typeof TOPIC_ACTIONS)[number];

export interface TopicActionInput {
  section?: unknown;
  name?: unknown;
  into?: KnownTopic | null;
}

export type TopicOutcome =
  | {
      ok: true;
      /** What changes on the topic itself. */
      topic: Partial<Pick<KnownTopic, "name" | "nameLower" | "section" | "status">> & { mergedInto?: string };
      /** What changes on every list carrying it. */
      lists: Record<string, string | null>;
      /** Whether this settles the topic, so the moderator and the time are written down. */
      decided: boolean;
    }
  | { ok: false; reason: "no_section" | "bad_name" | "settled" | "no_target" | "target_not_approved" | "itself" };

/**
 * What a moderator's word does, as data. Approving and rejecting are for a
 * topic still waiting; renaming and merging also for one already approved. A
 * merge needs an approved target that is not the topic itself.
 */
export function decideTopicAction(action: TopicAction, topic: KnownTopic, input: TopicActionInput): TopicOutcome {
  const open = topic.status === "pending" || topic.status === "approved";
  switch (action) {
    case "approve": {
      if (topic.status !== "pending") return { ok: false, reason: "settled" };
      const section = CATEGORIES.find((known) => known === input.section);
      if (!section) return { ok: false, reason: "no_section" };
      return { ok: true, topic: { status: "approved", section }, lists: { category: section }, decided: true };
    }
    case "rename": {
      if (!open) return { ok: false, reason: "settled" };
      const name = cleanTopicName(input.name);
      if (!name) return { ok: false, reason: "bad_name" };
      return { ok: true, topic: { name, nameLower: name.toLowerCase() }, lists: { topicName: name }, decided: false };
    }
    case "merge": {
      if (!open) return { ok: false, reason: "settled" };
      const into = input.into ?? null;
      if (!into) return { ok: false, reason: "no_target" };
      if (into.id === topic.id) return { ok: false, reason: "itself" };
      if (into.status !== "approved" || into.section === null) return { ok: false, reason: "target_not_approved" };
      return {
        ok: true,
        topic: { status: "merged", mergedInto: into.id },
        lists: { topicId: into.id, topicName: into.name, category: into.section },
        decided: true,
      };
    }
    case "reject": {
      if (topic.status !== "pending") return { ok: false, reason: "settled" };
      return { ok: true, topic: { status: "rejected" }, lists: { topicId: null, topicName: null }, decided: true };
    }
  }
}

/** Pending first, then newest first: the queue a person has standing in it reads top to bottom. */
export function orderMine<T extends { status: TopicStatus; createdAtMs: number }>(topics: T[]): T[] {
  return [...topics].sort((left, right) => {
    const leftPending = left.status === "pending" ? 0 : 1;
    const rightPending = right.status === "pending" ? 0 : 1;
    if (leftPending !== rightPending) return leftPending - rightPending;
    return right.createdAtMs - left.createdAtMs;
  });
}
