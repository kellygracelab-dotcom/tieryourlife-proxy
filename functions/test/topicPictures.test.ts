import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminKeeps, readAdminListsQuery } from "../src/adminLists";
import { AUDIT_ACTIONS } from "../src/audit";
import { toTopic } from "../src/community";
import { decideApproveAsTopic } from "../src/proposalTopic";
import { builtInRecord, BUILT_IN_SECTIONS, newSection, noStats, sectionView, type SectionRecord } from "../src/sections";
import { decideTopicEdit, readTopicPictureId } from "../src/topics";

function section(some: Partial<SectionRecord> & { id: string }): SectionRecord {
  return { ...newSection(some.id, some.name ?? some.id, 1000), status: "approved", approvedAtMs: 1000, ...some };
}

const storedTopic = {
  name: "Oscars",
  nameLower: "oscars",
  section: "film_tv",
  status: "approved" as const,
  requestedSection: "film_tv",
  createdBy: "author-1",
  proposerName: "Someone",
};

describe("a topic's picture", () => {
  it("is read as a picture id, null to take it away, or nothing to leave it be", () => {
    assert.deepEqual(readTopicPictureId("pic_1"), { ok: true, pictureId: "pic_1" });
    assert.deepEqual(readTopicPictureId(null), { ok: true, pictureId: null });
    assert.deepEqual(readTopicPictureId(undefined), { ok: true, pictureId: undefined });
    assert.deepEqual(readTopicPictureId("../x"), { ok: false });
    assert.deepEqual(readTopicPictureId(7), { ok: false });
  });

  it("is part of a topic edit, alone or with a name", () => {
    const approved = { status: "approved" as const };
    assert.deepEqual(decideTopicEdit(approved, { pictureId: "pic_1" }), { ok: true, pictureId: "pic_1" });
    assert.deepEqual(decideTopicEdit(approved, { pictureId: null }), { ok: true, pictureId: null });
    assert.deepEqual(decideTopicEdit(approved, { name: "Academy Awards", pictureId: "pic_1" }), {
      ok: true,
      name: "Academy Awards",
      nameLower: "academy awards",
      pictureId: "pic_1",
    });
    assert.deepEqual(decideTopicEdit(approved, { name: "Oscars" }).ok && "pictureId" in decideTopicEdit(approved, { name: "Oscars" }), false);
  });

  it("refuses something that is not a picture id", () => {
    assert.deepEqual(decideTopicEdit({ status: "approved" }, { pictureId: "a/b" }), { ok: false, reason: "bad_picture" });
  });

  it("goes out on every topic as pictureUrl, null for a topic without one", () => {
    const reader = { uid: "reader", staff: false };
    assert.equal(toTopic("t1", storedTopic, false, reader).pictureUrl, null);
    const pictured = { ...storedTopic, picture: { url: "https://firebasestorage.googleapis.com/x", width: 1440, height: 900 } };
    assert.equal(toTopic("t1", pictured, false, reader).pictureUrl, "https://firebasestorage.googleapis.com/x");
  });
});

describe("decideApproveAsTopic", () => {
  const pending = section({ id: "street-food", name: "Street food", status: "pending", fileUnder: "food", proposerUid: "me", approvedAtMs: null });
  const food = builtInRecord(BUILT_IN_SECTIONS[5]);

  it("turns a waiting proposal into a topic of an open section, under its own name", () => {
    assert.deepEqual(decideApproveAsTopic(pending, food, { section: "food" }), {
      ok: true,
      resume: false,
      section: "food",
      name: "Street food",
      nameLower: "street food",
      names: {},
    });
  });

  it("takes a better name and translations", () => {
    assert.deepEqual(decideApproveAsTopic(pending, food, { section: "food", name: "  Kharkiv  street food ", names: { uk: "Вулична їжа" } }), {
      ok: true,
      resume: false,
      section: "food",
      name: "Kharkiv street food",
      nameLower: "kharkiv street food",
      names: { uk: "Вулична їжа" },
    });
  });

  it("refuses a section that is not open, and a name or translations that are not ones", () => {
    assert.deepEqual(decideApproveAsTopic(pending, null, {}), { ok: false, reason: "bad_section" });
    assert.deepEqual(decideApproveAsTopic(pending, section({ id: "secret", hidden: true }), {}), { ok: false, reason: "bad_section" });
    assert.deepEqual(decideApproveAsTopic(pending, section({ id: "waiting", status: "pending" }), {}), { ok: false, reason: "bad_section" });
    assert.deepEqual(decideApproveAsTopic(pending, food, { name: "?" }), { ok: false, reason: "bad_name" });
    assert.deepEqual(decideApproveAsTopic(pending, food, { names: { xx: "Food" } }), { ok: false, reason: "bad_name" });
  });

  it("finds nothing that is not a proposal, and is too late for a decided one", () => {
    assert.deepEqual(decideApproveAsTopic(null, food, {}), { ok: false, reason: "missing" });
    assert.deepEqual(decideApproveAsTopic(food, food, {}), { ok: false, reason: "missing" });
    assert.deepEqual(decideApproveAsTopic({ ...pending, status: "declined" }, food, {}), { ok: false, reason: "settled" });
    assert.deepEqual(decideApproveAsTopic({ ...pending, status: "approved" }, food, {}), { ok: false, reason: "settled" });
  });

  it("finishes a proposal already made a topic whose lists are not all moved, when the same section is sent", () => {
    const halfway = { ...pending, status: "merged" as const, mergedInto: "food", mergedTopicId: "t9", unfinished: true };
    assert.deepEqual(decideApproveAsTopic(halfway, food, {}), { ok: true, resume: true, section: "food", topicId: "t9" });
    assert.deepEqual(decideApproveAsTopic({ ...halfway, unfinished: false }, food, {}), { ok: false, reason: "settled" });
  });

  it("does not hand a half-done topic to a call naming another section, or none", () => {
    const halfway = { ...pending, status: "merged" as const, mergedInto: "food", mergedTopicId: "t9", unfinished: true };
    assert.deepEqual(decideApproveAsTopic(halfway, section({ id: "travel" }), {}), { ok: false, reason: "settled" });
    assert.deepEqual(decideApproveAsTopic(halfway, null, {}), { ok: false, reason: "settled" });
  });

  it("is written in the log under its own name", () => {
    assert.ok((AUDIT_ACTIONS as readonly string[]).includes("section.approve_as_topic"));
  });
});

describe("a proposal approved as a topic", () => {
  const merged = section({
    id: "street-food",
    status: "merged",
    mergedInto: "food",
    mergedTopicId: "t9",
    proposerUid: "me",
    approvedAtMs: null,
  });

  it("tells its proposer where it went, the topic too", () => {
    const view = sectionView(merged, { uid: "me", moderator: false }, noStats("street-food"), false);
    assert.equal(view.mergedInto, "food");
    assert.equal(view.mergedTopicId, "t9");
  });

  it("tells the moderators too, and nobody else", () => {
    assert.equal(sectionView(merged, { uid: "mod", moderator: true }, noStats("street-food"), false).mergedTopicId, "t9");
    assert.equal("mergedTopicId" in sectionView(merged, { uid: "somebody", moderator: false }, noStats("street-food"), false), false);
  });
});

describe("readAdminListsQuery", () => {
  it("wants a section, and reads a topic, none, a sort and a cursor", () => {
    assert.deepEqual(readAdminListsQuery({ section: "food" }), { ok: true, section: "food", topic: null, sort: "recent", after: null });
    assert.deepEqual(readAdminListsQuery({ section: "food", topic: "none", sort: "popular", after: "abc123" }), {
      ok: true,
      section: "food",
      topic: "none",
      sort: "popular",
      after: "abc123",
    });
    assert.deepEqual(readAdminListsQuery({ section: "food", topic: "t1" }).ok, true);
  });

  it("refuses a missing section, a topic or a cursor that could not be one", () => {
    assert.deepEqual(readAdminListsQuery({}), { ok: false, detail: "section" });
    assert.deepEqual(readAdminListsQuery({ section: "Food!" }), { ok: false, detail: "section" });
    assert.deepEqual(readAdminListsQuery({ section: "food", topic: "../x" }), { ok: false, detail: "topic" });
    assert.deepEqual(readAdminListsQuery({ section: "food", after: "a/b" }), { ok: false, detail: "after" });
  });
});

describe("adminKeeps", () => {
  it("keeps every list of the section when no topic is asked", () => {
    assert.equal(adminKeeps({ category: "food", topicId: "t1" }, "food", null), true);
    assert.equal(adminKeeps({ category: "games" }, "food", null), false);
  });

  it("keeps a topic's lists only in the section asked", () => {
    assert.equal(adminKeeps({ category: "food", topicId: "t1" }, "food", "t1"), true);
    assert.equal(adminKeeps({ category: "games", topicId: "t1" }, "food", "t1"), false);
    assert.equal(adminKeeps({ category: "food", topicId: "t2" }, "food", "t1"), false);
  });

  it("reads none as a list whose topic is missing or null", () => {
    assert.equal(adminKeeps({ category: "food", topicId: null }, "food", "none"), true);
    assert.equal(adminKeeps({ category: "food" }, "food", "none"), true);
    assert.equal(adminKeeps({ category: "food", topicId: "t1" }, "food", "none"), false);
  });
});
