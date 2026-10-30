/**
 * A section proposal approved as a topic instead: the word is good, but it
 * belongs inside a section that exists rather than beside it. Pure, like the
 * rest of the deciding here; `community.ts` does the reads and writes.
 */
import { isOpen, type SectionRecord } from "./sections";
import { cleanTopicName, readTopicNames } from "./topics";

export type ApproveAsTopic =
  | { ok: true; resume: false; section: string; name: string; nameLower: string; names: Record<string, string> }
  /** Already decided; only the lists waiting for it are left to move. */
  | { ok: true; resume: true; section: string; topicId: string }
  | { ok: false; reason: "missing" | "settled" | "bad_section" | "bad_name" };

/**
 * Whether a proposal can become a topic: one still waiting, into an open
 * section, under its own name or a better one, with any translations. A
 * proposal already turned into a topic but whose lists are not all moved yet
 * is finished rather than refused, so asking again completes the job.
 */
export function decideApproveAsTopic(
  proposal: SectionRecord | null,
  section: SectionRecord | null,
  body: unknown,
): ApproveAsTopic {
  if (proposal === null || proposal.builtIn) return { ok: false, reason: "missing" };
  if (proposal.status === "merged" && proposal.unfinished && proposal.mergedTopicId !== null && proposal.mergedInto !== null) {
    return { ok: true, resume: true, section: proposal.mergedInto, topicId: proposal.mergedTopicId };
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
