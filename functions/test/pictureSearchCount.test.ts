/**
 * How many requests one new "all" search sends out: a quick answer, then the
 * whole one, as both apps ask. The catalogues answer as they do for a word
 * like "lion": iNaturalist finds eight animals, seven without an open default
 * photo, three of which have one among the taxon's own photos.
 *
 * Written against `searchPictures` alone, so it runs on the code before this
 * change as well: there it counted 33 requests (16 quick, 17 whole).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as emulator from "../src/emulator";
import { install, type Fakes } from "./fakeFirebase";
import * as pictureSearch from "../src/pictureSearch";
import { catalogueAnswer } from "./pictureCatalogueFixtures";

const { igdbClientId, igdbClientSecret, pictureTmdbToken, searchPictures } = pictureSearch;

let fakes: Fakes;
let asked: URL[];
beforeEach(() => {
  fakes = install();
  asked = [];
  delete process.env.SERPER_API_KEY;
  mock.method(emulator, "isDemoEmulator", () => false);
  mock.method(pictureTmdbToken, "value", () => "tmdb-token");
  mock.method(igdbClientId, "value", () => "igdb-id");
  mock.method(igdbClientSecret, "value", () => "igdb-secret");
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url);
    return Response.json(catalogueAnswer(url));
  });
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

/** Requests by host, without Twitch's token: one per instance every couple of months. */
const sent = () => asked.filter((url) => url.host !== "id.twitch.tv");
const ask = (quick: boolean) =>
  searchPictures({ typed: "Lion", scope: "all", language: "en", page: 1, forcedWeb: false, quick, uid: "someone" });

describe("one new 'all' search", () => {
  it("sends each catalogue only what it has not answered yet", async () => {
    const quick = await ask(true);
    assert.ok(quick && "items" in quick && quick.items.length > 0);
    const quickRequests = sent().length;
    const whole = await ask(false);
    assert.ok(whole && "items" in whole && whole.items.some((hit) => hit.source === "openlibrary"));
    const wholeRequests = sent().length - quickRequests;
    console.log(`Outgoing requests for one new "all" search: quick ${quickRequests}, whole ${wholeRequests}, together ${quickRequests + wholeRequests}`);
    // tmdb 1, anilist 1, igdb 1, steam 2, wikidata 3, iNaturalist: autocomplete, the taxa, and observations for the four still without.
    assert.equal(quickRequests, 14);
    // Only Open Library is new to the whole search.
    assert.deepEqual(sent().slice(quickRequests).map((url) => url.host), ["openlibrary.org"]);
    assert.equal(wholeRequests, 1);
  });
});
