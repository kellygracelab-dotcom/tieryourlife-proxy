import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideWordingConcern, ENOUGH_TO_JUDGE, wordsOf } from "../src/wording";

const verdict = (sexual = 0, derogatory = 0, profanity = 0) => ({ sexual, derogatory, profanity });

/**
 * Every number here was measured against the real classifier, not chosen.
 * The comments name what scored what, because the day somebody moves a
 * threshold they should have to argue with the measurement.
 */
describe("decideWordingConcern", () => {
  // Films, albums, war films, horror, beach photos: 0.00 to 0.14 across
  // English, Russian and Ukrainian.
  it("says nothing about an ordinary board", () => {
    assert.equal(decideWordingConcern(verdict(0.14)), "none");
  });

  // "Best diss tracks of all time" scored 0.32 sexual, 0.30 derogatory.
  it("says nothing about a board that is merely rude", () => {
    assert.equal(decideWordingConcern(verdict(0.32, 0.30)), "none");
  });

  // "Best sex scenes in cinema" scored 0.64 and is a perfectly good film
  // list. "Hottest pornstars ranked" scored 0.69 and is not. Five hundredths
  // apart, so both go to a person and neither is refused.
  it("puts both a film list about sex and a list of pornography in front of somebody", () => {
    assert.equal(decideWordingConcern(verdict(0.64)), "queue");
    assert.equal(decideWordingConcern(verdict(0.69)), "queue");
  });

  // Ukrainian and Russian lists of pornographic actresses scored 0.85 and
  // 0.91, far above anything an ordinary board reached.
  it("takes the clear cases out of the feed until somebody looks", () => {
    assert.equal(decideWordingConcern(verdict(0.85)), "hide");
    assert.equal(decideWordingConcern(verdict(0.91)), "hide");
  });

  // "Shit I have to do this week" scored 0.92 derogatory -- above an actual
  // list of people somebody wanted dead, at 0.91. Nothing acts on it.
  it("ignores derogatory entirely, however certain", () => {
    assert.equal(decideWordingConcern(verdict(0, 1)), "none");
  });

  it("ignores swearing entirely, however certain", () => {
    assert.equal(decideWordingConcern(verdict(0, 0, 1)), "none");
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
