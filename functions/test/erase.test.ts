import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNTED_FOLLOWS, NAMED_IN, OWN_DOCUMENTS } from "../src/erase";
import { ERASED_PROPOSER, mayKnowProposer, topicAfterErasure } from "../src/topics";

describe("what erasing an account removes", () => {
  it("removes every document that names the person in one field", () => {
    assert.deepEqual(
      NAMED_IN.map((one) => `${one.collection}.${one.field}`),
      ["follows.follower", "follows.author", "sectionFollows.follower", "takes.taker", "reports.reporterUid", "publishHolds.authorUid"],
    );
  });

  it("removes the sections they followed", () => {
    assert.ok(NAMED_IN.some((one) => one.collection === "sectionFollows" && one.field === "follower"));
  });

  it("removes the topics they followed and their rankings, and takes each one off its count", () => {
    assert.deepEqual(COUNTED_FOLLOWS, [
      {
        collection: "topicFollows",
        field: "follower",
        countedOn: { collection: "topics", idField: "topicId", counter: "followerCount" },
      },
      {
        collection: "rankings",
        field: "uid",
        countedOn: { collection: "publishedLists", idField: "listId", counter: "rankingCount" },
      },
    ]);
  });

  // An erased moderator was still listed under GET /lists/moderators, with name and face (QA S8).
  it("removes the documents kept under their uid, the moderator's role among them", () => {
    assert.deepEqual([...OWN_DOCUMENTS].sort(), ["roles", "sectionProposers"]);
  });
});

describe("topicAfterErasure", () => {
  it("takes a topic nobody approved with the account, and keeps one people use", () => {
    assert.equal(topicAfterErasure("pending"), "remove");
    assert.equal(topicAfterErasure("rejected"), "remove");
    assert.equal(topicAfterErasure("approved"), "forget");
    assert.equal(topicAfterErasure("merged"), "forget");
  });

  it("leaves a kept topic without the proposer's uid or name, and nobody is told it is theirs", () => {
    assert.deepEqual(ERASED_PROPOSER, { createdBy: "", proposerName: "" });
    assert.equal(mayKnowProposer({ ...ERASED_PROPOSER }, { uid: "someone", staff: false }), false);
  });
});
