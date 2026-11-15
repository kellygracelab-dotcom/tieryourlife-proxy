import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readRemoval, removalAfter, toFullBoard } from "../src/boards";

describe("why a board is gone", () => {
  it("reads forever or cloud, cloud when a DELETE names nothing, and nothing else", () => {
    assert.equal(readRemoval("forever"), "forever");
    assert.equal(readRemoval("cloud"), "cloud");
    assert.equal(readRemoval(undefined), "cloud");
    for (const raw of ["", "FOREVER", "trash", ["forever"], 1, null]) assert.equal(readRemoval(raw), null, JSON.stringify(raw));
  });

  it("never takes forever back", () => {
    assert.equal(removalAfter(undefined, "cloud"), "cloud");
    assert.equal(removalAfter(undefined, "forever"), "forever");
    assert.equal(removalAfter("cloud", "forever"), "forever");
    assert.equal(removalAfter("forever", "cloud"), "forever");
  });

  it("is on a marker only, cloud for one from before", () => {
    assert.equal(toFullBoard("b", { revision: 2, deleted: true, deviceName: null, removal: "forever" }).removal, "forever");
    assert.equal(toFullBoard("b", { revision: 2, deleted: true, deviceName: null }).removal, "cloud");
    assert.equal("removal" in toFullBoard("b", { revision: 2, deleted: false, deviceName: null, title: "Live" }), false);
  });
});
