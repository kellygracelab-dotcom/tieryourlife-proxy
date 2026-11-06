import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdStaffMoves, readMovedByStaff, recordStaffMove, stillMoved } from "../src/staffMoves";

describe("recordStaffMove", () => {
  it("remembers each field staff changed, from what to what", () => {
    assert.deepEqual(
      recordStaffMove({}, { category: "food", topicId: null }, { category: "film_tv", topicId: "t1" }),
      { category: { from: "food", to: "film_tv" }, topicId: { from: null, to: "t1" } },
    );
  });

  it("remembers nothing when nothing moved", () => {
    assert.equal(recordStaffMove({}, { category: "food", topicId: "t1" }, { category: "food", topicId: "t1" }), null);
  });

  it("keeps the author's own value as from across a second move", () => {
    const first = recordStaffMove({}, { category: "food", topicId: null }, { category: "games", topicId: null });
    assert.deepEqual(
      recordStaffMove(first ?? {}, { category: "games", topicId: null }, { category: "film_tv", topicId: null }),
      { category: { from: "food", to: "film_tv" } },
    );
  });

  it("forgets a field staff moved back to where the author had it", () => {
    const earlier = { category: { from: "food", to: "games" }, topicId: { from: "t1", to: null } };
    assert.deepEqual(
      recordStaffMove(earlier, { category: "games", topicId: null }, { category: "food", topicId: null }),
      { topicId: { from: "t1", to: null } },
    );
  });
});

describe("holdStaffMoves", () => {
  const moved = { category: { from: "food", to: "film_tv" }, topicId: { from: "t1", to: "t9" } };

  it("keeps the staff's section and topic against a board that still says the old ones", () => {
    const placed = holdStaffMoves(moved, { category: "food", topic: { kind: "existing", topicId: "t1" } });
    assert.equal(placed.category, "film_tv");
    assert.deepEqual(placed.topic, { kind: "none" });
    assert.deepEqual(placed.held, moved);
  });

  it("keeps the staff's topic when the body says nothing about one", () => {
    const placed = holdStaffMoves(moved, { category: "food", topic: { kind: "none" } });
    assert.deepEqual(placed.topic, { kind: "none" });
    assert.deepEqual(placed.held.topicId, moved.topicId);
  });

  it("keeps a topic staff took off as taken off", () => {
    const placed = holdStaffMoves({ topicId: { from: "t1", to: null } }, { category: "food", topic: { kind: "existing", topicId: "t1" } });
    assert.deepEqual(placed.topic, { kind: "clear" });
  });

  it("lets the author's own new section win, and forgets that move", () => {
    const placed = holdStaffMoves(moved, { category: "games", topic: { kind: "none" } });
    assert.equal(placed.category, "games");
    assert.equal(placed.held.category, undefined);
  });

  it("lets the author's other topic, new topic or no topic win", () => {
    for (const topic of [
      { kind: "existing", topicId: "t2" },
      { kind: "new", name: "Tacos", nameLower: "tacos" },
      { kind: "clear" },
    ] as const) {
      const placed = holdStaffMoves(moved, { category: "food", topic });
      assert.deepEqual(placed.topic, topic);
      assert.equal(placed.held.topicId, undefined);
      assert.equal(placed.category, "film_tv");
    }
  });

  it("changes nothing on a list staff never moved", () => {
    const asked = { category: "food", topic: { kind: "existing", topicId: "t1" } } as const;
    assert.deepEqual(holdStaffMoves({}, asked), { ...asked, held: {} });
  });
});

describe("stillMoved", () => {
  const held = { category: { from: "food", to: "film_tv" }, topicId: { from: "t1", to: "t9" } };

  it("keeps what the stored list still shows", () => {
    assert.deepEqual(stillMoved(held, { category: "film_tv", topicId: "t9" }), held);
  });

  it("drops a move the stored list no longer shows, and is null when none is left", () => {
    assert.deepEqual(stillMoved(held, { category: "film_tv", topicId: null }), { category: held.category });
    assert.equal(stillMoved(held, { category: "games", topicId: null }), null);
  });
});

describe("readMovedByStaff", () => {
  it("reads what was stored and ignores anything malformed", () => {
    assert.deepEqual(readMovedByStaff(undefined), {});
    assert.deepEqual(readMovedByStaff({ category: { from: "a", to: 3 }, topicId: { from: null, to: "t1" } }), {
      topicId: { from: null, to: "t1" },
    });
  });
});
