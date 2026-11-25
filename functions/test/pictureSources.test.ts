import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeHits } from "../src/pictureIntent";
import {
  anilistHits,
  commonsFitting,
  commonsName,
  decideWeb,
  deezerArtistHits,
  fitsTile,
  hasSlowSources,
  igdbHits,
  inaturalistHits,
  inaturalistObservationPhotos,
  inaturalistPhotos,
  inaturalistWithoutPhoto,
  matchScore,
  mergeHits,
  appendNew,
  fittingPicture,
  scopeRank,
  searchLanguage,
  worthSearching,
  WIDEST_PHOTO,
  openLibraryHits,
  PictureHit,
  pictureScopeOf,
  quickSourcesFor,
  sourcesFor,
  steamAppIds,
  wantsCovers,
  steamHits,
  tmdbHits,
  webHits,
  wikidataCandidates,
  isMusicItem,
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
    assert.deepEqual(sourcesFor("all"), ["tmdb", "anilist", "igdb", "steam", "openlibrary", "inaturalist", "wikidata"]);
    assert.deepEqual(sourcesFor("animals"), ["inaturalist", "wikidata"]);
    assert.equal(pictureScopeOf("animals"), "animals");
    assert.ok(sourcesFor("games").includes("wikidata"));
  });

  it("leaves Open Library out of a quick search, and only scopes that ask it have more to wait for", () => {
    assert.deepEqual(quickSourcesFor("all"), ["tmdb", "anilist", "igdb", "steam", "inaturalist", "wikidata"]);
    assert.deepEqual(quickSourcesFor("books"), ["wikidata"]);
    assert.equal(hasSlowSources("books"), true);
    assert.equal(hasSlowSources("all"), true);
    assert.equal(hasSlowSources("film_tv"), false);
  });
});

describe("decideWeb", () => {
  const base = { scope: "all" as const, forced: false, goodMatches: 0, configured: true, offUntilMs: 0, nowMs: 1000, usedToday: 0, usedThisMonth: 0 };

  it("asks the web for all when the catalogues found little", () => {
    assert.equal(decideWeb(base), "ask");
    assert.equal(decideWeb({ ...base, goodMatches: 10 }), "skip");
  });

  it("leaves a narrow scope to its catalogues unless asked everywhere or nothing was found", () => {
    assert.equal(decideWeb({ ...base, scope: "anime" }), "skip");
    assert.equal(decideWeb({ ...base, scope: "anime", forced: true }), "ask");
    assert.equal(decideWeb({ ...base, scope: "anime", empty: true }), "ask");
    assert.equal(decideWeb({ ...base, scope: "anime", empty: true, configured: false }), "off");
    assert.equal(decideWeb({ ...base, scope: "anime", empty: true, usedToday: WEB_DAILY_PER_USER }), "dailyLimit");
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
    assert.deepEqual(hits.map((one) => [one.imageUrl, one.thumbUrl]), [["https://a/20xl.jpg", "https://a/20.jpg"], ["https://a/c17.jpg", "https://a/c17.jpg"]]);
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
      ["PEAK", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/480b/library_600x900_2x.jpg?t=2", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/480b/library_600x900.jpg?t=2"],
      ["Counter-Strike", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/library_600x900.jpg?t=1", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/library_600x900.jpg?t=1"],
    ]);
  });

  it("Commons sizes: covers must stand upright, photos may be cropped, nothing small or unlicensed, names as Commons writes them", () => {
    const body = { query: { pages: {
      "1": { title: "File:Hollow Knight cover.jpg", imageinfo: [{ width: 600, height: 900, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "2": { title: "File:Album.png", imageinfo: [{ width: 500, height: 500, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "3": { title: "File:Game logo.svg", imageinfo: [{ width: 1200, height: 300, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "4": { title: "File:Fox.jpg", imageinfo: [{ width: 2048, height: 1638, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "5": { title: "File:Tiny.jpg", imageinfo: [{ width: 120, height: 160, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }] },
      "6": { title: "File:Unlicensed.jpg", imageinfo: [{ width: 2048, height: 1638 }] },
      "-1": { title: "File:Missing.jpg", missing: "" },
    } } };
    // A file whose licence Commons does not state is never offered: we could not copy it (mayCopy).
    const covers = commonsFitting(body, true);
    assert.deepEqual([...covers].sort(), ["Album.png", "Hollow Knight cover.jpg"]);
    assert.ok(covers.has(commonsName("hollow_Knight_cover.jpg")));
    assert.deepEqual([...commonsFitting(body, false)].sort(), ["Album.png", "Fox.jpg", "Hollow Knight cover.jpg"]);
  });

  it("which scopes want covers, and what fits a tile", () => {
    assert.deepEqual(["all", "animals", "music", "games", "people"].map((scope) => wantsCovers(pictureScopeOf(scope))), [false, false, false, true, true]);
    assert.equal(fitsTile(600, 900, true), true);
    assert.equal(fitsTile(901, 900, true), false);
    assert.equal(fitsTile(1500, 1000, false), true);
    // Paris (1.6), Everest (1.84) and Queen (1.57) are cropped into a tile now; a panorama is not.
    assert.equal(fitsTile(4592, 2870, false), true);
    assert.equal(fitsTile(2000, 1000, false), true);
    assert.equal(fitsTile(2001, 1000, false), false);
    assert.equal(fitsTile(12288, 3072, false), false);
    assert.equal(WIDEST_PHOTO, 2);
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
    // The tile shows the cover at half the size.
    assert.equal(hits[0]?.thumbUrl, "https://images.igdb.com/igdb/image/upload/t_cover_big/co3p2d.jpg");
  });

  it("in a scope with a catalogue of its own, its kind of picture first and Wikidata's last; all as before", () => {
    const thing = (id: string, title: string): PictureHit => ({ ...hit(id, title), source: "wikidata", kind: "thing" });
    const game = (id: string, title: string): PictureHit => ({ ...hit(id, title), source: "igdb", kind: "game" });
    const halo = [[game("igdb:740", "Halo: Combat Evolved")], [thing("wikidata:Q1", "Halo"), { ...thing("wikidata:Q2", "Halo"), subtitle: "optical phenomenon" }]];
    assert.deepEqual(mergeHits("halo", halo, "games").map((one) => one.id), ["igdb:740", "wikidata:Q1", "wikidata:Q2"]);
    assert.deepEqual(mergeHits("halo", halo, "all").map((one) => one.id), ["wikidata:Q1", "wikidata:Q2", "igdb:740"]);
    assert.deepEqual(mergeHits("halo", halo).map((one) => one.id), ["wikidata:Q1", "wikidata:Q2", "igdb:740"]);
    // Within the scope's own kind the best title still leads.
    assert.deepEqual(mergeHits("halo", [[game("igdb:1", "Halo Wars"), game("igdb:2", "Halo")]], "games").map((one) => one.id), ["igdb:2", "igdb:1"]);
  });

  it("an anime list gets the series before its manga, and the manga before a namesake from Wikidata", () => {
    const anilist = (id: string, kind: PictureHit["kind"]): PictureHit => ({ ...hit(id, "Attack on Titan"), source: "anilist", kind });
    const merged = mergeHits("attack on titan", [[anilist("anilist:53390", "manga"), anilist("anilist:16498", "anime")], [{ ...hit("wikidata:Q1", "Attack on Titan"), source: "wikidata", kind: "thing" }]], "anime");
    assert.deepEqual(merged.map((one) => one.id), ["anilist:16498", "anilist:53390", "wikidata:Q1"]);
    assert.deepEqual([scopeRank({ kind: "anime", source: "anilist" }, "anime"), scopeRank({ kind: "character", source: "anilist" }, "anime"), scopeRank({ kind: "thing", source: "wikidata" }, "anime")], [0, 1, 2]);
    assert.equal(scopeRank({ kind: "thing", source: "wikidata" }, "all"), 0);
  });

  it("of games with one title, the most rated is kept, where the first stood", () => {
    const game = (id: string, subtitle: string, popularity?: number): PictureHit => ({ ...hit(id, "Hollow Knight"), subtitle, source: "igdb", kind: "game", ...(popularity ? { popularity } : {}) });
    const merged = mergeHits("hollow knight", [[game("igdb:270000", "2023"), { ...hit("igdb:5", "Hollow Knight: Godmaster"), source: "igdb", kind: "game" }, game("igdb:14593", "2017", 2400)]], "games");
    assert.deepEqual(merged.map((one) => one.id), ["igdb:14593", "igdb:5"]);
    // Equally rated or unrated: the first, as before.
    assert.deepEqual(mergeHits("hollow knight", [[game("igdb:1", "2023"), game("igdb:2", "2017")]]).map((one) => one.id), ["igdb:1"]);
  });

  it("the whole answer keeps the quick one at its head, new hits below", () => {
    const quick = [hit("wikidata:Q1", "Dune"), hit("tmdb:2", "Dune Part Two")];
    const whole = [{ ...hit("openlibrary:OL1W", "Dune"), source: "openlibrary" as const, kind: "book" as const }, hit("tmdb:2", "Dune Part Two"), hit("wikidata:Q1", "Dune"), hit("openlibrary:OL2W", "Dune Messiah", "https://x/tmdb:2.jpg")];
    assert.deepEqual(appendNew(quick, whole).map((one) => one.id), ["wikidata:Q1", "tmdb:2", "openlibrary:OL1W"]);
    assert.deepEqual(appendNew([], whole).map((one) => one.id), whole.map((one) => one.id));
  });

  it("asks nothing for a string without a letter or a digit, in any script", () => {
    assert.deepEqual(["!!!???", "😀😀", "--", "…  ", "<>"].map(worthSearching), [false, false, false, false, false]);
    assert.deepEqual(["the", "1984", "東京", "Київ", "القاهرة", "<script>alert(1)</script>", "C++"].map(worthSearching), [true, true, true, true, true, true, true]);
  });

  it("keeps a search in the language alone, so a phone's en-US and the site's en share one answer", () => {
    assert.deepEqual(["en-US", "EN", "en", "uk-UA", "ja-JP", "ar-EG", "de"].map(searchLanguage), ["en", "en", "en", "uk", "ja", "ar", "de"]);
    assert.deepEqual(["pt-BR", "pt-br", "pt-PT", "pt"].map(searchLanguage), ["pt-BR", "pt-BR", "pt", "pt"]);
    assert.deepEqual(["zh-tw", "zh-hant", "zh"].map(searchLanguage), ["zh-TW", "zh-Hant", "zh"]);
    assert.deepEqual([undefined, "", "english", "e1", ["en"]].map(searchLanguage), ["en", "en", "en", "en", "en"]);
  });

  it("Wikidata: every picture an item names, preferred first, none deprecated; the next one shows when the first is too wide", () => {
    const value = (file: string, rank = "normal") => ({ rank, mainsnak: { datavalue: { value: file } } });
    const [candidate] = wikidataCandidates(["Q34221"], { entities: { Q34221: {
      labels: { en: { value: "Niagara Falls" } },
      claims: { P18: [value("Panorama.jpg"), value("Old.jpg", "deprecated"), value("Falls.jpg", "preferred")], P154: [value("Logo.svg")], P2716: [value("Collage.jpg")] },
    } } }, "en");
    assert.deepEqual(candidate?.files, ["Falls.jpg", "Panorama.jpg", "Logo.svg"]);
    assert.equal(candidate?.file, "Falls.jpg");
    const attribution = { source: "wikimedia" as const };
    const chosen = fittingPicture({ ...candidate!, files: ["Panorama.jpg", "Falls.jpg"] }, new Map([["Falls.jpg", { credit: "Someone", attribution }]]));
    assert.equal(chosen?.file, "Falls.jpg");
    assert.equal(chosen?.hit.imageUrl, "https://commons.wikimedia.org/wiki/Special:FilePath/Falls.jpg?width=600");
    assert.equal(chosen?.hit.thumbUrl, "https://commons.wikimedia.org/wiki/Special:FilePath/Falls.jpg?width=400");
    assert.equal(chosen?.hit.credit, "Someone");
    assert.equal(fittingPicture(candidate!, new Map()), null);
  });

  it("the same game from IGDB and Steam is shown once, IGDB's first", () => {
    const igdb = { ...hit("igdb:1", "Hollow Knight"), kind: "game" as const, subtitle: "2017", source: "igdb" as const };
    const steam = { ...hit("steam:367520", "Hollow Knight"), kind: "game" as const, source: "steam" as const };
    assert.deepEqual(mergeHits("hollow knight", [[igdb], [steam]]).map((one) => one.id), ["igdb:1"]);
  });

  it("iNaturalist: the common name over the Latin one, a large photo, never a wide one or none", () => {
    const hits = inaturalistHits({ results: [
      { id: 42069, name: "Vulpes vulpes", preferred_common_name: "обыкновенная лисица", default_photo: { license_code: "cc-by", attribution: "(c) Ann, some rights reserved (CC BY)", medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg", original_dimensions: { width: 2048, height: 1638 } } },
      { id: 2, name: "Panorama", default_photo: { license_code: "cc0", medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/2/medium.jpg", original_dimensions: { width: 3000, height: 1000 } } },
      { id: 3, name: "Unseen" },
    ] });
    assert.deepEqual(hits.map((one) => [one.title, one.subtitle, one.imageUrl, one.thumbUrl, one.credit]), [
      ["Обыкновенная лисица", "Vulpes vulpes", "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpg", "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg", "(c) Ann, some rights reserved (CC BY)"],
    ]);
  });

  it("iNaturalist: only a photo we may copy is offered: open licence, open-data bucket; never static.inaturalist.org, NC, ND or none", () => {
    const photo = (host: string, id: number, license: string | null, attribution?: string) => ({ license_code: license, ...(attribution ? { attribution } : {}), medium_url: `https://${host}/photos/${id}/medium.jpg`, original_dimensions: { width: 2048, height: 1536 } });
    const open = "inaturalist-open-data.s3.amazonaws.com";
    const hits = inaturalistHits({ results: [
      { id: 1, name: "Static", default_photo: photo("static.inaturalist.org", 1, "cc-by", "(c) Ann, some rights reserved (CC BY)") },
      { id: 2, name: "Non commercial", default_photo: photo(open, 2, "cc-by-nc") },
      { id: 3, name: "No derivatives", default_photo: photo(open, 3, "cc-by-nd") },
      { id: 4, name: "All rights", default_photo: photo(open, 4, null) },
      { id: 5, name: "Open by its code", default_photo: photo(open, 5, "cc-by-sa", "(c) Bo, some rights reserved") },
      { id: 6, name: "Public domain", default_photo: photo(open, 6, "pd", "no known copyright restrictions (public domain)") },
    ] });
    assert.deepEqual(hits.map((one) => [one.title, one.attribution?.license]), [["Open by its code", "CC BY-SA 4.0"], ["Public domain", "Public domain"]]);
    assert.deepEqual(inaturalistWithoutPhoto({ results: [{ id: 1, name: "Static", default_photo: photo("static.inaturalist.org", 1, "cc0") }] }), [1]);
  });

  it("iNaturalist: a photo licensed non-commercially or not at all gives way to the taxon's first open one", () => {
    const photo = (id: number, license: string | null) => ({ license_code: license, medium_url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/medium.jpg`, original_dimensions: { width: 2048, height: 1536 } });
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
      "https://inaturalist-open-data.s3.amazonaws.com/photos/12/medium.jpg",
      "https://inaturalist-open-data.s3.amazonaws.com/photos/30/medium.jpg",
    ]);
  });

  it("iNaturalist: a taxon with no open photo of its own takes one from its observations", () => {
    const photo = (id: number, license: string) => ({ license_code: license, medium_url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/medium.jpg`, original_dimensions: { width: 2048, height: 1536 } });
    const found = { results: [
      { id: 1, name: "Felis catus", preferred_common_name: "Domestic Cat", matched_term: "Cat", default_photo: photo(10, "cc-by-nc") },
      { id: 2, name: "Catonephele", preferred_common_name: "Catones", default_photo: photo(20, "cc0") },
      { id: 3, name: "Ursus arctos", default_photo: photo(30, "cc-by-nc") },
    ] };
    const others = new Map<number, unknown[]>([[3, [photo(31, "cc-by-nd")]]]);
    assert.deepEqual(inaturalistWithoutPhoto(found), [1, 3]);
    const observed = inaturalistObservationPhotos({ results: [
      { photos: [{ license_code: "cc-by", url: "https://inaturalist-open-data.s3.amazonaws.com/photos/11/square.jpeg", original_dimensions: { width: 2048, height: 1536 } }, { license_code: "cc0", url: "https://x/photos/12/square.jpg" }] },
      { photos: [] },
    ] });
    others.set(1, observed);
    const hits = inaturalistHits(found, others);
    assert.deepEqual(hits.map((one) => [one.title, one.thumbUrl]), [
      ["Domestic Cat", "https://inaturalist-open-data.s3.amazonaws.com/photos/11/medium.jpeg"],
      ["Catones", "https://inaturalist-open-data.s3.amazonaws.com/photos/20/medium.jpg"],
    ]);
    // Found by "Cat", the cat ranks as what was typed, above a name that merely starts so; the alias leaves as matchedName.
    const merged = mergeHits("cat", [hits]);
    assert.deepEqual(merged.map((one) => one.title), ["Domestic Cat", "Catones"]);
    const sent = judgeHits(merged, "cat", "animals", null, false, true);
    assert.equal("alias" in (sent[0] ?? {}), false);
    assert.equal(sent[0]?.matchedName, "Cat");
  });

  it("Deezer: a namesake with a sliver of the best-known artist's fans is left out", () => {
    const pic = (md5: string) => `https://cdn-images.dzcdn.net/images/artist/${md5}/1000x1000-000000-80-0-0.jpg`;
    const hits = deezerArtistHits({ data: [
      { id: 1, name: "Lauryn Hill", nb_fan: 1773, picture_xl: pic("a") },
      { id: 2, name: "Ms. Lauryn Hill", nb_fan: 557000, picture_xl: pic("b") },
      { id: 3, name: "Laura Hill", nb_fan: 184, picture_xl: pic("c") },
      { id: 4, name: "Lauryn Hill Tribute", nb_fan: 9000, picture_xl: pic("d") },
    ] });
    assert.deepEqual(hits.map((one) => one.title), ["Ms. Lauryn Hill", "Lauryn Hill Tribute"]);
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
    assert.equal(hits[0]?.thumbUrl, "https://covers.openlibrary.org/b/id/99-M.jpg");
  });

  it("Wikidata for music: an item with a genre or of a music class, not a church or a title", () => {
    const of = (id: string) => [{ mainsnak: { datavalue: { value: { id } } } }];
    const pictured = { P18: [{ mainsnak: { datavalue: { value: "A.jpg" } } }] };
    const entities = {
      Q1: { labels: { en: { value: "Abbey Road" } }, claims: { ...pictured, P31: of("Q482994") } },
      Q2: { labels: { en: { value: "Abbey Road Baptist Church" } }, claims: { ...pictured, P31: of("Q56242063") } },
      Q3: { labels: { en: { value: "Queen Latifah" } }, claims: { ...pictured, P31: of("Q5"), P136: of("Q11401") } },
      Q4: { labels: { en: { value: "queen regnant" } }, claims: { ...pictured, P31: of("Q355567") } },
    };
    assert.deepEqual(wikidataCandidates(["Q1", "Q2", "Q3", "Q4"], { entities }, "en", true).map(({ hit }) => hit.title), ["Abbey Road", "Queen Latifah"]);
    assert.equal(wikidataCandidates(["Q1", "Q2", "Q3", "Q4"], { entities }, "en").length, 4);
    assert.equal(isMusicItem({ P31: of("Q215380") }), true);
    assert.equal(isMusicItem({ P31: of("Q5") }), false);
    assert.equal(isMusicItem({}), false);
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

  it("Wikidata: a name kept only in `mul`, the same in every language, is the title", () => {
    const P18 = { P18: [{ mainsnak: { datavalue: { value: "Michael Jordan in 2014.jpg" } } }] };
    const entities = {
      Q41421: { labels: { mul: { value: "Michael Jordan" } }, descriptions: { en: { value: "American basketball player" } }, claims: P18 },
      Q7: { labels: { mul: { value: "PlayStation 5" }, de: { value: "PS5" } }, descriptions: { mul: { value: "console" } }, claims: P18 },
    };
    const english = wikidataCandidates(["Q41421", "Q7"], { entities }, "en");
    assert.deepEqual(english.map(({ hit }) => [hit.title, hit.subtitle]), [["Michael Jordan", "American basketball player"], ["PlayStation 5", "console"]]);
    // The reader's own language still comes first.
    assert.deepEqual(wikidataCandidates(["Q7"], { entities }, "de").map(({ hit }) => hit.title), ["PS5"]);
    assert.deepEqual(wikidataCandidates(["Q41421"], { entities }, "pt-BR").map(({ hit }) => hit.title), ["Michael Jordan"]);
  });

  it("the web: https pictures big enough for a tile, the search engine's thumbnail in the grid, long page titles cut", () => {
    const hits = webHits({ images: [
      { title: "x".repeat(100), imageUrl: "https://site/a.jpg", imageWidth: 800, imageHeight: 1000, thumbnailUrl: "https://t/a", source: "site", link: "https://site.example/page" },
      { title: "no page", imageUrl: "https://site/f.jpg", imageWidth: 800, imageHeight: 1000, link: "javascript:alert(1)" },
      { title: "plain", imageUrl: "http://site/b.jpg", imageWidth: 800, imageHeight: 1000 },
      { title: "banner", imageUrl: "https://site/c.jpg", imageWidth: 1600, imageHeight: 400 },
      { title: "icon", imageUrl: "https://site/d.jpg", imageWidth: 128, imageHeight: 128 },
      { title: "unknown size", imageUrl: "https://site/e.jpg" },
    ] });
    assert.deepEqual(hits.map((one) => one.imageUrl), ["https://site/a.jpg", "https://site/f.jpg"]);
    assert.equal([...(hits[0]?.title ?? "")].length, 80);
    // The page the picture stands on is kept, an https page only.
    assert.deepEqual(hits[0]?.attribution, { source: "web", link: "https://site.example/page" });
    assert.deepEqual(hits[1]?.attribution, { source: "web" });
    // The tile shows the search engine's https thumbnail; without one, the picture itself (25.11.2026).
    assert.deepEqual(hits.map((one) => one.thumbUrl), ["https://t/a", null]);
  });

  it("the web: a Commons original is offered at 600 px, as Wikidata's hits are (24.11.2026)", () => {
    const original = "https://upload.wikimedia.org/wikipedia/commons/a/ae/Risotto_de_gambas%2C_restaurant_Danieli_%28Vienne%2C_Autriche%29.jpg?utm_source=ru.wikipedia.org&utm_campaign=index";
    const hits = webHits({ images: [
      { title: "Risotto", imageUrl: original, imageWidth: 4000, imageHeight: 3000, thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:r" },
      { title: "page", imageUrl: "https://commons.wikimedia.org/wiki/File:Risotto_Weihnachten_2020_13.jpg", imageWidth: 800, imageHeight: 600 },
      { title: "thumb", imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/X.jpg/960px-X.jpg", imageWidth: 960, imageHeight: 720 },
    ] });
    assert.deepEqual(hits.map((one) => one.imageUrl), [
      "https://commons.wikimedia.org/wiki/Special:FilePath/Risotto_de_gambas%2C_restaurant_Danieli_(Vienne%2C_Autriche).jpg?width=600",
      "https://commons.wikimedia.org/wiki/Special:FilePath/Risotto_Weihnachten_2020_13.jpg?width=600",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/X.jpg/960px-X.jpg",
    ]);
    // Its tile is the file at 400 px, as a Wikidata hit's is, before the search engine's thumbnail (25.11.2026).
    assert.deepEqual(hits.map((one) => one.thumbUrl), [
      "https://commons.wikimedia.org/wiki/Special:FilePath/Risotto_de_gambas%2C_restaurant_Danieli_(Vienne%2C_Autriche).jpg?width=400",
      "https://commons.wikimedia.org/wiki/Special:FilePath/Risotto_Weihnachten_2020_13.jpg?width=400",
      "https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=400",
    ]);
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
