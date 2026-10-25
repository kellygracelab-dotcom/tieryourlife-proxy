import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanTopicName,
  decideAttachment,
  decideTopicAction,
  MAX_PENDING_TOPICS_PER_ACCOUNT,
  MAX_TOPIC_NAME_LENGTH,
  MAX_TOPICS_PAGE_SIZE,
  orderMine,
  readTopicRequest,
  similarTopics,
  TOPICS_PAGE_SIZE,
  topicsPageSize,
  type KnownTopic,
} from "../src/topics";

function topic(some: Partial<KnownTopic> & { id: string }): KnownTopic {
  return {
    name: "Pokémon",
    nameLower: "pokémon",
    status: "approved",
    section: "games",
    createdBy: "author-1",
    ...some,
  };
}

describe("cleanTopicName", () => {
  it("collapses the spaces and trims", () => {
    assert.equal(cleanTopicName("  Kharkiv   restaurants "), "Kharkiv restaurants");
  });

  it("refuses one character, and more than forty", () => {
    assert.equal(cleanTopicName("K"), null);
    assert.equal(cleanTopicName("K".repeat(MAX_TOPIC_NAME_LENGTH + 1)), null);
    assert.equal(cleanTopicName("K".repeat(MAX_TOPIC_NAME_LENGTH)), "K".repeat(MAX_TOPIC_NAME_LENGTH));
  });

  // Punctuation names nothing; a digit or a letter in any script does.
  it("wants a letter or a digit somewhere in it", () => {
    assert.equal(cleanTopicName("!!!"), null);
    assert.equal(cleanTopicName("2025"), "2025");
    assert.equal(cleanTopicName("Аниме"), "Аниме");
  });

  it("is not a string, is not a name", () => {
    assert.equal(cleanTopicName(42), null);
    assert.equal(cleanTopicName(null), null);
  });
});

describe("readTopicRequest", () => {
  it("reads nothing as nothing", () => {
    assert.deepEqual(readTopicRequest(undefined, undefined), { ok: true, request: { kind: "none" } });
    assert.deepEqual(readTopicRequest(null, ""), { ok: true, request: { kind: "none" } });
  });

  it("refuses an id and a new name together", () => {
    assert.deepEqual(readTopicRequest("abc123", "Oscars"), { ok: false, reason: "both" });
  });

  it("lower-cases a new name for finding, and keeps it for showing", () => {
    assert.deepEqual(readTopicRequest(undefined, " Oscars  2025 "), {
      ok: true,
      request: { kind: "new", name: "Oscars 2025", nameLower: "oscars 2025" },
    });
  });

  it("refuses a name that is not one, and an id that could not address a document", () => {
    assert.deepEqual(readTopicRequest(undefined, "?"), { ok: false, reason: "bad_name" });
    assert.deepEqual(readTopicRequest("../other", undefined), { ok: false, reason: "bad_id" });
  });
});

describe("decideAttachment", () => {
  const base = {
    chosenCategory: "film_tv" as const,
    callerUid: "me",
    byId: null,
    approvedByName: null,
    ownPendingByName: null,
    pendingCount: 0,
  };

  it("attaches nothing when nothing was asked", () => {
    assert.deepEqual(decideAttachment({ ...base, request: { kind: "none" } }), { kind: "none" });
  });

  it("an approved topic by id carries its own section, whatever the author chose", () => {
    const approved = topic({ id: "t1", section: "games" });
    const outcome = decideAttachment({ ...base, request: { kind: "existing", topicId: "t1" }, byId: approved });
    assert.deepEqual(outcome, { kind: "attach", topic: approved, category: "games" });
  });

  it("the caller's own pending topic may be used again, and holds the list under other", () => {
    const mine = topic({ id: "t2", status: "pending", section: null, createdBy: "me" });
    const outcome = decideAttachment({ ...base, request: { kind: "existing", topicId: "t2" }, byId: mine });
    assert.deepEqual(outcome, { kind: "attach", topic: mine, category: "other" });
  });

  it("somebody else's pending topic, or a rejected or merged one, is not available", () => {
    const theirs = topic({ id: "t3", status: "pending", section: null, createdBy: "somebody" });
    assert.deepEqual(
      decideAttachment({ ...base, request: { kind: "existing", topicId: "t3" }, byId: theirs }),
      { kind: "refuse", reason: "not_available" },
    );
    const gone = topic({ id: "t4", status: "rejected" });
    assert.deepEqual(
      decideAttachment({ ...base, request: { kind: "existing", topicId: "t4" }, byId: gone }),
      { kind: "refuse", reason: "not_available" },
    );
  });

  it("an id nobody has is refused", () => {
    assert.deepEqual(
      decideAttachment({ ...base, request: { kind: "existing", topicId: "nope" } }),
      { kind: "refuse", reason: "bad_id" },
    );
  });

  // A twin in the queue would make the moderator decide the same word twice.
  it("a new name that already is an approved topic joins it", () => {
    const approved = topic({ id: "t1" });
    const outcome = decideAttachment({
      ...base,
      request: { kind: "new", name: "Pokémon", nameLower: "pokémon" },
      approvedByName: approved,
    });
    assert.deepEqual(outcome, { kind: "attach", topic: approved, category: "games" });
  });

  it("a new name the caller already has waiting is reused, not queued again", () => {
    const mine = topic({ id: "t2", status: "pending", section: null, createdBy: "me" });
    const outcome = decideAttachment({
      ...base,
      request: { kind: "new", name: "Pokémon", nameLower: "pokémon" },
      ownPendingByName: mine,
      pendingCount: MAX_PENDING_TOPICS_PER_ACCOUNT,
    });
    assert.deepEqual(outcome, { kind: "attach", topic: mine, category: "other" });
  });

  it("a new word is created pending, under other, with the chosen section as the hint", () => {
    const outcome = decideAttachment({ ...base, request: { kind: "new", name: "Oscars 2025", nameLower: "oscars 2025" } });
    assert.deepEqual(outcome, {
      kind: "create",
      name: "Oscars 2025",
      nameLower: "oscars 2025",
      requestedSection: "film_tv",
      category: "other",
    });
  });

  it("a fourth word waiting is one too many", () => {
    const outcome = decideAttachment({
      ...base,
      request: { kind: "new", name: "Oscars 2025", nameLower: "oscars 2025" },
      pendingCount: MAX_PENDING_TOPICS_PER_ACCOUNT,
    });
    assert.deepEqual(outcome, { kind: "refuse", reason: "too_many_pending" });
  });
});

describe("similarTopics", () => {
  const approved = [
    topic({ id: "a", name: "Oscars", nameLower: "oscars" }),
    topic({ id: "b", name: "Oscar snubs", nameLower: "oscar snubs" }),
    topic({ id: "c", name: "Oscars 2024", nameLower: "oscars 2024" }),
    topic({ id: "d", name: "Oscar bait", nameLower: "oscar bait" }),
    topic({ id: "e", name: "Pokémon", nameLower: "pokémon" }),
  ];

  it("finds the approved topics that start with the first word, a few of them", () => {
    const pending = topic({ id: "p", name: "Oscars 2025", nameLower: "oscars 2025", status: "pending", section: null });
    assert.deepEqual(similarTopics(pending, approved).map((one) => one.id), ["a", "c"]);
  });

  it("stops at three", () => {
    const pending = topic({ id: "p", name: "Oscar night", nameLower: "oscar night", status: "pending", section: null });
    assert.equal(similarTopics(pending, approved).length, 3);
  });

  it("never offers the topic itself", () => {
    const self = approved[0];
    assert.deepEqual(similarTopics(self, approved).map((one) => one.id), ["c"]);
  });
});

describe("topicsPageSize", () => {
  it("is twenty unless asked, and never more than fifty", () => {
    assert.equal(topicsPageSize(undefined), TOPICS_PAGE_SIZE);
    assert.equal(topicsPageSize("abc"), TOPICS_PAGE_SIZE);
    assert.equal(topicsPageSize("0"), TOPICS_PAGE_SIZE);
    assert.equal(topicsPageSize("7"), 7);
    assert.equal(topicsPageSize("500"), MAX_TOPICS_PAGE_SIZE);
  });
});

describe("decideTopicAction", () => {
  const pending = topic({ id: "p", name: "Oscars 2025", nameLower: "oscars 2025", status: "pending", section: null });
  const approved = topic({ id: "a", name: "Oscars", nameLower: "oscars", section: "film_tv" });

  it("approving puts the topic and every list it carries into the section", () => {
    assert.deepEqual(decideTopicAction("approve", pending, { section: "film_tv" }), {
      ok: true,
      topic: { status: "approved", section: "film_tv" },
      lists: { category: "film_tv" },
      decided: true,
    });
  });

  it("approving needs a section, and a topic still waiting", () => {
    assert.deepEqual(decideTopicAction("approve", pending, { section: "films" }), { ok: false, reason: "no_section" });
    assert.deepEqual(decideTopicAction("approve", approved, { section: "film_tv" }), { ok: false, reason: "settled" });
  });

  it("renaming changes the word on the topic and on its lists, approved or not", () => {
    assert.deepEqual(decideTopicAction("rename", approved, { name: " Academy  Awards " }), {
      ok: true,
      topic: { name: "Academy Awards", nameLower: "academy awards" },
      lists: { topicName: "Academy Awards" },
      decided: false,
    });
    assert.deepEqual(decideTopicAction("rename", pending, { name: "?" }), { ok: false, reason: "bad_name" });
  });

  it("merging moves the lists to the target and marks where this one went", () => {
    assert.deepEqual(decideTopicAction("merge", pending, { into: approved }), {
      ok: true,
      topic: { status: "merged", mergedInto: "a" },
      lists: { topicId: "a", topicName: "Oscars", category: "film_tv" },
      decided: true,
    });
  });

  it("merging wants an approved target that is not the topic itself", () => {
    assert.deepEqual(decideTopicAction("merge", pending, { into: null }), { ok: false, reason: "no_target" });
    assert.deepEqual(decideTopicAction("merge", pending, { into: pending }), { ok: false, reason: "itself" });
    const waiting = topic({ id: "w", status: "pending", section: null });
    assert.deepEqual(decideTopicAction("merge", pending, { into: waiting }), { ok: false, reason: "target_not_approved" });
  });

  it("rejecting leaves the lists where they are, without the label", () => {
    assert.deepEqual(decideTopicAction("reject", pending, {}), {
      ok: true,
      topic: { status: "rejected" },
      lists: { topicId: null, topicName: null },
      decided: true,
    });
    assert.deepEqual(decideTopicAction("reject", approved, {}), { ok: false, reason: "settled" });
  });

  it("a settled topic is not decided again", () => {
    const rejected = topic({ id: "r", status: "rejected" });
    assert.deepEqual(decideTopicAction("rename", rejected, { name: "Anything" }), { ok: false, reason: "settled" });
    assert.deepEqual(decideTopicAction("merge", rejected, { into: approved }), { ok: false, reason: "settled" });
  });
});

describe("orderMine", () => {
  it("puts what is still waiting first, then the newest", () => {
    const mine = [
      { id: "old-approved", status: "approved" as const, createdAtMs: 1 },
      { id: "new-rejected", status: "rejected" as const, createdAtMs: 9 },
      { id: "old-pending", status: "pending" as const, createdAtMs: 2 },
      { id: "new-pending", status: "pending" as const, createdAtMs: 5 },
    ];
    assert.deepEqual(orderMine(mine).map((one) => one.id), ["new-pending", "old-pending", "new-rejected", "old-approved"]);
  });
});
