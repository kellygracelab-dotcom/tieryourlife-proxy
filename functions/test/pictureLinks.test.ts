import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributionsByPicture, attributionsOf, firstWithoutPage, type CardPicture } from "../src/cataloguePictures";
import { isCatalogueAddress } from "../src/outsidePictures";
import { attributionOf, catalogueSourceOf, commonsFileOf, pageLink } from "../src/pictureAttribution";
import { catalogueAnswer, readLinkRequest } from "../src/pictureLinks";
import { BUSY_WAIT_MS, sourceBusy } from "../src/pictureSearch";
import { chargeLink, linkQuota, LINKED_PICTURES_PER_DAY, LINKED_PICTURES_PER_HOUR, unchargeLink } from "../src/pictureSearchLimit";
import { USER_AGENT } from "../src/pictureSources";
import { decidePublish } from "../src/publishing";

const FOUND = "https://example.com/pictures/cat.jpg";
const PAGE = "https://example.com/cats/tabby";
const OWN = "https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/users%2Fsomeone%2Fpictures%2Fabc?alt=media&token=t";
const COPY = "https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/published%2Flist1%2Fw-0123456789abcdef0123456789abcdef?alt=media";

describe("Wikipedia's own uploads", () => {
  it("are a picture from another site; only Commons' folder is a catalogue", () => {
    const fairUse = "https://upload.wikimedia.org/wikipedia/en/0/0b/Some_poster.jpg";
    const commons = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/500px-Cat.jpg";
    assert.equal(catalogueSourceOf(fairUse), null);
    assert.equal(isCatalogueAddress(fairUse), false);
    assert.equal(catalogueSourceOf(commons), "wikimedia");
    assert.equal(isCatalogueAddress(commons), true);
    assert.equal(isCatalogueAddress("https://image.tmdb.org/t/p/w500/a.jpg"), true);
  });
});

describe("the page a picture was found on", () => {
  it("is any https page, short, without a login or a port", () => {
    assert.equal(pageLink(PAGE), PAGE);
    assert.equal(pageLink(` ${PAGE} `), PAGE);
    assert.equal(pageLink("http://example.com/a"), null);
    assert.equal(pageLink("https://user:pw@example.com/a"), null);
    assert.equal(pageLink("https://example.com:8443/a"), null);
    assert.equal(pageLink("https://localhost/a"), null);
    assert.equal(pageLink("javascript:alert(1)"), null);
    assert.equal(pageLink(`https://example.com/${"a".repeat(500)}`), null);
    assert.equal(pageLink(42), null);
  });
});

describe("a request for a picture by its link", () => {
  it("reads the address, the page and the credit, and says which catalogue the address is on", () => {
    assert.deepEqual(readLinkRequest({ url: FOUND, link: PAGE, credit: "  Jane   Doe " }), { url: FOUND, catalogue: null, link: PAGE, credit: "Jane Doe" });
    assert.deepEqual(readLinkRequest({ url: "https://image.tmdb.org/t/p/w500/a.jpg" }), { url: "https://image.tmdb.org/t/p/w500/a.jpg", catalogue: "tmdb", link: null, credit: null });
    assert.deepEqual(readLinkRequest({ url: FOUND, link: "" }), { url: FOUND, catalogue: null, link: null, credit: null });
  });

  it("refuses what it cannot take, before anything is fetched or counted", () => {
    assert.deepEqual(readLinkRequest(null), { error: "NO_URL" });
    assert.deepEqual(readLinkRequest({ url: "  " }), { error: "NO_URL" });
    assert.deepEqual(readLinkRequest({ url: "not a url" }), { error: "BAD_URL" });
    assert.deepEqual(readLinkRequest({ url: `https://example.com/${"a".repeat(2000)}` }), { error: "BAD_URL" });
    assert.deepEqual(readLinkRequest({ url: "http://example.com/a.jpg" }), { error: "NOT_ALLOWED" });
    assert.deepEqual(readLinkRequest({ url: "https://example.com:8080/a.jpg" }), { error: "NOT_ALLOWED" });
    assert.deepEqual(readLinkRequest({ url: FOUND, link: "http://example.com/page" }), { error: "BAD_LINK" });
    assert.deepEqual(readLinkRequest({ url: FOUND, link: 7 }), { error: "BAD_LINK" });
  });

  it("answers a catalogue address with its own page, and takes a sent page only on that catalogue's site", () => {
    const steam = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/70/header.jpg";
    assert.deepEqual(catalogueAnswer(steam, PAGE, null), { source: "steam", link: "https://store.steampowered.com/app/70", id: "steam:70" });
    const poster = "https://image.tmdb.org/t/p/w500/a.jpg";
    assert.deepEqual(catalogueAnswer(poster, "https://www.themoviedb.org/movie/603", null), { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" });
    assert.deepEqual(catalogueAnswer(poster, PAGE, null), { source: "tmdb" });
  });
});

describe("pictures fetched by their link", () => {
  it("are counted per day and per hour, and say when the window opens", () => {
    const now = Date.parse("2026-11-13T10:30:00Z");
    const hour = Math.floor(now / 3_600_000);
    assert.ok(chargeLink(undefined, now).allowed);
    const fullHour = chargeLink({ count: LINKED_PICTURES_PER_HOUR, hour, hourCount: LINKED_PICTURES_PER_HOUR }, now);
    assert.deepEqual(fullHour, { allowed: false, retryAtMs: Date.parse("2026-11-13T11:00:00Z") });
    const fullDay = chargeLink({ count: LINKED_PICTURES_PER_DAY, hour, hourCount: 0 }, now);
    assert.deepEqual(fullDay, { allowed: false, retryAtMs: Date.parse("2026-11-14T00:00:00Z") });
  });

  it("tell what is left of the day and when it starts again", () => {
    const now = Date.parse("2026-11-13T23:59:00Z");
    assert.deepEqual(linkQuota(undefined, now), { left: 400, limit: 400, resetsAt: Date.parse("2026-11-14T00:00:00Z") });
    assert.equal(linkQuota(88, now).left, 312);
    assert.equal(linkQuota(LINKED_PICTURES_PER_DAY + 5, now).left, 0);
  });
});

describe("a picture from another site at publication", () => {
  it("carries the page it was found on, from its own folder or from another site, and keeps it from a client that sends none", () => {
    const cards: CardPicture[] = [
      { imageUrl: OWN, sent: { web: true, link: PAGE } },
      { imageUrl: null, sent: { web: true } },
      { imageUrl: FOUND, sent: { link: PAGE } },
      { imageUrl: FOUND, sent: { link: "http://example.com/page" } },
      { imageUrl: OWN },
    ];
    assert.deepEqual(attributionsOf(cards, new Map()), [
      { source: "web", link: PAGE },
      { source: "web" },
      { source: "web", link: PAGE },
      { source: "web" },
      null,
    ]);
    const before = attributionsByPicture([{ imageUrl: COPY, attribution: { source: "web", link: PAGE } }]);
    assert.deepEqual(attributionsOf([{ imageUrl: COPY, previous: before.get(COPY) }], new Map()), [{ source: "web", link: PAGE }]);
    // A client that sends the attribution without a page has taken it off.
    assert.deepEqual(attributionsOf([{ imageUrl: COPY, sent: { web: true }, previous: before.get(COPY) }], new Map()), [{ source: "web" }]);
  });

  it("is refused to the house without its page when it is new to the list", () => {
    const cards: CardPicture[] = [
      { imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg" },
      { imageUrl: COPY, previous: { source: "web" } },
      { imageUrl: FOUND, sent: { link: PAGE } },
      { imageUrl: OWN, sent: { web: true } },
    ];
    assert.equal(firstWithoutPage(cards, attributionsOf(cards, new Map())), 3);
    assert.equal(firstWithoutPage(cards.slice(0, 3), attributionsOf(cards.slice(0, 3), new Map())), null);
  });

  it("is read off the card only as a source of web", () => {
    const decision = decidePublish({ isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "someone", body: {
      title: "Cats",
      category: "animals",
      tiers: [{ label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" }],
      items: [
        { title: "Tabby", pictureId: "abc", attribution: { source: "web", link: PAGE } },
        { title: "Other", pictureId: "def", attribution: { source: "tmdb" } },
      ],
    } });
    assert.ok(decision.ok);
    if (!decision.ok) return;
    assert.deepEqual(decision.draft.items[0].sent, { link: PAGE, web: true });
    assert.equal(decision.draft.items[1].sent, undefined);
  });
});

describe("Wikimedia's thumbnail host", () => {
  it("is Commons for Commons' files and another site for a local Wikipedia's", () => {
    const commons = "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Logo_of_the_KitKat.svg/500px-Logo_of_the_KitKat.svg.png";
    const local = "https://thumb.wikimedia.org/wikipedia/en/thumb/4/48/Jelly_Belly_Logo.svg/500px-Jelly_Belly_Logo.svg.png";
    assert.equal(catalogueSourceOf(commons), "wikimedia");
    assert.equal(isCatalogueAddress(commons), true);
    assert.equal(commonsFileOf(commons), "Logo of the KitKat.svg");
    assert.deepEqual(attributionOf(commons, {}), { source: "wikimedia", link: "https://commons.wikimedia.org/wiki/File:Logo_of_the_KitKat.svg" });
    assert.equal(catalogueSourceOf(local), null);
    assert.equal(isCatalogueAddress(local), false);
    assert.equal(commonsFileOf(local), null);
    assert.deepEqual(readLinkRequest({ url: local }), { url: local, catalogue: null, link: null, credit: null });
  });
});

describe("a picture's own site that is busy", () => {
  const now = Date.parse("2026-11-13T18:00:00Z");

  it("is waited for once when it asks for a moment, and then left until the time it gives", () => {
    assert.deepEqual(sourceBusy(429, null, now, false), { waitMs: 1000 });
    assert.deepEqual(sourceBusy(429, "2", now, false), { waitMs: 2000 });
    assert.deepEqual(sourceBusy(503, String(BUSY_WAIT_MS / 1000), now, false), { waitMs: BUSY_WAIT_MS });
    assert.deepEqual(sourceBusy(429, null, now, true), { retryAtMs: now + 5 * 60 * 1000, restHost: true });
    assert.deepEqual(sourceBusy(429, "120", now, false), { retryAtMs: now + 120_000, restHost: true });
    assert.deepEqual(sourceBusy(429, "Thu, 13 Nov 2026 18:10:00 GMT", now, false), { retryAtMs: now + 600_000, restHost: true });
    assert.deepEqual(sourceBusy(429, "86400", now, false), { retryAtMs: now + 60 * 60 * 1000, restHost: true });
    assert.deepEqual(sourceBusy(502, null, now, true), { retryAtMs: now + 5 * 60 * 1000, restHost: false });
  });

  it("is only 429 and 5xx: a missing picture stays unreachable", () => {
    for (const status of [200, 301, 400, 403, 404, 410]) assert.equal(sourceBusy(status, "1", now, false), null);
  });

  it("costs the person nothing: the fetch is given back in the hour it was charged", () => {
    const hour = Math.floor(now / 3_600_000);
    assert.deepEqual(unchargeLink({ count: 5, hour, hourCount: 3 }, hour), { count: 4, hourCount: 2 });
    assert.deepEqual(unchargeLink({ count: 5, hour: hour + 1, hourCount: 1 }, hour), { count: 4 });
    assert.equal(unchargeLink({ count: 0, hour, hourCount: 0 }, hour), null);
    assert.equal(unchargeLink(undefined, hour), null);
  });

  it("is asked with a name and a way to reach us, and no address of a person", () => {
    assert.equal(USER_AGENT, "TierYourLife/1.0 (https://tieryourlife.web.app/privacy)");
    assert.doesNotMatch(USER_AGENT, /@/);
  });
});
