import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideWording, ENOUGH_TO_JUDGE, wordsOf } from "../src/wording";

const verdict = (sexual = 0, derogatory = 0, profanity = 0) => ({ sexual, derogatory, profanity });

describe("decideWording", () => {
  it("lets an ordinary board through", () => {
    assert.deepEqual(decideWording(verdict()), { ok: true });
  });

  it("refuses sexual wording once the classifier is sure", () => {
    assert.deepEqual(decideWording(verdict(0.95)), { ok: false, because: "sexual" });
  });

  it("refuses abuse once the classifier is sure", () => {
    assert.deepEqual(decideWording(verdict(0, 0.95)), { ok: false, because: "derogatory" });
  });

  // Short text judged by a classifier is a coin toss dressed up as a number,
  // and a wrongly refused board is a person told their list is unacceptable
  // with no way to learn which word did it.
  it("lets through what the classifier is merely leaning towards", () => {
    assert.deepEqual(decideWording(verdict(0.7, 0.8)), { ok: true });
  });

  // A board called "Best diss tracks" is about insults. A war films board is
  // about war. Swearing in a title is how a great many people name things.
  it("never refuses on swearing alone, however certain", () => {
    assert.deepEqual(decideWording(verdict(0, 0, 1)), { ok: true });
  });

  it("names sexual first when a board is several things at once", () => {
    assert.deepEqual(decideWording(verdict(0.99, 0.99)), { ok: false, because: "sexual" });
  });
});

describe("wordsOf", () => {
  const board = {
    title: "Sci-fi films",
    tiers: [
      { label: "S", caption: "Masterpiece" },
      { label: "A", caption: null },
    ],
    items: [{ title: "Arrival" }, { title: "Dune" }],
  };

  it("gathers everything a reader will see written on the board", () => {
    assert.equal(wordsOf(board), "Sci-fi films\nS\nMasterpiece\nA\nArrival\nDune");
  });

  // Two innocent titles must not run together into a third thing.
  it("keeps each on its own line", () => {
    const run = wordsOf({ title: "t", tiers: [], items: [{ title: "pen" }, { title: "is" }] });
    assert.equal(run, "t\npen\nis");
  });

  it("drops the empty ones rather than leaving blank lines", () => {
    const sparse = wordsOf({ title: "t", tiers: [{ label: " ", caption: null }], items: [] });
    assert.equal(sparse, "t");
  });
});

describe("ENOUGH_TO_JUDGE", () => {
  // A board called "Films" is not worth an API call, and the classifier
  // refuses documents that short in any case.
  it("is short enough to let a real board through and long enough to skip a word", () => {
    assert.equal(ENOUGH_TO_JUDGE, 20);
    assert.equal(wordsOf({ title: "Films", tiers: [], items: [] }).length < ENOUGH_TO_JUDGE, true);
  });
});
