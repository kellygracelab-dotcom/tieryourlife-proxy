import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anilistHits,
  decideWeb,
  deezerArtistHits,
  matchScore,
  mergeHits,
  openLibraryHits,
  PictureHit,
  pictureScopeOf,
  sourcesFor,
  steamHits,
  tmdbHits,
  webHits,
  wikidataCandidates,
  WEB_DAILY_PER_USER,
  WEB_MONTHLY_CEILING,
} from "../src/pictureSources";
import { isPrivateAddress } from "../src/pictureSearch";

const hit = (id: string, title: string, imageUrl = `https://x/${id}.jpg`): PictureHit => ({
  id,
  title,
  subtitle: null,
  imageUrl,
  thumbUrl: null,
  source: "tmdb",
  kind: "movie",
});

describe("pictureScopeOf", () => {
  it("keeps a known scope and makes anything else all", () => {
    assert.equal(pictureScopeOf("anime"), "anime");
    assert.equal(pictureScopeOf("board_games"), "all");
    assert.equal(pictureScopeOf(undefined), "all");
  });

  it("asks every catalogue for all, and Wikidata in every scope", () => {
    assert.deepEqual(sourcesFor("all"), ["tmdb", "anilist", "steam", "deezer", "openlibrary", "wikidata"]);
    assert.ok(sourcesFor("games").includes("wikidata"));
  });
});

describe("decideWeb", () => {
  const base = { scope: "all" as const, forced: false, goodMatches: 0, configured: true, offUntilMs: 0, nowMs: 1000, usedToday: 0, usedThisMonth: 0 };

  it("asks the web for all when the catalogues found little", () => {
    assert.equal(decideWeb(base), "ask");
    assert.equal(decideWeb({ ...base, goodMatches: 10 }), "skip");
  });

  it("leaves a narrow scope to its catalogues unless asked everywhere", () => {
    assert.equal(decideWeb({ ...base, scope: "anime" }), "skip");
    assert.equal(decideWeb({ ...base, scope: "anime", forced: true }), "ask");
  });

  it("stops at a person's day and the service's month", () => {
    assert.equal(decideWeb({ ...base, usedToday: WEB_DAILY_PER_USER }), "dailyLimit");
    assert.equal(decideWeb({ ...base, usedThisMonth: WEB_MONTHLY_CEILING }), "off");
    assert.equal(decideWeb({ ...base, offUntilMs: 5000 }), "off");
    assert.equal(decideWeb({ ...base, configured: false }), "off");
  });
});

describe("matchScore and mergeHits", () => {
  it("puts the exact title first, then its starts, then its words", () => {
    assert.equal(matchScore("Naruto", "naruto"), 0);
    assert.equal(matchScore("Naruto Shippuden", "naruto"), 1);
    assert.equal(matchScore("Boruto: Naruto Next Generations", "naruto"), 2);
    assert.equal(matchScore("Bleach", "naruto"), 3);
  });

  it("takes each catalogue in turn, drops the same picture twice and ranks by title", () => {
    const merged = mergeHits("star wars", [
      [hit("tmdb:1", "Star Wars: The Clone Wars"), hit("tmdb:2", "Lego")],
      [hit("wikidata:Q1", "Star Wars"), hit("wikidata:Q2", "Again", "https://x/tmdb:2.jpg")],
    ]);
    assert.deepEqual(merged.map((one) => one.id), ["wikidata:Q1", "tmdb:1", "tmdb:2"]);
  });
});

describe("the catalogues' answers", () => {
  it("TMDB: posters for films and shows, faces for people, nothing without a picture", () => {
    const hits = tmdbHits({
      results: [
        { id: 11, media_type: "movie", title: "Star Wars", release_date: "1977-05-25", poster_path: "/a.jpg" },
        { id: 12, media_type: "person", name: "Mark Hamill", known_for_department: "Acting", profile_path: "/b.jpg" },
        { id: 13, media_type: "tv", name: "Andor" },
      ],
    });
    assert.deepEqual(hits.map((one) => [one.id, one.kind, one.subtitle]), [["tmdb:11", "movie", "1977"], ["tmdb:12", "person", "Acting"]]);
    assert.equal(hits[0]?.imageUrl, "https://image.tmdb.org/t/p/w500/a.jpg");
    assert.equal(hits[0]?.thumbUrl, "https://image.tmdb.org/t/p/w342/a.jpg");
  });

  it("AniList: titles in English first, characters with their show, never adult or default faces", () => {
    const hits = anilistHits({
      data: {
        media: { media: [
          { id: 20, type: "ANIME", seasonYear: 2002, title: { english: "Naruto", romaji: "NARUTO" }, coverImage: { extraLarge: "https://a/20xl.jpg", large: "https://a/20.jpg" } },
          { id: 21, type: "ANIME", isAdult: true, title: { romaji: "X" }, coverImage: { large: "https://a/21.jpg" } },
        ] },
        characters: { characters: [
          { id: 17, name: { full: "Naruto Uzumaki" }, image: { large: "https://a/c17.jpg" }, media: { nodes: [{ title: { english: "Naruto" } }] } },
          { id: 18, name: { full: "Nobody" }, image: { large: "https://a/default.jpg" } },
        ] },
      },
    });
    assert.deepEqual(hits.map((one) => [one.id, one.kind, one.subtitle]), [["anilist:20", "anime", "2002"], ["anilist:c17", "character", "Naruto"]]);
    assert.deepEqual(hits.map((one) => [one.imageUrl, one.thumbUrl]), [["https://a/20xl.jpg", null], ["https://a/c17.jpg", null]]);
  });

  it("Steam: apps only, the tall cover asked for first", () => {
    const hits = steamHits({ items: [{ id: 570, type: "app", name: "Dota 2" }, { id: 1, type: "sub", name: "Bundle" }] });
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.imageUrl ?? "", /570\/library_600x900\.jpg$/);
  });

  it("Deezer: an artist without a photo is left out", () => {
    const hits = deezerArtistHits({ data: [
      { id: 1, name: "Daft Punk", picture_xl: "https://e-cdns-images.dzcdn.net/images/artist/abc/1000x1000.jpg", picture_big: "https://e-cdns-images.dzcdn.net/images/artist/abc/500x500.jpg", picture_medium: "https://e-cdns-images.dzcdn.net/images/artist/abc/250x250.jpg" },
      { id: 2, name: "Nobody", picture_xl: "https://e-cdns-images.dzcdn.net/images/artist//1000x1000.jpg" },
    ] });
    assert.deepEqual(hits.map((one) => one.title), ["Daft Punk"]);
    assert.equal(hits[0]?.thumbUrl, "https://e-cdns-images.dzcdn.net/images/artist/abc/500x500.jpg");
  });

  it("Open Library: covers by id, author and year under the title", () => {
    const hits = openLibraryHits({ docs: [{ key: "/works/OL1W", title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, cover_i: 99 }, { key: "/works/OL2W", title: "No cover" }] });
    assert.deepEqual(hits.map((one) => [one.id, one.subtitle, one.imageUrl]), [["openlibrary:OL1W", "Frank Herbert · 1965", "https://covers.openlibrary.org/b/id/99-L.jpg"]]);
    assert.equal(hits[0]?.thumbUrl, null);
  });

  it("Wikidata: the label in the reader's language, a Commons picture, and its TMDB twins", () => {
    const candidates = wikidataCandidates(["Q5", "Q6"], {
      entities: {
        Q5: {
          labels: { ru: { value: "Борщ" }, en: { value: "Borscht" } },
          descriptions: { ru: { value: "суп" } },
          claims: { P18: [{ mainsnak: { datavalue: { value: "Borscht served.jpg" } } }], P4947: [{ mainsnak: { datavalue: { value: "77" } } }] },
        },
        Q6: { labels: { en: { value: "No picture" } }, claims: {} },
      },
    }, "ru");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.hit.title, "Борщ");
    assert.equal(candidates[0]?.hit.imageUrl, "https://commons.wikimedia.org/wiki/Special:FilePath/Borscht_served.jpg?width=600");
    assert.equal(candidates[0]?.hit.thumbUrl, "https://commons.wikimedia.org/wiki/Special:FilePath/Borscht_served.jpg?width=400");
    assert.deepEqual(candidates[0]?.tmdbIds, ["movie:77"]);
  });

  it("the web: https pictures only, long page titles cut", () => {
    const hits = webHits({ images: [
      { title: "x".repeat(100), imageUrl: "https://site/a.jpg", thumbnailUrl: "https://t/a", source: "site" },
      { title: "plain", imageUrl: "http://site/b.jpg" },
    ] });
    assert.equal(hits.length, 1);
    assert.equal([...(hits[0]?.title ?? "")].length, 80);
    assert.equal(hits[0]?.thumbUrl, "https://t/a");
  });
});

describe("isPrivateAddress", () => {
  it("refuses what is inside, lets the internet through", () => {
    for (const inside of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "172.20.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      assert.ok(isPrivateAddress(inside), inside);
    }
    assert.equal(isPrivateAddress("142.250.74.14"), false);
    assert.equal(isPrivateAddress("2a00:1450:4001::200e"), false);
  });
});
