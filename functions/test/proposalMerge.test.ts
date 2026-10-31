import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIT_ACTIONS } from "../src/audit";
import { decideApproveAsTopic, decideMergeIntoTopic, mergeTopicId, nameClashOf, topicKeyOf, type ClashReads } from "../src/proposalTopic";
import { builtInRecord, BUILT_IN_SECTIONS, nameKey, newSection, waitingFor, type SectionRecord } from "../src/sections";
import type { KnownTopic } from "../src/topics";

function section(some: Partial<SectionRecord> & { id: string }): SectionRecord {
  return { ...newSection(some.id, some.name ?? some.id, 1000), status: "approved", approvedAtMs: 1000, ...some };
}

function topic(some: Partial<KnownTopic> = {}): KnownTopic {
  return { id: "t1", name: "Street food", nameLower: "street food", status: "approved", section: "food", createdBy: "author-1", ...some };
}

const food = builtInRecord(BUILT_IN_SECTIONS[5]);
const pending = section({ id: "street-food", name: "Street food", status: "pending", proposerUid: "me", approvedAtMs: null });

describe("waitingFor", () => {
  const proposals = new Map([
    [pending.id, pending],
    ["old", section({ id: "old", name: "Old", status: "declined" })],
  ]);

  it("names the proposal a list waits for while it is waiting", () => {
    assert.deepEqual(waitingFor("street-food", proposals), { proposedSection: "street-food", proposedSectionName: "Street food" });
  });

  it("names nothing for a decided proposal, an unknown one or none", () => {
    const none = { proposedSection: null, proposedSectionName: null };
    assert.deepEqual(waitingFor("old", proposals), none);
    assert.deepEqual(waitingFor("gone", proposals), none);
    assert.deepEqual(waitingFor(null, proposals), none);
    assert.deepEqual(waitingFor(undefined, proposals), none);
  });
});

describe("decideMergeIntoTopic", () => {
  it("merges a waiting proposal into an approved topic of an open section", () => {
    assert.deepEqual(decideMergeIntoTopic(pending, topic(), food), { ok: true, resume: false, section: "food", topicId: "t1" });
  });

  it("finds nothing that is not a proposal, and is too late for a decided one", () => {
    assert.deepEqual(decideMergeIntoTopic(null, topic(), food), { ok: false, reason: "missing" });
    assert.deepEqual(decideMergeIntoTopic(food, topic(), food), { ok: false, reason: "missing" });
    for (const status of ["approved", "declined", "merged"] as const) {
      assert.deepEqual(decideMergeIntoTopic({ ...pending, status }, topic(), food), { ok: false, reason: "settled" });
    }
  });

  it("refuses a topic that is not approved, or has no section", () => {
    assert.deepEqual(decideMergeIntoTopic(pending, null, food), { ok: false, reason: "bad_topic" });
    for (const status of ["pending", "rejected", "merged"] as const) {
      assert.deepEqual(decideMergeIntoTopic(pending, topic({ status }), food), { ok: false, reason: "bad_topic" });
    }
    assert.deepEqual(decideMergeIntoTopic(pending, topic({ section: null }), food), { ok: false, reason: "bad_topic" });
  });

  it("refuses a topic whose section is hidden, waiting, gone or not the one read", () => {
    const closed = (some: Partial<SectionRecord>) => section({ id: "food", ...some });
    assert.deepEqual(decideMergeIntoTopic(pending, topic(), closed({ hidden: true })), { ok: false, reason: "bad_topic" });
    assert.deepEqual(decideMergeIntoTopic(pending, topic(), closed({ status: "pending" })), { ok: false, reason: "bad_topic" });
    assert.deepEqual(decideMergeIntoTopic(pending, topic(), null), { ok: false, reason: "bad_topic" });
    assert.deepEqual(decideMergeIntoTopic(pending, topic(), section({ id: "travel" })), { ok: false, reason: "bad_topic" });
  });

  it("finishes a merge whose lists are not all moved when the same topic is sent", () => {
    const halfway = { ...pending, status: "merged" as const, mergedInto: "food", mergedTopicId: "t1", unfinished: true };
    assert.deepEqual(decideMergeIntoTopic(halfway, topic(), null), { ok: true, resume: true, section: "food", topicId: "t1" });
    assert.deepEqual(decideMergeIntoTopic({ ...halfway, unfinished: false }, topic(), food), { ok: false, reason: "settled" });
  });

  it("does not hand a half-done merge to a call naming another topic, or none", () => {
    const halfway = { ...pending, status: "merged" as const, mergedInto: "food", mergedTopicId: "t1", unfinished: true };
    assert.deepEqual(decideMergeIntoTopic(halfway, topic({ id: "t2" }), food), { ok: false, reason: "settled" });
    assert.deepEqual(decideMergeIntoTopic(halfway, null, null), { ok: false, reason: "settled" });
  });

  it("is finished the same way as a proposal made a topic, by its section", () => {
    const halfway = { ...pending, status: "merged" as const, mergedInto: "food", mergedTopicId: "t1", unfinished: true };
    assert.deepEqual(decideApproveAsTopic(halfway, food, {}), { ok: true, resume: true, section: "food", topicId: "t1" });
  });

  it("reads the topic from the body only by a usable id", () => {
    assert.equal(mergeTopicId({ topic: "t1" }), "t1");
    assert.equal(mergeTopicId({ topic: "../x" }), null);
    assert.equal(mergeTopicId({ topic: 7 }), null);
    assert.equal(mergeTopicId({}), null);
    assert.equal(mergeTopicId(null), null);
  });

  it("is written in the log under its own name", () => {
    assert.ok((AUDIT_ACTIONS as readonly string[]).includes("section.merge_into_topic"));
  });
});

describe("nameClashOf", () => {
  const travel = section({ id: "travel", name: "Street Food" });
  const reads = (some: Partial<ClashReads>): ClashReads => ({
    topicReservation: null,
    topic: null,
    sectionReservation: null,
    sections: new Map([[food.id, food]]),
    ...some,
  });
  const heldTopic = { topicReservation: { key: "street food", topicId: "t1" }, topic: topic() };

  it("reserves topic names the way topics are named", () => {
    assert.equal(topicKeyOf("  Street   Food "), "street food");
    assert.equal(topicKeyOf("?"), null);
  });

  it("finds an approved topic by that name, with its section's name", () => {
    assert.deepEqual(nameClashOf(pending, reads(heldTopic)), {
      kind: "topic",
      id: "t1",
      name: "Street food",
      section: "food",
      sectionName: food.name,
    });
  });

  it("does not offer a topic still waiting, renamed or no longer holding the name", () => {
    assert.equal(nameClashOf(pending, reads({ ...heldTopic, topic: topic({ status: "pending" }) })), null);
    assert.equal(nameClashOf(pending, reads({ ...heldTopic, topic: topic({ nameLower: "street eats" }) })), null);
    assert.equal(nameClashOf(pending, reads({ ...heldTopic, topic: topic({ id: "t2" }) })), null);
    assert.equal(nameClashOf(pending, reads({ ...heldTopic, topic: topic({ status: "merged" }) })), null);
  });

  it("finds another section holding the name, but not the proposal's own reservation", () => {
    const key = nameKey("Street food");
    const sections = new Map([[travel.id, travel]]);
    assert.deepEqual(nameClashOf(pending, reads({ sectionReservation: { key, sectionId: "travel" }, sections })), {
      kind: "section",
      id: "travel",
      name: "Street Food",
    });
    assert.equal(nameClashOf(pending, reads({ sectionReservation: { key, sectionId: pending.id } })), null);
    const declined = new Map([[travel.id, { ...travel, status: "declined" as const }]]);
    assert.equal(nameClashOf(pending, reads({ sectionReservation: { key, sectionId: "travel" }, sections: declined })), null);
  });

  it("does not offer a section still waiting or hidden, which /merge would refuse", () => {
    const key = nameKey("Street food");
    const waiting = new Map([[travel.id, { ...travel, status: "pending" as const, approvedAtMs: null }]]);
    assert.equal(nameClashOf(pending, reads({ sectionReservation: { key, sectionId: "travel" }, sections: waiting })), null);
    const hidden = new Map([[travel.id, { ...travel, hidden: true }]]);
    assert.equal(nameClashOf(pending, reads({ sectionReservation: { key, sectionId: "travel" }, sections: hidden })), null);
  });

  it("names the topic first, since a proposal can be merged into it", () => {
    const sections = new Map([[food.id, food], [travel.id, travel]]);
    const both = reads({ ...heldTopic, sectionReservation: { key: nameKey("Street food"), sectionId: "travel" }, sections });
    assert.equal(nameClashOf(pending, both)?.kind, "topic");
  });

  it("finds nothing for a proposal already decided", () => {
    assert.equal(nameClashOf({ ...pending, status: "declined" }, reads(heldTopic)), null);
  });
});
