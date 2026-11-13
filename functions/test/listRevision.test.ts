import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBaseRevision, revisionOf, staleBase } from "../src/listRevision";

describe("a published list's revision", () => {
  it("is 0 on a list stored before revisions, and only ever a whole number", () => {
    assert.equal(revisionOf(undefined), 0);
    assert.equal(revisionOf({}), 0);
    assert.equal(revisionOf({ revision: 7 }), 7);
    assert.equal(revisionOf({ revision: -1 }), 0);
    assert.equal(revisionOf({ revision: 1.5 }), 0);
    assert.equal(revisionOf({ revision: "3" }), 0);
  });

  it("reads baseRevision: absent or null is not checked, a whole number from 0 is, anything else is refused", () => {
    assert.equal(readBaseRevision({}), null);
    assert.equal(readBaseRevision(null), null);
    assert.equal(readBaseRevision({ baseRevision: null }), null);
    assert.equal(readBaseRevision({ baseRevision: 0 }), 0);
    assert.equal(readBaseRevision({ baseRevision: 12 }), 12);
    for (const wrong of ["12", -1, 1.5, true, {}]) assert.equal(readBaseRevision({ baseRevision: wrong }), "invalid");
  });

  it("is stale only when the client said what it read and the list has moved on", () => {
    assert.equal(staleBase(null, { revision: 4 }), false);
    assert.equal(staleBase(4, { revision: 4 }), false);
    assert.equal(staleBase(3, { revision: 4 }), true);
    assert.equal(staleBase(0, {}), false);
    assert.equal(staleBase(1, {}), true);
  });
});
