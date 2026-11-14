import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogueTitleCredit } from "../src/pictureAttribution";

describe("a topic picture credited to a catalogue title", () => {
  it("keeps the title's page as a browser shows it, without slug, language or query, and the id the catalogue's hits carry", () => {
    assert.deepEqual(catalogueTitleCredit("https://www.themoviedb.org/movie/11-star-wars?language=ru"), { source: "tmdb", link: "https://www.themoviedb.org/movie/11", id: "tmdb:movie:11" });
    assert.deepEqual(catalogueTitleCredit("https://themoviedb.org/tv/1399-game-of-thrones/"), { source: "tmdb", link: "https://www.themoviedb.org/tv/1399", id: "tmdb:tv:1399" });
    assert.deepEqual(catalogueTitleCredit("https://www.themoviedb.org/collection/10-star-wars-collection"), { source: "tmdb", link: "https://www.themoviedb.org/collection/10" });
    assert.deepEqual(catalogueTitleCredit("https://anilist.co/anime/269/BLEACH/"), { source: "anilist", link: "https://anilist.co/anime/269", id: "anilist:269" });
    assert.deepEqual(catalogueTitleCredit("https://anilist.co/manga/30012"), { source: "anilist", link: "https://anilist.co/manga/30012", id: "anilist:30012" });
    assert.deepEqual(catalogueTitleCredit("https://www.igdb.com/games/resident-evil-4--1"), { source: "igdb", link: "https://www.igdb.com/games/resident-evil-4--1" });
    assert.deepEqual(catalogueTitleCredit("https://store.steampowered.com/app/2050650/Resident_Evil_4/"), { source: "steam", link: "https://store.steampowered.com/app/2050650", id: "steam:2050650" });
    assert.deepEqual(catalogueTitleCredit(" https://openlibrary.org/works/OL82563W/Harry_Potter "), { source: "openlibrary", link: "https://openlibrary.org/works/OL82563W", id: "openlibrary:OL82563W" });
  });

  it("is nothing for another page, another site, a lookalike host or plain http", () => {
    for (const raw of [
      "https://www.themoviedb.org/person/287",
      "https://anilist.co/character/1",
      "https://openlibrary.org/books/OL1M",
      "https://store.steampowered.com/search?term=re",
      "https://themoviedb.org.evil.com/movie/11",
      "http://www.themoviedb.org/movie/11",
      "https://commons.wikimedia.org/wiki/File:A.jpg",
      "",
      42,
      undefined,
    ]) assert.equal(catalogueTitleCredit(raw), null, String(raw));
  });
});
