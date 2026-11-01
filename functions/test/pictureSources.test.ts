import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anilistHits,
  commonsFitting,
  commonsName,
  decideWeb,
  deezerArtistHits,
  fitsTile,
  igdbHits,
  inaturalistHits,
  inaturalistPhotos,
  inaturalistWithoutPhoto,
  matchScore,
  mergeHits,
  openLibraryHits,
  PictureHit,
  pictureScopeOf,
  sourcesFor,
  steamAppIds,
  wantsCovers,
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
    assert.deepEqual(sourcesFor("all"), ["tmdb", "anilist", "igdb", "steam", "deezer", "openlibrary", "inaturalist", "wikidata"]);
    assert.deepEqual(sourcesFor("animals"), ["inaturalist", "wikidata"]);
    assert.equal(pictureScopeOf("animals"), "animals");
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
          { id: 22, type: "ANIME", title: { romaji: "Y" }, coverImage: { large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/default.jpg" } },
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

  it("Steam: apps only, each by its tall cover where Steam keeps it, and none without one", () => {
    const ids = steamAppIds({ items: [{ id: 3527290, type: "app", name: "PEAK" }, { id: 1, type: "sub", name: "Bundle" }, { id: 10, type: "app" }, { id: 7, type: "app" }] });
    assert.deepEqual(ids, [3527290, 10, 7]);
    const hits = steamHits(ids, { response: { store_items: [
      { appid: 10, name: "Counter-Strike", assets: { asset_url_format: "steam/apps/10/${FILENAME}?t=1", library_capsule: "library_600x900.jpg" } },
      { appid: 3527290, name: "PEAK", assets: {
        asset_url_format: "steam/apps/3527290/${FILENAME}?t=2",
        library_capsule: "480b/library_600x900.jpg",
        library_capsule_2x: "480b/library_600x900_2x.jpg",
        header: "header.jpg",
      } },
      { appid: 7, name: "Only a banner", assets: { asset_url_format: "steam/apps/7/${FILENAME}", header: "header.jpg" } },
    ] } });
    assert.deepEqual(hits.map((one) => [one.title, one.imageUrl, one.thumbUrl]), [
      ["PEAK", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/480b/library_600x900_2x.jpg?t=2", null],
      ["Counter-Strike", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/library_600x900.jpg?t=1", null],
    ]);
  });

  it("Commons sizes: covers must stand upright, photos may be cropped, nothing small, names as Commons writes them", () => {
    const body = { query: { pages: {
      "1": { title: "File:Hollow Knight cover.jpg", imageinfo: [{ width: 600, height: 900 }] },
      "2": { title: "File:Album.png", imageinfo: [{ width: 500, height: 500 }] },
      "3": { title: "File:Game logo.svg", imageinfo: [{ width: 1200, height: 300 }] },
      "4": { title: "File:Fox.jpg", imageinfo: [{ width: 2048, height: 1638 }] },
      "5": { title: "File:Tiny.jpg", imageinfo: [{ width: 120, height: 160 }] },
      "-1": { title: "File:Missing.jpg", missing: "" },
    } } };
    const covers = commonsFitting(body, true);
    assert.deepEqual([...covers].sort(), ["Album.png", "Hollow Knight cover.jpg"]);
    assert.ok(covers.has(commonsName("hollow_Knight_cover.jpg")));
    assert.deepEqual([...commonsFitting(body, false)].sort(), ["Album.png", "Fox.jpg", "Hollow Knight cover.jpg"]);
  });

  it("which scopes want covers, and what fits a tile", () => {
    assert.deepEqual(["all", "animals", "games", "people"].map((scope) => wantsCovers(pictureScopeOf(scope))), [false, false, true, true]);
    assert.equal(fitsTile(600, 900, true), true);
    assert.equal(fitsTile(901, 900, true), false);
    assert.equal(fitsTile(1500, 1000, false), true);
    assert.equal(fitsTile(1600, 1000, false), false);
    assert.equal(fitsTile(299, 600, false), false);
  });

  it("IGDB: the tall cover at twice the size, the year it came out, nothing without a cover", () => {
    const hits = igdbHits([
      { id: 1025, name: "The Legend of Zelda: Breath of the Wild", first_release_date: 1488499200, cover: { image_id: "co3p2d", width: 1080, height: 1440 } },
      { id: 7, name: "No cover" },
      { id: 8, name: "Odd cover", cover: { image_id: "../x" } },
      { id: 9, name: "Wide cover", cover: { image_id: "co1", width: 1920, height: 1080 } },
    ]);
    assert.deepEqual(hits.map((one) => [one.title, one.subtitle, one.imageUrl, one.kind]), [
      ["The Legend of Zelda: Breath of the Wild", "2017", "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co3p2d.jpg", "game"],
    ]);
  });

  it("the same game from IGDB and Steam is shown once, IGDB's first", () => {
    const igdb = { ...hit("igdb:1", "Hollow Knight"), kind: "game" as const, subtitle: "2017", source: "igdb" as const };
    const steam = { ...hit("steam:367520", "Hollow Knight"), kind: "game" as const, source: "steam" as const };
    assert.deepEqual(mergeHits("hollow knight", [[igdb], [steam]]).map((one) => one.id), ["igdb:1"]);
  });

  it("iNaturalist: the common name over the Latin one, a large photo, never a wide one or none", () => {
    const hits = inaturalistHits({ results: [
      { id: 42069, name: "Vulpes vulpes", preferred_common_name: "обыкновенная лисица", default_photo: { license_code: "cc-by", attribution: "(c) Ann, some rights reserved (CC BY)", medium_url: "https://static.inaturalist.org/photos/1/medium.jpg", original_dimensions: { width: 2048, height: 1638 } } },
      { id: 2, name: "Panorama", default_photo: { license_code: "cc0", medium_url: "https://static.inaturalist.org/photos/2/medium.jpg", original_dimensions: { width: 3000, height: 1000 } } },
      { id: 3, name: "Unseen" },
    ] });
    assert.deepEqual(hits.map((one) => [one.title, one.subtitle, one.imageUrl, one.thumbUrl, one.credit]), [
      ["Обыкновенная лисица", "Vulpes vulpes", "https://static.inaturalist.org/photos/1/large.jpg", "https://static.inaturalist.org/photos/1/medium.jpg", "(c) Ann, some rights reserved (CC BY)"],
    ]);
  });

  it("iNaturalist: a photo licensed non-commercially or not at all gives way to the taxon's first open one", () => {
    const photo = (id: number, license: string | null) => ({ license_code: license, medium_url: `https://static.inaturalist.org/photos/${id}/medium.jpg`, original_dimensions: { width: 2048, height: 1536 } });
    const found = { results: [
      { id: 1, name: "Vulpes vulpes", default_photo: photo(10, null) },
      { id: 2, name: "Vulpes lagopus", default_photo: photo(20, "cc-by-nc") },
      { id: 3, name: "Vulpes zerda", default_photo: photo(30, "cc0") },
    ] };
    assert.deepEqual(inaturalistWithoutPhoto(found), [1, 2]);
    const others = inaturalistPhotos({ results: [
      { id: 1, taxon_photos: [{ photo: photo(11, "cc-by-nc") }, { photo: photo(12, "cc-by-sa") }] },
      { id: 2, taxon_photos: [{ photo: photo(21, "cc-by-nd") }] },
    ] });
    assert.deepEqual(inaturalistHits(found, others).map((one) => one.thumbUrl), [
      "https://static.inaturalist.org/photos/12/medium.jpg",
      "https://static.inaturalist.org/photos/30/medium.jpg",
    ]);
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

  it("the web: https pictures big enough for a tile, the picture itself in the grid, long page titles cut", () => {
    const hits = webHits({ images: [
      { title: "x".repeat(100), imageUrl: "https://site/a.jpg", imageWidth: 800, imageHeight: 1000, thumbnailUrl: "https://t/a", source: "site" },
      { title: "plain", imageUrl: "http://site/b.jpg", imageWidth: 800, imageHeight: 1000 },
      { title: "banner", imageUrl: "https://site/c.jpg", imageWidth: 1600, imageHeight: 400 },
      { title: "icon", imageUrl: "https://site/d.jpg", imageWidth: 128, imageHeight: 128 },
      { title: "unknown size", imageUrl: "https://site/e.jpg" },
    ] });
    assert.deepEqual(hits.map((one) => one.imageUrl), ["https://site/a.jpg"]);
    assert.equal([...(hits[0]?.title ?? "")].length, 80);
    assert.equal(hits[0]?.thumbUrl, null);
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
