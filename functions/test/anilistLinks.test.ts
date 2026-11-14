import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributionsOf } from "../src/cataloguePictures";
import { anilistLink, attributionOf, idFromAddress, linkFromAddress, outsideName } from "../src/pictureAttribution";
import { anilistHits } from "../src/pictureSources";
import { linkFor, linksNeeded, mediaTypesOf, withLinks, type MediaType } from "../scripts/anilist-links";

const ANIME_COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-YJvLbgJQPCoI.jpg";
const MANGA_COVER = "https://s4.anilist.co/file/anilistcdn/media/manga/cover/extraLarge/bx30013-hbcXPg5ZAlhs.jpg";
const OLD_COVER = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/nx1535-4r88a1tsBEIz.jpg";
const CHARACTER = "https://s4.anilist.co/file/anilistcdn/character/large/b17-phjcWCkRuIhu.png";
const COPY = "https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/published%2FAbCdEfGhIjKlMnOpQrSt%2Fw-0123456789abcdef0123456789abcdef?alt=media";

describe("an AniList page", () => {
  it("is read off a cover's folder as well as a character's picture", () => {
    assert.equal(linkFromAddress(ANIME_COVER), "https://anilist.co/anime/20");
    assert.equal(linkFromAddress(MANGA_COVER), "https://anilist.co/manga/30013");
    assert.equal(linkFromAddress(OLD_COVER), "https://anilist.co/anime/1535");
    assert.equal(linkFromAddress(CHARACTER), "https://anilist.co/character/17");
    assert.equal(linkFromAddress("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/default.jpg"), null);
    assert.equal(linkFromAddress("https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-abc.jpg"), null);
    assert.equal(idFromAddress(MANGA_COVER, null), "anilist:30013");
  });

  it("follows from a character's id alone, and from a media's only with its type", () => {
    assert.equal(anilistLink("anilist:c17", null), "https://anilist.co/character/17");
    assert.equal(anilistLink("anilist:20", "ANIME"), "https://anilist.co/anime/20");
    assert.equal(anilistLink("anilist:30013", "MANGA"), "https://anilist.co/manga/30013");
    assert.equal(anilistLink("anilist:20", null), null);
    assert.equal(anilistLink("anilist:20", "NOVEL"), null);
    assert.equal(anilistLink("tmdb:movie:20", "ANIME"), null);
  });

  it("is given at publication to a cover sent without one, and to a copy of it", () => {
    assert.deepEqual(attributionOf(ANIME_COVER, { sentId: "anilist:20" }), { source: "anilist", link: "https://anilist.co/anime/20", id: "anilist:20" });
    const copy = `https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/published%2FAbCdEfGhIjKlMnOpQrSt%2F${outsideName(ANIME_COVER)}?alt=media`;
    const [copied, character, unsent] = attributionsOf([
      { imageUrl: copy, sent: { originalUrl: ANIME_COVER, id: "anilist:20" } },
      { imageUrl: "https://s4.anilist.co/file/new.jpg", sent: { id: "anilist:c17" } },
      { imageUrl: "https://s4.anilist.co/file/new.jpg", sent: { id: "anilist:21" } },
    ], new Map());
    assert.deepEqual(copied, { source: "anilist", link: "https://anilist.co/anime/20", id: "anilist:20", originalUrl: ANIME_COVER });
    assert.deepEqual(character, { source: "anilist", link: "https://anilist.co/character/17", id: "anilist:c17" });
    // An anime or a manga, from an address that does not say which: no page is guessed.
    assert.deepEqual(unsent, { source: "anilist", id: "anilist:21" });
  });

  it("comes with every search hit, anime, manga and character", () => {
    const hits = anilistHits({ data: {
      media: { media: [
        { id: 20, type: "ANIME", title: { english: "Naruto" }, coverImage: { large: ANIME_COVER } },
        { id: 30013, type: "MANGA", title: { english: "One Piece" }, coverImage: { large: MANGA_COVER } },
      ] },
      characters: { characters: [{ id: 17, name: { full: "Naruto Uzumaki" }, image: { large: CHARACTER } }] },
    } });
    assert.deepEqual(hits.map((hit) => hit.attribution?.link), ["https://anilist.co/anime/20", "https://anilist.co/manga/30013", "https://anilist.co/character/17"]);
  });
});

describe("the AniList links backfill", () => {
  const items = [
    { title: "Naruto", imageUrl: COPY, attribution: { source: "anilist", id: "anilist:20", originalUrl: ANIME_COVER } },
    { title: "Naruto Uzumaki", imageUrl: CHARACTER, attribution: { source: "anilist", id: "anilist:c17", link: "https://anilist.co/character/17" } },
    { title: "Sasuke", imageUrl: "https://s4.anilist.co/file/anilistcdn/character/large/b13-x.png", attribution: { source: "anilist", id: "anilist:c13" } },
    { title: "Berserk", imageUrl: "https://s4.anilist.co/file/new.jpg", attribution: { source: "anilist", id: "anilist:30002" } },
    { title: "Unknown", imageUrl: "https://s4.anilist.co/file/new.jpg", attribution: { source: "anilist", id: "anilist:99" } },
    { title: "No id", imageUrl: "https://s4.anilist.co/file/new.jpg", attribution: { source: "anilist" } },
    { title: "Edited", imageUrl: ANIME_COVER, attribution: { source: "anilist", id: "anilist:20", manual: true, license: "CC0 1.0" } },
    { title: "Movie", imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg", attribution: { source: "tmdb", id: "tmdb:movie:1" } },
    { title: "No picture", imageUrl: null },
    null,
  ];

  it("finds the AniList cards without a page, with what the address says", () => {
    assert.deepEqual(linksNeeded(items), [
      { at: 0, kind: "media", number: "20", fromAddress: "ANIME" },
      { at: 2, kind: "character", number: "13" },
      { at: 3, kind: "media", number: "30002", fromAddress: null },
      { at: 4, kind: "media", number: "99", fromAddress: null },
    ]);
    // An id read off the address where the card keeps none.
    assert.deepEqual(linksNeeded([{ imageUrl: MANGA_COVER, attribution: { source: "anilist" } }]), [{ at: 0, kind: "media", number: "30013", fromAddress: "MANGA" }]);
  });

  it("links each by AniList's type first, the address next, and leaves the rest as they were", () => {
    const types = new Map<string, MediaType>([["20", "ANIME"], ["30002", "MANGA"]]);
    const linked = withLinks(items, linksNeeded(items), types);
    assert.equal((linked.items[0] as { attribution: { link: string } }).attribution.link, "https://anilist.co/anime/20");
    assert.equal((linked.items[0] as { attribution: { originalUrl: string } }).attribution.originalUrl, ANIME_COVER);
    assert.equal((linked.items[2] as { attribution: { link: string } }).attribution.link, "https://anilist.co/character/13");
    assert.equal((linked.items[3] as { attribution: { link: string } }).attribution.link, "https://anilist.co/manga/30002");
    assert.equal(linked.items[4], items[4]);
    assert.equal(linked.items[1], items[1]);
    assert.equal(linked.items[9], null);
    assert.deepEqual({ anime: linked.anime, manga: linked.manga, character: linked.character, unresolved: linked.unresolved }, { anime: 1, manga: 1, character: 1, unresolved: ["99"] });
    // The original is not touched.
    assert.equal("link" in (items[0]!.attribution as object), false);

    // Without AniList's word, the address's folder; where they differ, AniList's.
    assert.equal(linkFor({ at: 0, kind: "media", number: "20", fromAddress: "ANIME" }, new Map()), "https://anilist.co/anime/20");
    const disagreeing = withLinks(items, linksNeeded(items).slice(0, 1), new Map([["20", "MANGA"]]));
    assert.equal((disagreeing.items[0] as { attribution: { link: string } }).attribution.link, "https://anilist.co/manga/20");
    assert.deepEqual(disagreeing.disagreed, ["20"]);
  });

  it("reads AniList's answer of types, nothing else", () => {
    const types = mediaTypesOf({ data: { Page: { media: [{ id: 20, type: "ANIME", siteUrl: "https://anilist.co/anime/20" }, { id: 30002, type: "MANGA" }, { id: "7", type: "ANIME" }, { id: 8, type: "NOVEL" }, null] } } });
    assert.deepEqual([...types], [["20", "ANIME"], ["30002", "MANGA"]]);
    assert.equal(mediaTypesOf({ errors: [{ message: "Too Many Requests." }] }).size, 0);
    assert.equal(mediaTypesOf(null).size, 0);
  });
});
