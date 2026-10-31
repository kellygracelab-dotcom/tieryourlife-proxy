import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminKeeps, publishedByFor, readAdminListsQuery, readsBySection } from "../src/adminLists";
import { authorsToAsk } from "../src/anonymous";
import { isOwnedRanking, rankingCursor, readRankingCursor } from "../src/rankings";
import { keepingOnlyIfWritten, replacedSectionPicture, replacedTopicPicture, storedPathOf } from "../src/sectionPictures";
import {
  builtInRecord,
  BUILT_IN_SECTIONS,
  decideSectionAction,
  decideSectionChoice,
  finishCallOf,
  newSection,
  noStats,
  sectionView,
  type SectionRecord,
} from "../src/sections";
import { impliedTopic, topicHop, type KnownTopic } from "../src/topics";
import { addressOf } from "../src/publishedPictures";

function section(some: Partial<SectionRecord> & { id: string }): SectionRecord {
  return { ...newSection(some.id, some.name ?? some.id, 1000), status: "approved", approvedAtMs: 1000, ...some };
}

function topic(some: Partial<KnownTopic> = {}): KnownTopic {
  return { id: "t1", name: "Street food", nameLower: "street food", status: "approved", section: "food", createdBy: "author-1", ...some };
}

const food = builtInRecord(BUILT_IN_SECTIONS[5]);
const madeTopic = section({
  id: "street-food",
  status: "merged",
  mergedInto: "food",
  mergedTopicId: "t1",
  proposerUid: "me",
  approvedAtMs: null,
});

describe("a republish of a list moved into a topic", () => {
  const known = new Map([[food.id, food], [madeTopic.id, madeTopic], ["noodles", section({ id: "noodles", status: "merged", mergedInto: "food" })]]);

  it("learns which topic the proposal it names became", () => {
    assert.deepEqual(decideSectionChoice("street-food", known, "me"), { ok: true, category: "food", proposedSection: null, viaTopic: "t1" });
    assert.deepEqual(decideSectionChoice("noodles", known, "me"), { ok: true, category: "food", proposedSection: null });
  });

  it("lands in that topic while it is approved, with the section it brings", () => {
    const implied = impliedTopic({ request: { kind: "none" }, viaTopic: topic({ section: "travel" }), chosenCategory: "food", previous: null });
    assert.deepEqual(implied, { topicId: "t1", topicName: "Street food", category: "travel" });
  });

  it("keeps the topic it already had when it stays in the same section", () => {
    const previous = { category: "food", topicId: "t1", topicName: "Street food" };
    assert.deepEqual(impliedTopic({ request: { kind: "none" }, viaTopic: null, chosenCategory: "food", previous }), {
      topicId: "t1",
      topicName: "Street food",
      category: "food",
    });
    assert.equal(impliedTopic({ request: { kind: "none" }, viaTopic: null, chosenCategory: "games", previous }), null);
    assert.equal(impliedTopic({ request: { kind: "none" }, viaTopic: null, chosenCategory: "food", previous: { category: "food", topicId: null } }), null);
  });

  it("falls back to what it had when the proposal's topic is no longer approved", () => {
    const previous = { category: "food", topicId: "t7", topicName: "Tacos" };
    const rejected = topic({ status: "rejected" });
    assert.deepEqual(impliedTopic({ request: { kind: "none" }, viaTopic: rejected, chosenCategory: "food", previous })?.topicId, "t7");
  });

  it("does what the request says when it names a topic or a new one", () => {
    const previous = { category: "food", topicId: "t1", topicName: "Street food" };
    assert.equal(impliedTopic({ request: { kind: "existing", topicId: "t2" }, viaTopic: topic(), chosenCategory: "food", previous }), null);
    assert.equal(impliedTopic({ request: { kind: "new", name: "Tacos", nameLower: "tacos" }, viaTopic: null, chosenCategory: "food", previous }), null);
  });
});

describe("topicHop", () => {
  it("stops at an approved topic, follows a merge, and gives up on anything else", () => {
    assert.deepEqual(topicHop({ status: "approved", section: "food", mergedInto: null }), { live: true });
    assert.deepEqual(topicHop({ status: "merged", section: "food", mergedInto: "t2" }), { next: "t2" });
    assert.deepEqual(topicHop({ status: "merged", section: "food", mergedInto: null }), { gone: true });
    assert.deepEqual(topicHop({ status: "rejected", section: null }), { gone: true });
    assert.deepEqual(topicHop({ status: "pending", section: null }), { gone: true });
    assert.deepEqual(topicHop({ status: "approved", section: null }), { gone: true });
    assert.deepEqual(topicHop(null), { gone: true });
  });
});

describe("authorsToAsk", () => {
  const reader = { uid: "me", isAnonymous: false };

  it("asks about each named author on the page once, never the reader", () => {
    const lists = [{ authorUid: "a" }, { authorUid: "b" }, { authorUid: "a" }, { authorUid: "me" }, { authorUid: "c", anonymous: true }];
    assert.deepEqual(authorsToAsk(lists, reader), ["a", "b"]);
  });

  it("asks nothing for a guest", () => {
    assert.deepEqual(authorsToAsk([{ authorUid: "a" }], { uid: "guest", isAnonymous: true }), []);
  });
});

describe("a legacy merge of a proposal made a topic", () => {
  it("is too late, so only the topic's own call finishes it", () => {
    const halfway = { ...madeTopic, unfinished: true };
    assert.deepEqual(decideSectionAction("merge", halfway, food), { ok: false, reason: "settled" });
  });

  it("still finishes a legacy merge cut short", () => {
    const halfway = { ...madeTopic, mergedTopicId: null, unfinished: true };
    assert.equal(decideSectionAction("merge", halfway, food).ok, true);
  });
});

describe("a topic's replaced picture", () => {
  const at = (path: string) => addressOf("bucket.appspot.com", path);

  it("reads the path back out of a public address", () => {
    assert.equal(storedPathOf(at("topics/t1/pic 1")), "topics/t1/pic 1");
    assert.equal(storedPathOf("https://example.com/x"), null);
    assert.equal(storedPathOf(null), null);
  });

  it("is the old file alone, and only when the new one differs", () => {
    assert.equal(replacedTopicPicture("t1", at("topics/t1/old"), at("topics/t1/new")), "topics/t1/old");
    assert.equal(replacedTopicPicture("t1", at("topics/t1/same"), at("topics/t1/same")), null);
    assert.equal(replacedTopicPicture("t1", undefined, at("topics/t1/new")), null);
  });

  it("is the old file when the picture is removed", () => {
    assert.equal(replacedTopicPicture("t1", at("topics/t1/old"), undefined), "topics/t1/old");
  });

  it("is never a file outside the topic's own folder", () => {
    assert.equal(replacedTopicPicture("t1", at("topics/t2/old"), undefined), null);
    assert.equal(replacedTopicPicture("t1", at("sections/food/old"), undefined), null);
  });
});

describe("a section's replaced picture", () => {
  const at = (path: string) => addressOf("bucket.appspot.com", path);

  it("is the old file alone, built-in or not, and only when the new one differs", () => {
    assert.equal(replacedSectionPicture("games", at("sections/games/old"), at("sections/games/new")), "sections/games/old");
    assert.equal(replacedSectionPicture("games", at("sections/games/same"), at("sections/games/same")), null);
    assert.equal(replacedSectionPicture("games", undefined, at("sections/games/new")), null);
  });

  it("is the old file when the picture is taken away", () => {
    assert.equal(replacedSectionPicture("games", at("sections/games/old"), undefined), "sections/games/old");
  });

  it("is never a file outside the section's own folder", () => {
    assert.equal(replacedSectionPicture("games", at("sections/games-2/old"), undefined), null);
    assert.equal(replacedSectionPicture("games", at("topics/games/old"), undefined), null);
  });
});

describe("keepingOnlyIfWritten", () => {
  it("discards the copy when the write throws, and throws on", async () => {
    const discarded: string[] = [];
    const discard = async (path: string) => void discarded.push(path);
    await assert.rejects(keepingOnlyIfWritten("topics/t1/new", async () => { throw new Error("contention"); }, discard), /contention/);
    assert.deepEqual(discarded, ["topics/t1/new"]);
  });

  it("keeps the copy when the write lands, and has nothing to discard without one", async () => {
    const discarded: string[] = [];
    const discard = async (path: string) => void discarded.push(path);
    assert.equal(await keepingOnlyIfWritten("topics/t1/new", async () => 7, discard), 7);
    await assert.rejects(keepingOnlyIfWritten(null, async () => { throw new Error("x"); }, discard));
    assert.deepEqual(discarded, []);
  });
});

describe("who published a list, for the staff", () => {
  const named = { authorUid: "u1", authorName: "Ann" };
  const hidden = { ...named, anonymous: true };

  it("names the author of an anonymous list to the owner alone", () => {
    assert.deepEqual(publishedByFor(hidden, true), { uid: "u1", name: "Ann" });
    assert.equal(publishedByFor(hidden, false), null);
  });

  it("names the author of a list with their name on it to every moderator", () => {
    assert.deepEqual(publishedByFor(named, false), { uid: "u1", name: "Ann" });
  });
});

describe("topic=other in the staff's lists", () => {
  it("is read by the section", () => {
    assert.equal(readAdminListsQuery({ section: "food", topic: "other" }).ok && readsBySection("other"), true);
    assert.equal(readsBySection("t1"), false);
  });

  it("keeps a list whose topic is set but not an approved topic of the section", () => {
    const approvedHere = new Set(["t1"]);
    assert.equal(adminKeeps({ category: "food", topicId: "t2" }, "food", "other", approvedHere), true);
    assert.equal(adminKeeps({ category: "food", topicId: "t1" }, "food", "other", approvedHere), false);
    assert.equal(adminKeeps({ category: "food", topicId: null }, "food", "other", approvedHere), false);
    assert.equal(adminKeeps({ category: "food" }, "food", "other", approvedHere), false);
    assert.equal(adminKeeps({ category: "games", topicId: "t2" }, "food", "other", approvedHere), false);
  });
});

describe("finishCallOf", () => {
  const halfway = (some: Partial<SectionRecord>) => section({ id: "street-food", unfinished: true, ...some });

  it("repeats a topic decision with its own target", () => {
    assert.deepEqual(finishCallOf({ ...madeTopic, unfinished: true, decidedAs: "approve-as-topic" }), {
      action: "approve-as-topic",
      body: { section: "food" },
    });
    assert.deepEqual(finishCallOf({ ...madeTopic, unfinished: true, decidedAs: "merge-into-topic" }), {
      action: "merge-into-topic",
      body: { topic: "t1" },
    });
  });

  it("finishes a topic decision recorded before the call was, by its topic", () => {
    assert.deepEqual(finishCallOf({ ...madeTopic, unfinished: true }), { action: "merge-into-topic", body: { topic: "t1" } });
  });

  it("repeats a section decision", () => {
    assert.deepEqual(finishCallOf(halfway({ status: "merged", mergedInto: "food" })), { action: "merge", body: { into: "food" } });
    assert.deepEqual(finishCallOf(halfway({ status: "approved" })), { action: "approve", body: {} });
    assert.deepEqual(finishCallOf(halfway({ status: "declined" })), { action: "decline", body: {} });
  });

  it("has nothing for a finished decision or a withdrawal, which is the proposer's", () => {
    assert.equal(finishCallOf(madeTopic), null);
    assert.equal(finishCallOf(halfway({ status: "declined", withdrawn: true })), null);
  });

  it("goes to the staff only", () => {
    const stuck = { ...madeTopic, unfinished: true, decidedAs: "approve-as-topic" as const };
    assert.deepEqual(sectionView(stuck, { uid: "mod", moderator: true }, noStats(stuck.id), false).finish, {
      action: "approve-as-topic",
      body: { section: "food" },
    });
    assert.equal("finish" in sectionView(stuck, { uid: "me", moderator: false }, noStats(stuck.id), false), false);
  });
});

describe("the rankings cursor", () => {
  const time = { seconds: 1_790_000_000, nanoseconds: 123_456_000 };

  it("is the id of a ranking the page shows", () => {
    assert.equal(rankingCursor({ id: "list_uid", shown: true, updatedAt: time }), "list_uid");
    assert.equal(rankingCursor(null), null);
  });

  it("is a time, never the code, after a website ranking the page hides", () => {
    const cursor = rankingCursor({ id: "SECRETCODE", shown: false, updatedAt: time });
    assert.equal(cursor, "~1790000000.123456000");
    assert.ok(!(cursor ?? "").includes("SECRETCODE"));
    assert.deepEqual(readRankingCursor(cursor as string), { kind: "time", time });
  });

  it("reads anything else as a ranking's id", () => {
    assert.deepEqual(readRankingCursor("list_uid"), { kind: "id", id: "list_uid" });
  });
});

describe("a website ranking", () => {
  it("is not the app's, so a list taken down leaves it", () => {
    assert.equal(isOwnedRanking({ listId: "l1", ownerUid: "u1", claimToken: "x" } as { uid?: unknown }), false);
    assert.equal(isOwnedRanking({ uid: "u1" }), true);
  });
});
