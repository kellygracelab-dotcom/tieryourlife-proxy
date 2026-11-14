import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorName, commonsDetails } from "../src/pictureCredit";
import { withPlainAuthors } from "../scripts/commons-authors";

describe("a Commons author's name", () => {
  it("keeps the name and drops the address in brackets, and a channel's ' - YouTube'", () => {
    assert.equal(authorName("Real Madrid (https://m.youtube.com/c/realmadrid/videos)"), "Real Madrid");
    assert.equal(authorName("K-POPIT 케이팝잇 (https://www.youtube.com/channel/UCY9QGuU9mBLBp_OCRNKeVSw)"), "K-POPIT 케이팝잇");
    assert.equal(authorName("ESCplus - YouTube (https://www.youtube.com/user/ESCPlusTV/)"), "ESCplus");
    assert.equal(authorName("Name (http://a.b/c_(d))"), "Name");
  });

  it("names a channel by the handle or user name its address alone carries, else YouTube", () => {
    assert.equal(authorName("https://www.youtube.com/@realmadrid"), "@realmadrid");
    assert.equal(authorName("https://www.youtube.com/@_TV10"), "@_TV10");
    assert.equal(authorName("https://www.youtube.com/user/mang2goon/about"), "mang2goon");
    assert.equal(authorName("https://www.youtube.com/channel/UCY9QGuU9mBLBp_OCRNKeVSw"), "YouTube");
    assert.equal(authorName("https://www.flickr.com/people/someone"), "flickr.com");
  });

  it("drops the 'I, ' of Commons' {{self}} credit", () => {
    assert.equal(authorName("I, Luc Viatour"), "Luc Viatour");
    assert.equal(authorName("I, J.P.Lon"), "J.P.Lon");
    assert.equal(authorName("I,Someone (https://a.b/c)"), "Someone");
    assert.equal(authorName("Ivan, Jane"), "Ivan, Jane");
    assert.equal(authorName("I,"), "I,");
  });

  it("leaves a plain name, brackets without an address and nothing as they are", () => {
    assert.equal(authorName("Jane Doe"), "Jane Doe");
    assert.equal(authorName("Foo (bar)"), "Foo (bar)");
    assert.equal(authorName(""), "");
  });

  it("is what Commons' linked author becomes at publication", () => {
    const details = commonsDetails({ pageid: 162994914, title: "File:Kroos.jpg" }, {
      extmetadata: { LicenseShortName: { value: "CC BY 3.0" }, Artist: { value: '<a href="https://www.youtube.com/@realmadrid">https://www.youtube.com/@realmadrid</a>' } },
    });
    assert.equal(details?.author, "@realmadrid");
    assert.equal(details?.link, "https://commons.wikimedia.org/?curid=162994914");
  });
});

describe("the backfill of Commons authors", () => {
  it("changes only the author of Commons cards an editor did not credit, and says what changed", () => {
    const items = [
      { title: "Toni Kroos", attribution: { source: "wikimedia", author: "https://www.youtube.com/@realmadrid", license: "CC BY 3.0", link: "https://commons.wikimedia.org/?curid=1" } },
      { title: "Hand", attribution: { source: "wikimedia", manual: true, author: "Me (https://example.com)", license: "CC0", link: "https://example.com" } },
      { title: "Plain", attribution: { source: "wikimedia", author: "Jane Doe", license: "CC BY 4.0" } },
      { title: "Poster", attribution: { source: "tmdb", author: "X (https://example.com)" } },
      { title: "No picture" },
    ];
    const { items: after, changes } = withPlainAuthors(items);
    assert.deepEqual(changes, [{ index: 0, title: "Toni Kroos", before: "https://www.youtube.com/@realmadrid", after: "@realmadrid" }]);
    assert.deepEqual(after[0], { title: "Toni Kroos", attribution: { source: "wikimedia", author: "@realmadrid", license: "CC BY 3.0", link: "https://commons.wikimedia.org/?curid=1" } });
    assert.deepEqual(after.slice(1), items.slice(1));
    assert.deepEqual(withPlainAuthors(items.slice(1)).changes, []);
  });
});
