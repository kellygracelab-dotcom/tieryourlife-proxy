import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  activeInWindow,
  clientFacts,
  countableSearch,
  keysFor,
  platformOfApp,
  readBatch,
  retention,
  tallyOf,
  tallyOfBatch,
  toCsv,
  weekOf,
  weekStart,
  type DaySums,
  type RequestFacts,
} from "../src/statsKeys";
import { countAccount, csvOf, emptyAccounts, heldForTests, periodOf, record, resetForTests, topDocId } from "../src/stats";

const LIST = "RNKEXN5CSbaltvtNNXSb";
const NOW = Date.parse("2026-11-20T12:00:00Z");

function facts(over: Partial<RequestFacts>): RequestFacts {
  return { fn: "lists", method: "GET", segments: [], query: {}, status: 200, body: null, code: null, ...over };
}

describe("usage statistics: what a request counts (20.11.2026)", () => {
  it("counts a list opened and a list taken, with the list", () => {
    assert.deepEqual(tallyOf(facts({ segments: [LIST] })), { events: ["list.view"], things: [{ kind: "lists", id: LIST, field: "views" }] });
    assert.deepEqual(tallyOf(facts({ method: "POST", segments: [LIST, "taken"] })).events, ["list.take"]);
    assert.deepEqual(tallyOf(facts({ segments: [LIST], status: 404 })).events, []);
  });

  it("tells a publish from a republish, and counts follows", () => {
    assert.deepEqual(tallyOf(facts({ method: "POST", status: 201 })).events, ["list.publish"]);
    assert.deepEqual(tallyOf(facts({ method: "POST", segments: [LIST] })).events, ["list.republish"]);
    assert.deepEqual(tallyOf(facts({ method: "POST", segments: ["follow", "someone"] })).events, ["author.follow"]);
    assert.deepEqual(tallyOf(facts({ method: "POST", segments: ["topics", LIST, "follow"] })).things, [{ kind: "topics", id: LIST, field: "follows" }]);
  });

  it("counts a list search on its first page, and a miss when nothing came back", () => {
    const miss = tallyOf(facts({ query: { q: "  Best  Anime " }, body: { lists: [] } }));
    assert.deepEqual(miss.events, ["search.lists", "search.lists.miss"]);
    assert.deepEqual(miss.things.map((thing) => [thing.id, thing.field]), [["best anime", "n"], ["best anime", "miss"]]);
    assert.deepEqual(tallyOf(facts({ query: { q: "anime", after: "x" }, body: { lists: [] } })).events, []);
    assert.deepEqual(tallyOf(facts({ query: { topic: LIST, category: "games" }, body: { lists: [1] } })).events, ["topic.open", "section.open"]);
  });

  it("counts a picture search once across its quick and rest parts, and the miss at its end", () => {
    const quick = tallyOf(facts({ segments: ["pictures"], query: { q: "Pancakes", part: "quick", section: "food" }, body: { items: [] } }));
    assert.deepEqual(quick.events, ["search.pictures"]);
    assert.deepEqual(quick.things[0], { kind: "pictureSearch", id: "food|pancakes", field: "n", keep: { q: "pancakes", section: "food" } });
    assert.deepEqual(tallyOf(facts({ segments: ["pictures"], query: { q: "Pancakes", part: "rest", section: "food" }, body: { items: [] } })).events, ["search.pictures.miss"]);
    assert.deepEqual(tallyOf(facts({ segments: ["pictures"], query: { q: "pancakes" }, body: { items: [1] } })).events, ["search.pictures"]);
    assert.deepEqual(tallyOf(facts({ segments: ["pictures"], query: { q: "pancakes", page: "2" }, body: { items: [] } })).events, []);
  });

  it("counts server trouble and an erased account", () => {
    assert.deepEqual(tallyOf(facts({ status: 401, code: "APP_UNVERIFIED" })).events, ["server.appCheckRefused"]);
    assert.deepEqual(tallyOf(facts({ segments: ["pictures"], status: 429, code: "SEARCH_LIMIT" })).events, ["server.searchLimit"]);
    assert.deepEqual(tallyOf(facts({ status: 503, code: "SOURCE_BUSY" })).events, ["server.5xx", "server.sourceBusy"]);
    assert.deepEqual(tallyOf(facts({ fn: "boards", method: "DELETE", segments: ["account"], status: 204 })).events, ["account.erased"]);
    assert.deepEqual(tallyOf(facts({ fn: "boards", method: "PUT", segments: ["b"], status: 500 })).events, ["server.5xx"]);
  });

  it("never counts a search that names a person's contact", () => {
    assert.equal(countableSearch("ann@example.com"), null);
    assert.equal(countableSearch("+380 67 123 45 67"), null);
    assert.equal(countableSearch("1234567"), null);
    assert.equal(countableSearch("x"), null);
    assert.equal(countableSearch("Top 10 games of 2024"), "top 10 games of 2024");
    assert.equal([...countableSearch("я".repeat(80))!].length, 60);
  });
});

describe("usage statistics: keys and dimensions", () => {
  it("takes the platform from the App Check app id and the rest from the client's headers", () => {
    assert.equal(platformOfApp("1:709407647012:android:abc"), "android");
    assert.equal(platformOfApp("1:709407647012:web:abc"), "web");
    assert.equal(platformOfApp(undefined), null);
    assert.deepEqual(clientFacts("android/1.4.2", "ru-RU"), { version: "1.4.2", language: "ru", region: "RU" });
    assert.deepEqual(clientFacts("android 1.4", "Россия"), { version: null, language: null, region: null });
  });

  it("cuts a plain event by every dimension, and a cohort or gap key by platform only", () => {
    const facts_ = { version: "1.4.2", language: "uk", region: "UA" };
    assert.deepEqual(keysFor("list.view", "android", facts_), ["list.view", "list.view~p:android", "list.view~v:android/1.4.2", "list.view~l:uk", "list.view~r:UA"]);
    assert.deepEqual(keysFor("active.gap~g:3", "web", facts_), ["active.gap~g:3", "active.gap~g:3~p:web"]);
  });

  it("keeps lists, topics and sections by id and everything typed by a hash", () => {
    assert.equal(topDocId("lists", LIST), LIST);
    assert.match(topDocId("pictureSearch", "food|pancakes"), /^[0-9a-f]{32}$/);
  });
});

describe("usage statistics: a client's batch (stage 2)", () => {
  const good = { version: "1.4.2", locale: "de-DE", active: { gap: 2, sinceFirst: 7, firstWeek: "2026-W46" }, steps: ["first_board", "bogus"], features: { "share.image": 2, "made.up": 5, "picture.own": 0 }, sessions: 3, crashedSessions: 9, crashes: [{ type: "IllegalStateException", place: "Board.kt:12" }], referrer: { domain: "www.Reddit.com", utm: "post" } };

  it("reads what it may say and drops the rest", () => {
    const batch = readBatch(good)!;
    assert.deepEqual(batch.steps, ["first_board"]);
    assert.deepEqual(batch.features, { "share.image": 2 });
    assert.equal(batch.crashedSessions, 3);
    assert.deepEqual(batch.referrer, { domain: "reddit.com", utm: "post" });
    assert.deepEqual([batch.version, batch.language, batch.region], ["1.4.2", "de", "DE"]);
    assert.equal(readBatch({ ...good, active: { gap: 0, sinceFirst: 1, firstWeek: "2026-W46" } }), null);
    assert.equal(readBatch([]), null);
  });

  it("counts the device active once a day, and only the steps the gate has not seen", () => {
    const batch = readBatch(good)!;
    const first = tallyOfBatch(batch, "2026-11-20", { firstToday: true, newSteps: ["first_board"], firstCrashToday: true });
    assert.ok(first.events.includes("active"));
    assert.ok(first.events.includes("active.gap~g:2"));
    assert.ok(first.events.includes("ret~w:2026-W46~d:7"));
    assert.ok(first.events.includes("step.first_board~w:2026-W46"));
    assert.ok(first.events.includes("active.crashed"));
    assert.equal(first.events.filter((event) => event === "f.share.image").length, 2);
    const again = tallyOfBatch(batch, "2026-11-20", { firstToday: false, newSteps: [], firstCrashToday: false });
    assert.ok(!again.events.includes("active"));
    assert.ok(!again.events.some((event) => event.startsWith("step.")));
  });
});

describe("usage statistics: numbers from daily sums", () => {
  it("counts each device once in a window, by the gap back to its last active day", () => {
    // One device active on the 1st, 2nd and 20th; another first seen on the 15th.
    const sums = new Map<string, DaySums>([
      ["2026-11-01", { "active.gap~g:31": 1 }],
      ["2026-11-02", { "active.gap~g:1": 1 }],
      ["2026-11-15", { "active.gap~g:31": 1 }],
      ["2026-11-20", { "active.gap~g:18": 1 }],
    ]);
    assert.equal(activeInWindow(sums, "2026-11-20", 30, "all"), 2);
    assert.equal(activeInWindow(sums, "2026-11-20", 7, "all"), 2);
    assert.equal(activeInWindow(sums, "2026-11-20", 1, "all"), 1);
    assert.equal(activeInWindow(sums, "2026-11-10", 30, "all"), 1);
  });

  it("gives a week's retention only once every device in it has had that day", () => {
    const sums = new Map<string, DaySums>([
      ["2026-11-09", { "step.first_launch~w:2026-W46": 10 }],
      ["2026-11-10", { "ret~w:2026-W46~d:1": 4 }],
      ["2026-11-16", { "ret~w:2026-W46~d:7": 2 }],
    ]);
    assert.deepEqual(retention(sums, ["2026-W46"], "all", "2026-11-20"), [{ week: "2026-W46", size: 10, d1: 0.4, d7: null, d30: null }]);
    assert.deepEqual(retention(sums, ["2026-W46"], "all", "2026-11-23")[0]!.d7, 0.2);
  });

  it("names weeks the ISO way", () => {
    assert.equal(weekOf("2026-11-20"), "2026-W47");
    assert.equal(weekOf("2027-01-01"), "2026-W53");
    assert.equal(weekStart("2026-W47"), "2026-11-16");
    assert.equal(weekStart("2026-W60"), null);
  });

  it("reads a period, a year at most, never after today", () => {
    assert.deepEqual(periodOf({}, NOW), { from: "2026-11-14", to: "2026-11-20", platform: "all", compare: false });
    assert.deepEqual(periodOf({ from: "2026-11-01", to: "2026-11-10", platform: "web", compare: "1" }, NOW), { from: "2026-11-01", to: "2026-11-10", platform: "web", compare: true });
    assert.equal(typeof periodOf({ to: "2026-11-21" }, NOW), "string");
    assert.equal(typeof periodOf({ from: "2024-01-01" }, NOW), "string");
    assert.equal(typeof periodOf({ platform: "tv" }, NOW), "string");
  });

  it("writes CSV a spreadsheet will not run", () => {
    assert.equal(toCsv([{ q: "=cmd()", n: 3 }, { q: 'say "hi", ok', n: 1 }], ["q", "n"]), `q,n\r\n'=cmd(),3\r\n"say ""hi"", ok",1\r\n`);
    const answer = { daily: [{ day: "2026-11-20", active: 1 }], totals: { "list.view": 5 }, previousTotals: null, funnel: [], retention: [], top: { lists: [] }, audience: {} };
    assert.equal(csvOf(answer, "totals"), "event,n,previous\r\nlist.view,5,\r\n");
    assert.equal(csvOf(answer, "nonsense"), null);
  });
});

describe("usage statistics: the buffer and the nightly account count", () => {
  afterEach(() => resetForTests());

  it("adds a request's counts to the day's buffer with every cut", () => {
    resetForTests();
    record({ events: ["list.view"], things: [{ kind: "lists", id: LIST, field: "views" }] }, "android", { version: null, language: "en", region: null }, NOW);
    record({ events: ["list.view"], things: [{ kind: "lists", id: LIST, field: "views" }] }, "web", { version: null, language: null, region: null }, NOW);
    const held = heldForTests();
    assert.deepEqual(Object.fromEntries(held.counters.get("2026-11-20")!), { "list.view": 2, "list.view~p:android": 1, "list.view~l:en": 1, "list.view~p:web": 1 });
    assert.deepEqual(held.tops.get(`2026-11-20/lists/${LIST}`)!.inc, { views: 2 });
  });

  it("counts accounts by kind and how lately they were used, nothing else", () => {
    const into = { guests: emptyAccounts(), google: emptyAccounts() };
    const hour = 3_600_000;
    countAccount(into, { providerCount: 0, createdMs: NOW - 2 * hour, lastUsedMs: NOW - hour }, NOW);
    countAccount(into, { providerCount: 1, createdMs: NOW - 900 * hour, lastUsedMs: NOW - 100 * hour }, NOW);
    assert.deepEqual(into.guests, { total: 1, new1: 1, active1: 1, active7: 1, active30: 1 });
    assert.deepEqual(into.google, { total: 1, new1: 0, active1: 0, active7: 1, active30: 1 });
  });
});
