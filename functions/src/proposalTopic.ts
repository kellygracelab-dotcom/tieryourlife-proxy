/**
 * A section proposal approved as a topic instead: the word is good, but it
 * belongs inside a section that exists rather than beside it. Pure, like the
 * rest of the deciding here; `community.ts` does the reads and writes.
 */
import { isOpen, reservationClash, type NameClash, type NameReservation, type SectionRecord } from "./sections";
import {
  cleanTopicName,
  isTopicId,
  readTopicNames,
  topicReservationClash,
  type KnownTopic,
  type TopicReservation,
} from "./topics";

export type ApproveAsTopic =
  | { ok: true; resume: false; section: string; name: string; nameLower: string; names: Record<string, string> }
  /** Already decided; only the lists waiting for it are left to move. */
  | { ok: true; resume: true; section: string; topicId: string }
  | { ok: false; reason: "missing" | "settled" | "bad_section" | "bad_name" };

/**
 * Whether a proposal can become a topic: one still waiting, into an open
 * section, under its own name or a better one, with any translations. A
 * proposal already turned into a topic but whose lists are not all moved yet
 * is finished when the call names the same section, so asking again
 * completes the job; any other section is too late.
 */
export function decideApproveAsTopic(
  proposal: SectionRecord | null,
  section: SectionRecord | null,
  body: unknown,
): ApproveAsTopic {
  if (proposal === null || proposal.builtIn) return { ok: false, reason: "missing" };
  const resume = halfDone(proposal);
  if (resume !== null) {
    return section?.id === resume.section ? { ok: true, resume: true, ...resume } : { ok: false, reason: "settled" };
  }
  if (proposal.status !== "pending") return { ok: false, reason: "settled" };
  if (section === null || !isOpen(section)) return { ok: false, reason: "bad_section" };
  const source = (body ?? {}) as Record<string, unknown>;
  const name = cleanTopicName(source.name ?? proposal.name);
  if (name === null) return { ok: false, reason: "bad_name" };
  const names = source.names === undefined ? {} : readTopicNames(source.names);
  if (names === null) return { ok: false, reason: "bad_name" };
  return { ok: true, resume: false, section: section.id, name, nameLower: name.toLowerCase(), names };
}

/** A proposal already turned into a topic whose lists are not all moved yet. */
function halfDone(proposal: SectionRecord): { section: string; topicId: string } | null {
  if (proposal.status !== "merged" || !proposal.unfinished) return null;
  if (proposal.mergedTopicId === null || proposal.mergedInto === null) return null;
  return { section: proposal.mergedInto, topicId: proposal.mergedTopicId };
}

export type MergeIntoTopic =
  | { ok: true; resume: boolean; section: string; topicId: string }
  | { ok: false; reason: "missing" | "settled" | "bad_topic" };

/**
 * Whether a proposal can go into a topic that exists: one still waiting, into
 * an approved topic of an open section. Its lists then move as for a topic
 * made from it, so a move cut short finishes the same way, when the call
 * names the same topic.
 */
export function decideMergeIntoTopic(
  proposal: SectionRecord | null,
  topic: KnownTopic | null,
  section: SectionRecord | null,
): MergeIntoTopic {
  if (proposal === null || proposal.builtIn) return { ok: false, reason: "missing" };
  const resume = halfDone(proposal);
  if (resume !== null) {
    return topic?.id === resume.topicId ? { ok: true, resume: true, ...resume } : { ok: false, reason: "settled" };
  }
  if (proposal.status !== "pending") return { ok: false, reason: "settled" };
  if (topic === null || topic.status !== "approved" || topic.section === null) return { ok: false, reason: "bad_topic" };
  if (section === null || section.id !== topic.section || !isOpen(section)) return { ok: false, reason: "bad_topic" };
  return { ok: true, resume: false, section: section.id, topicId: topic.id };
}

/** The topic a merge asks for, if the body names one by a usable id. */
export function mergeTopicId(body: unknown): string | null {
  const topic = ((body ?? {}) as Record<string, unknown>).topic;
  return isTopicId(topic) ? topic : null;
}

/** The form a topic name is reserved by, or null for a name no topic could have. */
export function topicKeyOf(name: string): string | null {
  return cleanTopicName(name)?.toLowerCase() ?? null;
}

/** What was read about one proposal's name: its topic reservation and holder, its section reservation, and the sections either names. */
export interface ClashReads {
  topicReservation: TopicReservation | null;
  topic: KnownTopic | null;
  sectionReservation: NameReservation | null;
  sections: ReadonlyMap<string, SectionRecord>;
}

/**
 * What a waiting proposal's name already belongs to, by the reservations:
 * an approved topic first, since a proposal can be merged into one, then
 * another open section, which it can be merged into as well. A name held by
 * another proposal still waiting is not offered: there is nothing to merge
 * into yet. A decided proposal clashes with nothing.
 */
export function nameClashOf(proposal: SectionRecord, reads: ClashReads): NameClash {
  if (proposal.status !== "pending") return null;
  const key = topicKeyOf(proposal.name);
  const topic = reads.topic;
  if (key !== null && topic !== null && topic.status === "approved" && topicReservationClash(key, reads.topicReservation, topic, null) !== null) {
    const sectionName = topic.section === null ? null : reads.sections.get(topic.section)?.name ?? null;
    return { kind: "topic", id: topic.id, name: topic.name, section: topic.section, sectionName };
  }
  const reservations = reads.sectionReservation === null ? [] : [reads.sectionReservation];
  const holder = reservationClash([proposal.name], reservations, reads.sections, proposal.id);
  const section = holder === null ? undefined : reads.sections.get(holder);
  return section === undefined || !isOpen(section) ? null : { kind: "section", id: section.id, name: section.name };
}
