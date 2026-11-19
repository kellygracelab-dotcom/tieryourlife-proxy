import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import * as emulator from "../src/emulator";
import type { Identity } from "../src/auth";
import { install, type Fakes } from "./fakeFirebase";
import { catalogueAnswer } from "./pictureCatalogueFixtures";
import { forgetCatalogueRests, forgetIgdbOpen, igdbClientId, igdbClientSecret, pictureTmdbToken, routePictures } from "../src/pictureSearch";
import { forgetDenied } from "../src/pictureAlarms";
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
  forgetIgdbOpen();
  forgetDenied();
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

async function post(rest: string[], body: unknown, uid = "someone"): Promise<Reply> {
  const reply: Reply = { status: 0, body: {}, headers: {} };
  const response = {
    status(code: number) {
      reply.status = code;
      return response;
    },
    json(sent: Record<string, unknown>) {
      reply.body = sent;
      return response;
    },
    setHeader(name: string, value: string) {
      reply.headers[name] = value;
      return response;
    },
  };
  await routePictures("POST", rest, {}, body, response as never, { uid } as Identity);
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

describe("POST /lists/pictures/keep", () => {
  it("refuses a guest before fetching anything (QA D9)", async () => {
    const reply: Reply = { status: 0, body: {}, headers: {} };
    const response = { status(code: number) { reply.status = code; return response; }, json(body: Record<string, unknown>) { reply.body = body; return response; }, setHeader() { return response; } };
    await routePictures("POST", ["keep"], {}, { url: "https://upload.wikimedia.org/x.jpg" }, response as never, { uid: "guest", isAnonymous: true } as Identity);
    assert.deepEqual([reply.status, reply.body.code], [403, "NOT_SIGNED_IN"]);
    assert.equal(asked.length, 0);
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

  /** Wikipedia suggests [suggestion] for every name. */
  function wikipediaSays(suggestion: string): void {
    const plain = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "en.wikipedia.org") {
        asked.push(url);
        return Response.json({ query: { searchinfo: { suggestion }, search: [] } });
      }
      return plain(input);
    });
  }

  it("takes Wikipedia's spelling when the name found only things like it, and one by exactly that name (QA D6)", async () => {
    wikipediaSays("lion");
    // "Lio" begins "Lion": something like it, nothing called it.
    const typo = await get({ q: "Lio", scope: "all" });
    assert.deepEqual(typo.body.searchedAs, { text: "lion", how: "spelling" });
    assert.equal(counted(), 1);
  });

  it("keeps what was found when the spelling finds nothing by that name", async () => {
    wikipediaSays("lioness");
    const typo = await get({ q: "Lio", scope: "all" });
    assert.equal(typo.status, 200);
    assert.equal(typo.body.searchedAs, undefined);
    assert.ok(items(typo).length > 0);
  });

  it("never spells a number into another (QA D2)", async () => {
    wikipediaSays("Lion 1988");
    const year = await get({ q: "Lion 1984", scope: "all" });
    assert.equal(year.body.searchedAs, undefined);
    assert.ok(!asked.some((url) => url.host !== "en.wikipedia.org" && url.searchParams.toString().includes("1988")));
  });

  it("asks iNaturalist for plants in all, and for animals alone in the animals scope", async () => {
    await get({ part: "quick", scope: "all" });
    await get({ part: "quick", scope: "animals" });
    const taxa = asked.filter((url) => url.pathname === "/v1/taxa/autocomplete").map((url) => url.searchParams.get("taxon_id"));
    assert.deepEqual(taxa, ["1,47126", "1"]);
  });
});

describe("stage 2: the item the name means, first", () => {
  type Hit = { id: string; source: string; kind: string; confidence?: string; doubts?: string[] };
  const items = (reply: Reply) => reply.body.items as Hit[];
  const value = (id: string) => ({ mainsnak: { snaktype: "value", datavalue: { value: { id } } } });
  const text = (value: string) => ({ mainsnak: { snaktype: "value", datavalue: { value } } });

  /** Wikidata knows The Lion King as a film with its TMDB id; Wikipedia's search finds it first. */
  function lionKing(withTmdbId = true): void {
    const plain = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const action = url.searchParams.get("action");
      if (url.host === "www.wikidata.org" && action === "wbsearchentities") {
        asked.push(url);
        return Response.json({ search: [{ id: "Q36479" }, { id: "Q140" }] });
      }
      if (url.host === "www.wikidata.org" && action === "wbgetentities") {
        asked.push(url);
        return Response.json({ entities: {
          Q36479: {
            labels: { en: { value: "The Lion King" } },
            descriptions: { en: { value: "1994 American animated film" } },
            sitelinks: Object.fromEntries(Array.from({ length: 80 }, (_, at) => [`wiki${at}`, {}])),
            claims: { P31: [value("Q11424")], ...(withTmdbId ? { P4947: [text("8587")] } : {}), P18: [text("Lion waiting.jpg")] },
          },
          Q140: {
            labels: { en: { value: "Lion" } },
            descriptions: { en: { value: "big cat" } },
            sitelinks: { enwiki: {} },
            claims: { P31: [value("Q16521")], P18: [text("Lion waiting.jpg")] },
          },
        } });
      }
      if (url.host === "en.wikipedia.org" && url.searchParams.get("generator") === "search") {
        asked.push(url);
        return Response.json({ query: { pages: { "1": { index: 1, pageprops: { wikibase_item: "Q36479" } } } } });
      }
      if (url.host === "api.themoviedb.org" && url.pathname === "/3/movie/8587") {
        asked.push(url);
        return Response.json({ id: 8587, title: "The Lion King", poster_path: "/king.jpg", release_date: "1994-06-15" });
      }
      return plain(input);
    });
  }

  it("puts a film list's film first, its poster from TMDB by its id, and is sure of it", async () => {
    lionKing();
    const reply = await get({ q: "Lion King", scope: "all", section: "film_tv" });
    assert.equal(reply.status, 200);
    const first = items(reply)[0];
    assert.equal(first?.id, "tmdb:8587");
    assert.equal(first?.confidence, "high");
    assert.equal(first?.doubts, undefined);
    assert.ok(asked.some((url) => url.pathname === "/3/movie/8587"));
    assert.ok(asked.some((url) => url.host === "en.wikipedia.org"));
    // Nothing of the choice itself is sent.
    assert.equal("chosen" in reply.body, false);
  });

  it("shows Wikidata's items as the kind their classes make them", async () => {
    // Without its TMDB id, no TMDB twin takes the film's place.
    lionKing(false);
    const reply = await get({ q: "Lion", scope: "all", section: "other" });
    assert.equal(items(reply).find((hit) => hit.id === "wikidata:Q36479")?.kind, "movie");
  });

  it("answers a whole list's names in one request, each the first picture and how sure, in the order sent", async () => {
    lionKing();
    const reply = await post(["batch"], { names: ["Lion King", "!!", "Lion"], scope: "all", section: "film_tv", lang: "en" });
    assert.equal(reply.status, 200);
    const results = reply.body.results as { q: string; status: string; item?: Hit }[];
    assert.deepEqual(results.map((result) => result.q), ["Lion King", "!!", "Lion"]);
    assert.equal(results[0]?.status, "found");
    assert.equal(results[0]?.item?.id, "tmdb:8587");
    assert.equal(results[1]?.status, "none");
    assert.ok(["found", "unsure"].includes(results[2]?.status ?? ""));
    // Each name is a search of its own, counted as one.
    assert.equal(counted(), 2);
  });

  it("refuses a batch with no names, too many, or one that is not text", async () => {
    for (const names of [[], Array.from({ length: 11 }, (_, at) => `Name ${at}`), ["Lion", 7], "Lion"]) {
      const reply = await post(["batch"], { names, scope: "all" });
      assert.equal(reply.status, 400);
      assert.equal(reply.body.code, "BAD_NAMES");
    }
  });

  it("asks Wikidata's items in chunks of ten and keeps what the chunks that answer hold", async () => {
    const plain = globalThis.fetch;
    const chunks: string[][] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const action = url.searchParams.get("action");
      if (url.host === "www.wikidata.org" && action === "wbsearchentities") {
        return Response.json({ search: Array.from({ length: 25 }, (_, at) => ({ id: `Q${at + 1}` })) });
      }
      if (url.host === "www.wikidata.org" && action === "wbgetentities") {
        const ids = (url.searchParams.get("ids") ?? "").split("|");
        chunks.push(ids);
        if (ids.includes("Q11")) return new Response("too slow", { status: 504 });
        return Response.json({ entities: Object.fromEntries(ids.map((id) => [id, {
          labels: { en: { value: "Lion" } },
          sitelinks: { enwiki: {} },
          claims: { P31: [value("Q16521")], P18: [text("Lion waiting.jpg")] },
        }])) });
      }
      if (url.host.endsWith("wikipedia.org")) return Response.json({ batchcomplete: "" });
      return plain(input);
    });
    const reply = await get({ q: "Lion", scope: "animals", section: "animals" });
    assert.equal(reply.status, 200);
    assert.deepEqual(chunks.map((ids) => ids.length).sort(), [10, 10, 5]);
    const wikidata = items(reply).filter((hit) => hit.source === "wikidata").map((hit) => hit.id);
    assert.ok(wikidata.includes("wikidata:Q1"));
    assert.equal(wikidata.includes("wikidata:Q11"), false);
  });

  it("leaves a music list's singer to Wikidata: TMDB is not asked by id where the scope does not ask it", async () => {
    const plain = globalThis.fetch;
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const action = url.searchParams.get("action");
      if (url.host === "www.wikidata.org" && action === "wbsearchentities") return Response.json({ search: [{ id: "Q36153" }] });
      if (url.host === "www.wikidata.org" && action === "wbgetentities") {
        return Response.json({ entities: { Q36153: {
          labels: { en: { value: "Beyoncé" } },
          sitelinks: Object.fromEntries(Array.from({ length: 120 }, (_, at) => [`wiki${at}`, {}])),
          claims: { P31: [value("Q5")], P106: [value("Q177220")], P136: [value("Q37073")], P4985: [text("14386")], P18: [text("Lion waiting.jpg")] },
        } } });
      }
      if (url.host.endsWith("wikipedia.org")) return Response.json({ query: { pages: { "1": { index: 1, pageprops: { wikibase_item: "Q36153" } } } } });
      asked.push(url);
      return plain(input);
    });
    const reply = await get({ q: "Beyonce", scope: "music", section: "music" });
    assert.equal(asked.some((url) => url.host === "api.themoviedb.org"), false);
    assert.equal(items(reply)[0]?.id, "wikidata:Q36153");
  });

  it("leaves an old client's search in all without a section as it was: no Wikipedia, nothing chosen", async () => {
    lionKing();
    await get({ q: "Lion King", scope: "all" });
    assert.equal(asked.some((url) => url.host === "en.wikipedia.org"), false);
    assert.equal(asked.some((url) => url.pathname === "/3/movie/8587"), false);
  });
});

describe("IGDB's firewall", () => {
  /** IGDB as on 18.11.2026: its firewall answers 403 to a text that looks like an attack; [closed]: to everything. */
  function igdb(closed: boolean): { alarms: string[] } {
    const plain = globalThis.fetch;
    const alarms: string[] = [];
    mock.method(console, "error", (line: unknown) => {
      if (typeof line === "string" && line.includes("PICTURE_SOURCE_DENIED")) alarms.push(line);
    });
    mock.method(console, "warn", () => undefined);
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "api.igdb.com") {
        asked.push(url);
        const body = String(init?.body ?? "");
        if (closed || body.includes("<script>")) return Response.json({ message: "Forbidden" }, { status: 403 });
      }
      return plain(input, init);
    });
    return { alarms };
  }

  it("takes a 403 for a text that looks like an attack for the text's: no IGDB hits, no alarm, the search answers", async () => {
    const { alarms } = igdb(false);
    const reply = await get({ q: "<script>alert(1)</script>", scope: "games" });
    assert.equal(reply.status, 200);
    assert.deepEqual(alarms, []);
    // The search, and one request with no text that IGDB answered.
    assert.ok(asked.some((url) => url.host === "api.igdb.com"));
  });

  it("raises the alarm when IGDB refuses a request with no text as well: our access is closed", async () => {
    const { alarms } = igdb(true);
    await get({ q: "Mario", scope: "games" });
    assert.equal(alarms.length, 1);
    assert.match(alarms[0]!, /"source":"igdb"/);
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

  /** The web search refuses with [status] and [body]; the alarm lines and every logged word are kept. */
  function webRefuses(status: number, body: unknown): { alarms: string[]; logged: string[] } {
    const plain = globalThis.fetch;
    const alarms: string[] = [];
    const logged: string[] = [];
    const keep = (...words: unknown[]) => {
      const line = words.map(String).join(" ");
      logged.push(line);
      if (line.includes("PICTURE_SOURCE_DENIED")) alarms.push(line);
    };
    mock.method(console, "error", keep);
    mock.method(console, "warn", keep);
    mock.method(console, "log", keep);
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "google.serper.dev") {
        asked.push(url);
        return Response.json(body, { status });
      }
      return plain(input, init);
    });
    return { alarms, logged };
  }

  it("goes on without the web when the key is wrong, raises the alarm, and never logs the key", async () => {
    process.env.SERPER_API_KEY = "secret-test-key";
    const { alarms, logged } = webRefuses(403, { message: "Unauthorized.", statusCode: 403 });
    const whole = await get({ q: "Zzqx", scope: "film_tv" });
    assert.equal(whole.status, 200);
    assert.deepEqual(whole.body.notices, ["webOff"]);
    assert.equal(items(whole).some((hit) => hit.source === "web"), false);
    assert.equal(alarms.length, 1);
    assert.deepEqual(JSON.parse(alarms[0]!), { severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source: "web", status: 403, count: 1, reason: "key" });
    assert.equal(logged.some((line) => line.includes("secret-test-key")), false);
    // Off for an hour, for every instance (Firestore gives the moment back as a Timestamp).
    const off = fakes.db.get("config/pictureWeb") as { offUntil?: Date; lastStatus?: number } | undefined;
    assert.equal(off?.lastStatus, 403);
    assert.ok((off?.offUntil?.getTime() ?? 0) > now);
  });

  it("says when the web's credits are used up, and takes a busy web for busy, without an alarm", async () => {
    process.env.SERPER_API_KEY = "secret-test-key";
    const credits = webRefuses(400, { message: "Not enough credits", statusCode: 400 });
    await get({ q: "Zzqx", scope: "film_tv" });
    assert.equal(JSON.parse(credits.alarms[0]!).reason, "credits");
    mock.restoreAll();
    fakes.restore();
    fakes = install();
    forgetDenied();
    mock.method(Date, "now", () => now);
    mock.method(emulator, "isDemoEmulator", () => false);
    mock.method(pictureTmdbToken, "value", () => "tmdb-token");
    const busy = webRefuses(429, { message: "Too many requests" });
    const reply = await get({ q: "Zzqx", scope: "film_tv" });
    assert.equal(reply.status, 200);
    assert.deepEqual(busy.alarms, []);
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
