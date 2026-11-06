/**
 * A moderator's move of a published list, remembered on the list so the
 * author's next republish of an unchanged board does not move it back. Pure:
 * `community.ts` reads and writes `movedByStaff`.
 */
import type { TopicRequest } from "./topics";

export interface Moved<T> {
  /** What the author had before staff first moved it. */
  from: T;
  to: T;
}

export interface MovedByStaff {
  category?: Moved<string>;
  topicId?: Moved<string | null>;
}

export interface Placement {
  category: string;
  topicId: string | null;
}

function isTopicSide(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function readMovedByStaff(value: unknown): MovedByStaff {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, Record<string, unknown> | undefined>;
  const moved: MovedByStaff = {};
  const category = source.category;
  if (category && typeof category.from === "string" && typeof category.to === "string") {
    moved.category = { from: category.from, to: category.to };
  }
  const topic = source.topicId;
  if (topic && isTopicSide(topic.from) && isTopicSide(topic.to)) {
    moved.topicId = { from: topic.from, to: topic.to };
  }
  return moved;
}

function emptyAsNull(moved: MovedByStaff): MovedByStaff | null {
  return moved.category === undefined && moved.topicId === undefined ? null : moved;
}

/**
 * What a list remembers after staff move it from [before] to [after]. A
 * second move keeps the author's value as `from`, and a move back to it
 * forgets that field. Null when nothing is remembered.
 */
export function recordStaffMove(earlier: MovedByStaff, before: Placement, after: Placement): MovedByStaff | null {
  const moved: MovedByStaff = { ...earlier };
  if (before.category !== after.category) {
    const from = earlier.category?.from ?? before.category;
    if (from === after.category) delete moved.category;
    else moved.category = { from, to: after.category };
  }
  if (before.topicId !== after.topicId) {
    const from = earlier.topicId === undefined ? before.topicId : earlier.topicId.from;
    if (from === after.topicId) delete moved.topicId;
    else moved.topicId = { from, to: after.topicId };
  }
  return emptyAsNull(moved);
}

export interface HeldPlacement {
  category: string;
  topic: TopicRequest;
  /** The moves still standing; `stillMoved` keeps the ones the stored list really ended up with. */
  held: MovedByStaff;
}

/**
 * The author's replace against what staff moved: a body that still says what
 * the list was before the move, or says nothing about the field, keeps the
 * staff's value; anything else is the author's choice and wins. A kept topic
 * is asked for as "nothing", so the republish keeps the topic the list sits
 * in rather than attaching it anew.
 */
export function holdStaffMoves(moved: MovedByStaff, asked: { category: string; topic: TopicRequest }): HeldPlacement {
  const held: MovedByStaff = {};
  let category = asked.category;
  if (moved.category !== undefined && asked.category === moved.category.from) {
    category = moved.category.to;
    held.category = moved.category;
  }
  let topic = asked.topic;
  const movedTopic = moved.topicId;
  const keepsTopic = movedTopic !== undefined && (
    topic.kind === "none" || (topic.kind === "existing" && topic.topicId === movedTopic.from)
  );
  if (keepsTopic) {
    topic = movedTopic.to === null ? { kind: "clear" } : { kind: "none" };
    held.topicId = movedTopic;
  }
  return { category, topic, held };
}

/** The held moves the stored list still shows; null when none is left. */
export function stillMoved(held: MovedByStaff, stored: Placement): MovedByStaff | null {
  const moved: MovedByStaff = {};
  if (held.category !== undefined && held.category.to === stored.category) moved.category = held.category;
  if (held.topicId !== undefined && held.topicId.to === stored.topicId) moved.topicId = held.topicId;
  return emptyAsNull(moved);
}
