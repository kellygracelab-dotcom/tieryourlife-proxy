import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  copyAlarmEntry,
  DENIED_LOG_EVERY_MS,
  deniedEntry,
  deniedSourceOf,
  forgetDenied,
  noteDenied,
  tallyDenied,
} from "../src/pictureAlarms";

const NOW = 1_800_000_000_000;

describe("a catalogue that answers 401 or 403", () => {
  afterEach(() => {
    forgetDenied();
    mock.restoreAll();
  });

  it("is known by its API's host", () => {
    assert.equal(deniedSourceOf("https://api.themoviedb.org/3/search/multi?query=x"), "tmdb");
    assert.equal(deniedSourceOf("https://id.twitch.tv/oauth2/token"), "igdb");
    assert.equal(deniedSourceOf("https://api.igdb.com/v4/games"), "igdb");
    assert.equal(deniedSourceOf("https://graphql.anilist.co"), "anilist");
    assert.equal(deniedSourceOf(new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/")), "steam");
    assert.equal(deniedSourceOf("https://store.steampowered.com/api/storesearch/"), "steam");
    assert.equal(deniedSourceOf("https://openlibrary.org/search.json"), "openlibrary");
    assert.equal(deniedSourceOf("https://commons.wikimedia.org/w/api.php"), "wikimedia");
    assert.equal(deniedSourceOf("https://api.inaturalist.org/v1/taxa/autocomplete"), "inaturalist");
  });

  it("is no alarm from a picture host, where a 403 is one gone picture's, nor from any other site or Deezer", () => {
    assert.equal(deniedSourceOf("https://image.tmdb.org/t/p/w500/x.jpg"), null);
    assert.equal(deniedSourceOf("https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg"), null);
    assert.equal(deniedSourceOf("https://example.com/cat.jpg"), null);
    assert.equal(deniedSourceOf("https://api.deezer.com/search/artist"), null);
    assert.equal(deniedSourceOf("https://api.themoviedb.org.example.com/3"), null);
    assert.equal(deniedSourceOf("https://toString"), null);
    assert.equal(deniedSourceOf("not an address"), null);
  });

  it("is counted every time and written the first time, then at most once a minute", () => {
    const first = tallyDenied(undefined, NOW);
    assert.deepEqual(first, { tally: { count: 1, loggedAtMs: NOW }, log: true });
    const second = tallyDenied(first.tally, NOW + 1_000);
    assert.deepEqual(second, { tally: { count: 2, loggedAtMs: NOW }, log: false });
    const third = tallyDenied(second.tally, NOW + DENIED_LOG_EVERY_MS);
    assert.deepEqual(third, { tally: { count: 3, loggedAtMs: NOW + DENIED_LOG_EVERY_MS }, log: true });
  });

  it("is written as one structured error line with the catalogue, the status and the running count", () => {
    const error = mock.method(console, "error", () => undefined);
    assert.equal(noteDenied("https://api.themoviedb.org/3/movie/603", 401, NOW), true);
    assert.equal(noteDenied("https://api.themoviedb.org/3/search/multi", 403, NOW + 10_000), false);
    assert.equal(noteDenied("https://graphql.anilist.co", 403, NOW + 10_000), true);
    assert.equal(noteDenied("https://api.themoviedb.org/3/movie/603", 401, NOW + DENIED_LOG_EVERY_MS), true);
    const lines = error.mock.calls.map((call) => JSON.parse(call.arguments[0] as string));
    assert.deepEqual(lines, [
      { severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source: "tmdb", status: 401, count: 1 },
      { severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source: "anilist", status: 403, count: 1 },
      { severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source: "tmdb", status: 401, count: 3 },
    ]);
    assert.deepEqual(deniedEntry("igdb", 403, 7), { severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source: "igdb", status: 403, count: 7 });
  });

  it("is the only answer counted: busy, missing and other sites' refusals are not", () => {
    const error = mock.method(console, "error", () => undefined);
    assert.equal(noteDenied("https://api.themoviedb.org/3/movie/603", 429, NOW), false);
    assert.equal(noteDenied("https://api.themoviedb.org/3/movie/603", 404, NOW), false);
    assert.equal(noteDenied("https://api.themoviedb.org/3/movie/603", 503, NOW), false);
    assert.equal(noteDenied("https://example.com/cat.jpg", 403, NOW), false);
    assert.equal(error.mock.callCount(), 0);
  });
});

describe("a copy kept past its time", () => {
  it("is an error line with a stable message, its catalogue, its file, who shows it and why", () => {
    assert.deepEqual(copyAlarmEntry({ source: "tmdb", path: "published/L1/w-abc", docs: ["publishedLists/L1"], reason: "refresh failed: the catalogue is busy" }), {
      severity: "ERROR",
      message: "PICTURE_ALARM",
      source: "tmdb",
      path: "published/L1/w-abc",
      docs: ["publishedLists/L1"],
      reason: "refresh failed: the catalogue is busy",
    });
  });
});
