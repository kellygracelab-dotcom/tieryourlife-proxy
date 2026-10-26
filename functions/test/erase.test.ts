import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNTED_FOLLOWS, NAMED_IN } from "../src/erase";

describe("what erasing an account removes", () => {
  it("removes every document that names the person in one field", () => {
    assert.deepEqual(
      NAMED_IN.map((one) => `${one.collection}.${one.field}`),
      ["follows.follower", "follows.author", "sectionFollows.follower", "takes.taker", "reports.reporterUid"],
    );
  });

  it("removes the sections they followed", () => {
    assert.ok(NAMED_IN.some((one) => one.collection === "sectionFollows" && one.field === "follower"));
  });

  it("removes the topics they followed, and takes each one off that topic's count", () => {
    assert.deepEqual(COUNTED_FOLLOWS, [
      {
        collection: "topicFollows",
        field: "follower",
        countedOn: { collection: "topics", idField: "topicId", counter: "followerCount" },
      },
    ]);
  });
});
