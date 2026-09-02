import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideHide,
  groupReports,
  REPORTS_BEFORE_HIDING,
  type ListStanding,
  type QueuedReport,
  type Reason,
} from "../src/moderation";

/** A standing with only the parts a test is about. */
function standing(some: Partial<ListStanding>): ListStanding {
  return {
    hidden: false,
    reviewed: false,
    coverImageUrl: null,
    authorUid: null,
    authorPhotoUrl: null,
    ...some,
  };
}

describe("decideHide", () => {
  it("leaves a list up while one person has complained", () => {
    assert.equal(decideHide({ reasons: ["spam"], reviewed: false }), false);
  });

  it("leaves it up at two, so one person with a grudge cannot silence anybody", () => {
    assert.equal(decideHide({ reasons: ["spam", "hate"], reviewed: false }), false);
  });

  it("takes it out of the feed at three", () => {
    assert.equal(decideHide({ reasons: ["spam", "hate", "other"], reviewed: false }), true);
  });

  // The one complaint that cannot wait for a second opinion.
  it("takes it out on the first report of sexual content", () => {
    assert.equal(decideHide({ reasons: ["sexual"], reviewed: false }), true);
  });

  it("never hides a snapshot somebody has looked at and kept", () => {
    assert.equal(decideHide({ reasons: ["sexual"], reviewed: true }), false);
    const many: Reason[] = Array.from({ length: 50 }, () => "spam");
    assert.equal(decideHide({ reasons: many, reviewed: true }), false);
  });

  it("hides at exactly the stated number and not one earlier", () => {
    const just = Array.from({ length: REPORTS_BEFORE_HIDING - 1 }, () => "spam" as Reason);
    assert.equal(decideHide({ reasons: just, reviewed: false }), false);
    assert.equal(decideHide({ reasons: [...just, "spam"], reviewed: false }), true);
  });
});

describe("groupReports", () => {
  const report = (
    listId: string,
    reason: Reason,
    createdAtMs: number,
    note: string | null = null,
  ): QueuedReport => ({
    listId,
    listTitle: `Board ${listId}`,
    authorName: "Someone",
    reason,
    note,
    createdAtMs,
  });

  it("gives one row to a list three people complained about", () => {
    const rows = groupReports(
      [report("a", "spam", 1), report("a", "hate", 2), report("a", "other", 3)],
      new Map(),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reportCount, 3);
  });

  it("puts the newest complaint first within a row", () => {
    const rows = groupReports([report("a", "spam", 1), report("a", "hate", 9)], new Map());
    assert.deepEqual(rows[0].reasons, ["hate", "spam"]);
  });

  it("keeps every note and drops the empty ones", () => {
    const rows = groupReports(
      [report("a", "spam", 1, "again"), report("a", "hate", 2, null), report("a", "other", 3, "look")],
      new Map(),
    );
    assert.deepEqual(rows[0].notes, ["look", "again"]);
  });

  // Its author is being punished by three strangers until somebody looks.
  it("puts a hidden list above a newer one that is still visible", () => {
    const rows = groupReports(
      [report("old", "spam", 1), report("new", "spam", 100)],
      new Map([["old", standing({ hidden: true, reviewed: false })]]),
    );
    assert.deepEqual(rows.map((row) => row.listId), ["old", "new"]);
  });

  it("orders everything else by the most recent complaint", () => {
    const rows = groupReports(
      [report("a", "spam", 1), report("b", "spam", 100), report("c", "spam", 50)],
      new Map(),
    );
    assert.deepEqual(rows.map((row) => row.listId), ["b", "c", "a"]);
  });

  it("says a list is neither hidden nor reviewed when nothing is known of it", () => {
    const rows = groupReports([report("a", "spam", 1)], new Map());
    assert.equal(rows[0].hidden, false);
    assert.equal(rows[0].reviewed, false);
  });

  it("carries the reviewed mark through, so the queue can say why nothing happened", () => {
    const rows = groupReports(
      [report("a", "spam", 1)],
      new Map([["a", standing({ hidden: false, reviewed: true })]]),
    );
    assert.equal(rows[0].reviewed, true);
  });
});
