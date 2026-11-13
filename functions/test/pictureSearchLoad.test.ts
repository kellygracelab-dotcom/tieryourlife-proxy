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
