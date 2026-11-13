import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { busyAnswer, busyGap } from "../src/pictureSearch";

const NOW = 1_800_000_000_000;

describe("a catalogue that is busy during a search", () => {
  it("leaves a gap that is named, with the time all of them may be asked again", () => {
    const resting = new Map([["anilist", NOW + 60_000], ["steam", NOW + 300_000], ["igdb", NOW - 1]] as const);
    assert.deepEqual(busyGap(["anilist", "wikidata"], new Set(["wikidata"]), resting, NOW), { busy: ["anilist"], retryAt: NOW + 60_000 });
    assert.deepEqual(busyGap(["tmdb", "anilist", "igdb", "steam", "wikidata"], new Set(["tmdb", "wikidata"]), resting, NOW), { busy: ["anilist", "steam"], retryAt: NOW + 300_000 });
  });

  it("is no gap once it answered, or when its rest is over, or when it failed without asking us to wait", () => {
    const resting = new Map([["anilist", NOW + 60_000], ["igdb", NOW]] as const);
    assert.deepEqual(busyGap(["anilist", "wikidata"], new Set(["anilist", "wikidata"]), resting, NOW), {});
    assert.deepEqual(busyGap(["igdb", "steam", "wikidata"], new Set(["wikidata"]), resting, NOW), {});
  });

  it("makes an answer with nothing found SOURCE_BUSY, not \"nothing by that name\"", () => {
    const gap = { busy: ["anilist" as const], retryAt: NOW + 60_000 };
    assert.equal(busyAnswer({ items: [], hasMore: false, notices: [], ...gap }), true);
    // Something was found: shown, with the gap named beside it.
    assert.equal(busyAnswer({ items: [{ id: "wikidata:Q1", title: "Naruto", subtitle: null, imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Naruto.jpg?width=600", thumbUrl: null, source: "wikidata", kind: "thing" }], hasMore: false, notices: [], ...gap }), false);
    // A quick answer whose whole search is still to come is not the last word.
    assert.equal(busyAnswer({ items: [], hasMore: false, notices: [], rest: true, ...gap }), false);
    assert.equal(busyAnswer({ items: [], hasMore: false, notices: [] }), false);
  });
});
