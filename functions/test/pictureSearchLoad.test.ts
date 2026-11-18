import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import * as emulator from "../src/emulator";
import type { Identity } from "../src/auth";
import { install, type Fakes } from "./fakeFirebase";
import { catalogueAnswer } from "./pictureCatalogueFixtures";
import { forgetCatalogueRests, igdbClientId, igdbClientSecret, pictureTmdbToken, routePictures } from "../src/pictureSearch";
import { chargeSearch, PICTURE_SEARCHES_PER_DAY, PICTURE_SEARCHES_PER_HOUR, retryAfterSeconds } from "../src/pictureSearchLimit";
import { CATALOGUE_REST_MS, restUntil } from "../src/pictureSources";

const NOW = Date.parse("2026-11-13T10:20:30Z");
const NEXT_HOUR = Date.parse("2026-11-13T11:00:00Z");
const MIDNIGHT = Date.parse("2026-11-14T00:00:00Z");
const DAY_DOC = "pictureSearches/2026-11-13/users/someone";

describe("searches per person", () => {
  it("counts within the hour and the UTC day", () => {
    assert.deepEqual(chargeSearch(undefined, NOW), { allowed: true, next: { count: 1, hour: Math.floor(NOW / 3_600_000), hourCount: 1 } });
    const hour = Math.floor(NOW / 3_600_000);
    assert.deepEqual(chargeSearch({ count: 10, hour: hour - 1, hourCount: 999 }, NOW), { allowed: true, next: { count: 11, hour, hourCount: 1 } });
  });

  it("refuses past the hour until the next hour, and past the day until UTC midnight", () => {
    const hour = Math.floor(NOW / 3_600_000);
    assert.deepEqual(chargeSearch({ count: PICTURE_SEARCHES_PER_HOUR, hour, hourCount: PICTURE_SEARCHES_PER_HOUR }, NOW), { allowed: false, retryAtMs: NEXT_HOUR });
    assert.deepEqual(chargeSearch({ count: PICTURE_SEARCHES_PER_DAY, hour, hourCount: 3 }, NOW), { allowed: false, retryAtMs: MIDNIGHT });
    assert.equal(PICTURE_SEARCHES_PER_HOUR, 1000);
    assert.equal(PICTURE_SEARCHES_PER_DAY, 3000);
  });

  it("names Retry-After in whole seconds, at least one", () => {
    assert.equal(retryAfterSeconds(NEXT_HOUR, NOW), 2370);
    assert.equal(retryAfterSeconds(NOW + 1, NOW), 1);
    assert.equal(retryAfterSeconds(NOW - 5000, NOW), 1);
  });
});

describe("a catalogue's rest", () => {
  it("follows Retry-After in seconds or as a date, and otherwise rests five minutes", () => {
    assert.equal(restUntil(429, "120", NOW), NOW + 120_000);
    assert.equal(restUntil(503, new Date(NOW + 90_000).toUTCString(), NOW), NOW + 90_000);
    assert.equal(restUntil(500, null, NOW), NOW + CATALOGUE_REST_MS);
    assert.equal(restUntil(429, "soon", NOW), NOW + CATALOGUE_REST_MS);
    assert.equal(CATALOGUE_REST_MS, 5 * 60_000);
  });

  it("never lasts more than an hour, and is no rest for an answer about the request", () => {
    assert.equal(restUntil(429, "86400", NOW), NOW + 60 * 60_000);
    assert.equal(restUntil(404, "120", NOW), null);
    assert.equal(restUntil(400, null, NOW), null);
  });
});

// Through the route, as a client asks.

let fakes: Fakes;
let asked: URL[];
let now: number;
let refuse: Map<string, { status: number; retryAfter?: string }>;

beforeEach(() => {
  fakes = install();
  asked = [];
  now = NOW;
  refuse = new Map();
  forgetCatalogueRests();
  delete process.env.SERPER_API_KEY;
  mock.method(Date, "now", () => now);
  mock.method(emulator, "isDemoEmulator", () => false);
  mock.method(pictureTmdbToken, "value", () => "tmdb-token");
  mock.method(igdbClientId, "value", () => "igdb-id");
  mock.method(igdbClientSecret, "value", () => "igdb-secret");
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url);
    const refusal = refuse.get(url.host) ?? refuse.get(url.host + url.pathname);
    if (refusal) return new Response("busy", { status: refusal.status, headers: refusal.retryAfter ? { "Retry-After": refusal.retryAfter } : {} });
    return Response.json(catalogueAnswer(url));
  });
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function get(query: Record<string, string>, uid = "someone"): Promise<Reply> {
  const reply: Reply = { status: 0, body: {}, headers: {} };
  const response = {
    status(code: number) {
      reply.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      reply.body = body;
      return response;
    },
    setHeader(name: string, value: string) {
      reply.headers[name] = value;
      return response;
    },
  };
  await routePictures("GET", [], { q: "Lion", scope: "all", lang: "en", ...query }, null, response as never, { uid } as Identity);
  return reply;
}

const hosts = () => asked.map((url) => url.host).filter((host) => host !== "id.twitch.tv");
const counted = () => fakes.db.get(DAY_DOC)?.hourCount;

describe("GET /lists/pictures under load", () => {
  it("shows the same order when the same search comes back from the cache", async () => {
    const ids = (reply: Reply) => (reply.body.items as { id: string }[]).map((one) => one.id);
    const quick = await get({ part: "quick", q: "Lion", scope: "all" });
    const whole = await get({ q: "Lion", scope: "all" });
    assert.ok(ids(quick).length > 0);
    // Open Library answers only the whole search, with a title as exact as Wikidata's: it comes below.
    assert.deepEqual(ids(whole).slice(ids(quick).length), ["openlibrary:OL1W"]);
    assert.deepEqual(ids(whole).slice(0, ids(quick).length), ids(quick));
    const before = asked.length;
    assert.deepEqual(ids(await get({ part: "quick", q: "Lion", scope: "all" })), ids(whole));
    assert.equal(asked.length, before);
  });

  it("asks nothing and counts nothing for a string without a letter or a digit", async () => {
    for (const q of ["!!!???", "😀😀"]) {
      const quick = await get({ part: "quick", q });
      assert.deepEqual([quick.status, quick.body], [200, { items: [], hasMore: false, notices: [], rest: false }]);
      assert.deepEqual((await get({ q })).body, { items: [], hasMore: false, notices: [] });
    }
    assert.equal(asked.length, 0);
    assert.equal(counted(), undefined);
  });

  it("answers a phone's en-US from what the site's en search kept", async () => {
    await get({ lang: "en" });
    const before = asked.length;
    assert.equal((await get({ lang: "en-US" })).status, 200);
    assert.equal(asked.length, before);
    assert.equal(counted(), 1);
  });

  it("counts a quick search and the whole one after it as one", async () => {
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.equal((await get({})).status, 200);
    assert.equal(counted(), 1);
    assert.equal(fakes.db.get(DAY_DOC)?.count, 1);
  });

  it("counts a next page as a search of its own, and an answer already kept as none", async () => {
    await get({ part: "quick" });
    await get({});
    await get({ page: "2" });
    assert.equal(counted(), 2);
    const before = asked.length;
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.equal((await get({})).status, 200);
    assert.equal(asked.length, before);
    assert.equal(counted(), 2);
  });

  it("refuses past the limit with SEARCH_LIMIT, retryAt and Retry-After, asks nothing and counts nothing", async () => {
    fakes.db.seed(DAY_DOC, { count: 1500, hour: Math.floor(NOW / 3_600_000), hourCount: PICTURE_SEARCHES_PER_HOUR });
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await get({ part: "quick" });
      assert.equal(reply.status, 429);
      assert.deepEqual(reply.body, { error: "Too many picture searches", code: "SEARCH_LIMIT", retryAt: NEXT_HOUR });
      assert.equal(reply.headers["Retry-After"], "2370");
    }
    assert.deepEqual(asked, []);
    assert.equal(fakes.db.get(DAY_DOC)?.count, 1500);
  });

  it("still serves an answer already kept to a person past the limit", async () => {
    await get({ part: "quick" });
    await get({});
    fakes.db.seed(DAY_DOC, { count: PICTURE_SEARCHES_PER_DAY, hour: 0, hourCount: 0 });
    asked = [];
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.equal((await get({})).status, 200);
    assert.deepEqual(asked, []);
    const other = await get({ part: "quick", q: "Tiger" });
    assert.equal(other.status, 429);
    assert.equal(other.body.retryAt, MIDNIGHT);
  });

  it("lets each person search on their own count", async () => {
    fakes.db.seed(DAY_DOC, { count: PICTURE_SEARCHES_PER_DAY, hour: 0, hourCount: 0 });
    assert.equal((await get({ part: "quick" }, "someone-else")).status, 200);
  });
});

describe("a catalogue that refuses", () => {
  it("rests for its Retry-After while the others answer, and its gap is not kept", async () => {
    refuse.set("graphql.anilist.co", { status: 429, retryAfter: "120" });
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.equal(hosts().filter((host) => host === "graphql.anilist.co").length, 1);
    const rest = fakes.db.get("config/pictureSources")?.anilist as { offUntil: Timestamp; lastStatus: number };
    assert.equal(rest.offUntil.toMillis(), NOW + 120_000);
    assert.equal(rest.lastStatus, 429);

    // Another search a minute later: AniList is not asked, the rest are.
    refuse.clear();
    now = NOW + 60_000;
    asked = [];
    const later = await get({ part: "quick", q: "Tiger" });
    assert.equal(later.status, 200);
    assert.ok(!hosts().includes("graphql.anilist.co"));
    assert.ok(hosts().includes("api.themoviedb.org"));

    // Past its rest, AniList is asked again, including for the first search, whose gap was not kept as an answer.
    now = NOW + 121_000;
    forgetCatalogueRests();
    asked = [];
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.deepEqual(hosts(), ["graphql.anilist.co"]);
  });

  it("rests five minutes after a 5xx with no Retry-After, read by another instance from Firestore", async () => {
    refuse.set("openlibrary.org", { status: 503 });
    await get({ part: "quick" });
    await get({});
    const until = (fakes.db.get("config/pictureSources")?.openlibrary as { offUntil: Timestamp }).offUntil.toMillis();
    assert.equal(until, NOW + CATALOGUE_REST_MS);
    refuse.clear();
    forgetCatalogueRests();
    now = NOW + CATALOGUE_REST_MS - 1000;
    asked = [];
    await get({ q: "Tiger", part: "quick" });
    await get({ q: "Tiger" });
    assert.ok(!hosts().includes("openlibrary.org"));
  });

  it("takes no rest after a refusal about the request itself", async () => {
    refuse.set("openlibrary.org", { status: 422 });
    await get({ part: "quick" });
    await get({});
    assert.equal(fakes.db.get("config/pictureSources"), undefined);
  });

  it("leaves iNaturalist resting when a side request of its own was refused", async () => {
    refuse.set("api.inaturalist.org/v1/observations", { status: 429, retryAfter: "60" });
    assert.equal((await get({ part: "quick" })).status, 200);
    assert.ok(fakes.db.get("config/pictureSources")?.inaturalist);
  });

  it("answers SOURCE_BUSY with when to ask again when every catalogue is resting, and asks none of them meanwhile", async () => {
    for (const host of ["api.themoviedb.org", "graphql.anilist.co", "api.igdb.com", "store.steampowered.com", "api.inaturalist.org", "www.wikidata.org", "openlibrary.org"]) {
      refuse.set(host, { status: 503 });
    }
    // A quick answer still has the whole search to come.
    const quick = await get({ part: "quick" });
    assert.equal(quick.status, 200);
    assert.equal(quick.body.rest, true);
    const whole = await get({});
    assert.equal(whole.status, 503);
    assert.deepEqual(whole.body, {
      error: "A catalogue this search needs is busy",
      code: "SOURCE_BUSY",
      retryAt: NOW + CATALOGUE_REST_MS,
      busy: ["tmdb", "anilist", "igdb", "steam", "openlibrary", "inaturalist", "wikidata"],
    });
    assert.equal(whole.headers["Retry-After"], String(CATALOGUE_REST_MS / 1000));
    asked = [];
    assert.equal((await get({ q: "Tiger" })).status, 503);
    assert.deepEqual(hosts(), []);
  });

  it("answers SOURCES_DOWN, as before, when every catalogue failed without asking us to wait", async () => {
    for (const host of ["api.themoviedb.org", "graphql.anilist.co", "api.igdb.com", "store.steampowered.com", "api.inaturalist.org", "www.wikidata.org", "openlibrary.org"]) {
      refuse.set(host, { status: 404 });
    }
    const whole = await get({});
    assert.equal(whole.status, 502);
    assert.equal(whole.body.code, "SOURCES_DOWN");
  });

  it("says AniList is busy instead of finding nothing, keeps no answer, and asks AniList again once its rest is over", async () => {
    refuse.set("graphql.anilist.co", { status: 429, retryAfter: "60" });
    refuse.set("www.wikidata.org", { status: 404 });
    for (const part of [{ part: "quick" }, {}] as Record<string, string>[]) {
      const busy = await get({ scope: "anime", ...part });
      assert.equal(busy.status, 503, JSON.stringify(busy.body));
      assert.deepEqual([busy.body.code, busy.body.retryAt, busy.body.busy, busy.headers["Retry-After"]], ["SOURCE_BUSY", NOW + 60_000, ["anilist"], "60"]);
    }
    // Another catalogue finds something while AniList rests: shown, with AniList's gap named.
    refuse.delete("www.wikidata.org");
    asked = [];
    const partial = await get({ scope: "all" });
    assert.equal(partial.status, 200);
    assert.ok((partial.body.items as unknown[]).length > 0);
    assert.deepEqual([partial.body.busy, partial.body.retryAt], [["anilist"], NOW + 60_000]);
    assert.ok(!hosts().includes("graphql.anilist.co"));

    refuse.clear();
    now = NOW + 61_000;
    forgetCatalogueRests();
    asked = [];
    const back = await get({ scope: "anime" });
    assert.equal(back.status, 200);
    assert.ok(hosts().includes("graphql.anilist.co"));
    assert.equal(back.body.busy, undefined);
  });
});

describe("iNaturalist", () => {
  it("asks for observations only for taxa still without an open photo after the taxa's own", async () => {
    await get({ part: "quick", scope: "animals" });
    const inaturalist = asked.filter((url) => url.host === "api.inaturalist.org").map((url) => url.pathname);
    assert.deepEqual(inaturalist.slice(0, 2), ["/v1/taxa/autocomplete", "/v1/taxa/2,3,4,5,6,7,8"]);
    const observed = asked.filter((url) => url.pathname === "/v1/observations").map((url) => url.searchParams.get("taxon_id"));
    assert.deepEqual(observed, ["5", "6", "7", "8"]);
  });
});

describe("stage 1: the list's section, how sure, a second attempt", () => {
  type Item = { id: string; confidence?: string; doubts?: string[]; matchedName?: string };
  const items = (reply: Reply) => reply.body.items as Item[];

  it("judges every hit, puts a film section's films first in all, and Wikidata first in Other", async () => {
    const before = await get({ q: "Lion", scope: "all" });
    const other = await get({ q: "Lion", scope: "all", section: "other" });
    // A film list looked up in all: the film first, as if the scope were the section's.
    const film = await get({ q: "Lion", scope: "all", section: "film_tv" });
    assert.equal(items(film)[0]?.id, "tmdb:8587");
    assert.equal(items(other)[0]?.id, "wikidata:Q140");
    // Other says nothing of what the list holds, and Open Library has a "Lion" too.
    assert.equal(items(other)[0]?.confidence, "medium");
    assert.deepEqual(items(other)[0]?.doubts, ["noSection", "namesakes"]);
    assert.ok(items(before).every((one) => one.confidence !== undefined));
  });

  it("reads what a section of somebody's own holds from its names, and a topic's under Other", async () => {
    const { wantOf } = await import("../src/pictureSearch");
    fakes.db.seed("sections/cities1", { name: "Cities", names: { uk: "Міста" } });
    fakes.db.seed("sections/stuff", { name: "Stuff" });
    fakes.db.seed("topics/brands1", { name: "Tech brands" });
    assert.deepEqual(await wantOf("cities1", null), { kind: "type", type: "places" });
    assert.deepEqual(await wantOf("stuff", null), { kind: "general" });
    assert.deepEqual(await wantOf("other", "brands1"), { kind: "type", type: "brands" });
    assert.deepEqual(await wantOf("food", "brands1"), { kind: "type", type: "food" });
    assert.deepEqual(await wantOf("missing", null), { kind: "general" });
    assert.equal(await wantOf(null, null), null);
  });

  it("searches again as Wikipedia spells a name that found nothing like it, counted once", async () => {
    const plain = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "en.wikipedia.org") {
        asked.push(url);
        return Response.json({ query: { searchinfo: { suggestion: "lion" }, search: [] } });
      }
      return plain(input);
    });
    const typo = await get({ q: "Lyon kng", scope: "all", section: "other" });
    assert.equal(typo.status, 200);
    assert.deepEqual(typo.body.searchedAs, { text: "lion", how: "spelling" });
    assert.equal(items(typo)[0]?.id, "wikidata:Q140");
    assert.deepEqual(items(typo)[0]?.doubts?.[0], "spelling");
    assert.notEqual(items(typo)[0]?.confidence, "high");
    assert.equal(counted(), 1);
    // Asked again, the attempt chosen is kept: Wikipedia is not asked twice.
    const wikipedia = () => asked.filter((url) => url.host === "en.wikipedia.org").length;
    const once = wikipedia();
    await get({ q: "Lyon kng", scope: "all", section: "other" });
    assert.equal(wikipedia(), once);
  });

  it("asks iNaturalist for plants in all, and for animals alone in the animals scope", async () => {
    await get({ part: "quick", scope: "all" });
    await get({ part: "quick", scope: "animals" });
    const taxa = asked.filter((url) => url.pathname === "/v1/taxa/autocomplete").map((url) => url.searchParams.get("taxon_id"));
    assert.deepEqual(taxa, ["1,47126", "1"]);
  });
});

describe("stage 1b: the web's first pictures when nothing is found", () => {
  type Hit = { id: string; source: string; attribution?: { source: string; link?: string }; confidence?: string; doubts?: string[] };
  const items = (reply: Reply) => reply.body.items as Hit[];
  const web = () => asked.filter((url) => url.host === "google.serper.dev").length;

  it("asks the web once in a scope of its own and shows its first five, with their pages", async () => {
    process.env.SERPER_API_KEY = "test-key";
    // TMDB finds only The Lion King, nothing like "Zzqx", and Wikipedia suggests nothing.
    const quick = await get({ part: "quick", q: "Zzqx", scope: "film_tv" });
    assert.equal(quick.body.rest, true);
    assert.equal(web(), 0);
    const whole = await get({ q: "Zzqx", scope: "film_tv" });
    const found = items(whole).filter((hit) => hit.source === "web");
    assert.equal(found.length, 5);
    assert.equal(items(whole)[0]?.source, "tmdb");
    assert.deepEqual(found[0]?.attribution, { source: "web", link: "https://page.example/1" });
    assert.equal(found[0]?.confidence, "low");
    assert.deepEqual(found[0]?.doubts, ["web"]);
    assert.equal(web(), 1);
    // Asked again, the pictures are kept with the search: the web is not paid twice.
    assert.deepEqual(items(await get({ q: "Zzqx", scope: "film_tv" })).map((hit) => hit.id), items(whole).map((hit) => hit.id));
    assert.equal(web(), 1);
  });

  it("leaves a search that found its name alone", async () => {
    process.env.SERPER_API_KEY = "test-key";
    const whole = await get({ q: "The Lion King", scope: "film_tv" });
    assert.equal(items(whole).some((hit) => hit.source === "web"), false);
    assert.equal(web(), 0);
  });

  it("works as before without a web key", async () => {
    const quick = await get({ part: "quick", q: "Zzqx", scope: "film_tv" });
    assert.equal(quick.body.rest, false);
    const whole = await get({ q: "Zzqx", scope: "film_tv" });
    assert.equal(items(whole).some((hit) => hit.source === "web"), false);
    assert.equal(web(), 0);
  });

  it("takes Wikimedia's error inside a 200 for a failure, not for nothing found to keep", async () => {
    const plain = globalThis.fetch;
    let sayError = true;
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "www.wikidata.org" && sayError) {
        asked.push(url);
        return Response.json({ error: { code: "ratelimited", info: "You've exceeded your rate limit." } });
      }
      return plain(input);
    });
    const wikidata = (reply: Reply) => items(reply).filter((hit) => hit.source === "wikidata").length;
    assert.equal(wikidata(await get({ q: "Lion", scope: "all", section: "other" })), 0);
    sayError = false;
    // Not kept: asked again, Wikidata answers.
    assert.equal(wikidata(await get({ q: "Lion", scope: "all", section: "other" })), 1);
  });

  it("pays for the web once in all, not again for the second attempt's text", async () => {
    process.env.SERPER_API_KEY = "test-key";
    await get({ q: "Zzqx смотреть онлайн", scope: "all" });
    assert.equal(web(), 1);
  });
});
