import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newTrace, noteCache, noteResting, timed, timedSource, traced, traceFields } from "../src/searchTiming";

describe("a picture search's timing (25.11.2026)", () => {
  it("collects each catalogue's time, what failed, the cache and the steps, inside its own search only", async () => {
    const trace = newTrace("quick", 1_000);
    const other = newTrace("full", 1_000);
    await Promise.all([
      traced(trace, async () => {
        noteCache("parts 1");
        await timed("store", async () => undefined);
        assert.deepEqual(await timedSource("tmdb", async () => ({ hits: [] })), { hits: [] });
      }),
      traced(other, async () => {
        await timedSource("wikidata", async () => null);
        noteResting(["igdb", "igdb"]);
      }),
    ]);
    assert.deepEqual(trace.cache, ["parts 1"]);
    assert.equal(trace.sources.tmdb?.length, 1);
    assert.deepEqual(trace.failed, []);
    assert.equal(typeof trace.steps.store, "number");
    assert.deepEqual(other.failed, ["wikidata"]);
    assert.deepEqual(other.resting, ["igdb"]);
    assert.deepEqual(other.cache, []);
  });

  it("does nothing outside a traced search", async () => {
    noteCache("miss");
    noteResting(["tmdb"]);
    assert.equal(await timed("web", async () => 7), 7);
    assert.equal(await timedSource("tmdb", async () => 8), 8);
  });

  it("writes one line with no query text and no uid", () => {
    const trace = newTrace("full", 1_000);
    trace.cache.push("miss");
    trace.sources.wikidata = [2_400];
    trace.failed.push("deezer");
    const fields = traceFields(trace, { scope: "film_tv", page: 1, letters: 7, status: 200 }, 3_500);
    assert.deepEqual(fields, {
      message: "Picture search timing", part: "full", scope: "film_tv", page: 1, letters: 7, status: 200, ms: 2_500,
      cache: ["miss"], sources: { wikidata: [2_400] }, failed: ["deezer"], steps: {},
    });
  });
});
