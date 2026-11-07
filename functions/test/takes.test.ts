import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countsAsTake } from "../src/takes";

describe("countsAsTake", () => {
  const take = { takerUid: "reader", authorUid: "author", weighs: true, alreadyTaken: false };

  it("counts a weighing account's first take of somebody else's list", () => {
    assert.equal(countsAsTake(take), true);
  });

  it("counts once per account", () => {
    assert.equal(countsAsTake({ ...take, alreadyTaken: true }), false);
  });

  it("never counts the author", () => {
    assert.equal(countsAsTake({ ...take, takerUid: "author" }), false);
  });

  it("does not count a guest, a banned account or a fresh one", () => {
    assert.equal(countsAsTake({ ...take, weighs: false }), false);
  });
});
