import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributionsByPicture, attributionsOf, firstWithoutPage, type CardPicture } from "../src/cataloguePictures";
import { isCatalogueAddress } from "../src/outsidePictures";
import { catalogueSourceOf, pageLink } from "../src/pictureAttribution";
import { catalogueAnswer, readLinkRequest } from "../src/pictureLinks";
import { chargeLink, linkQuota, LINKED_PICTURES_PER_DAY, LINKED_PICTURES_PER_HOUR } from "../src/pictureSearchLimit";
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
    assert.deepEqual(catalogueAnswer(steam, PAGE, null), { source: "steam", link: "https://store.steampowered.com/app/70" });
    const poster = "https://image.tmdb.org/t/p/w500/a.jpg";
    assert.deepEqual(catalogueAnswer(poster, "https://www.themoviedb.org/movie/603", null), { source: "tmdb", link: "https://www.themoviedb.org/movie/603" });
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
