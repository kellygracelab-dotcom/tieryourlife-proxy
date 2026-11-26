import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogueKeys,
  chooseEntity,
  entityFacts,
  entityKey,
  factsFit,
  kindOfFacts,
  namedBy,
  singerInstead,
  notAThing,
  wikipediaItems,
  withChosen,
  type EntityFacts,
  type Found,
} from "../src/pictureEntity";
import { CLASS_TABLE, CLASS_TABLE_DATE } from "../src/pictureClassTable";

/** An item as the entity step reads it; classes by the numbers of their Q-ids. */
function item(id: string, more: Partial<EntityFacts> = {}): EntityFacts {
  return { id, classes: [], supers: [], jobs: [], performers: [], sitelinks: 0, names: [], about: null, pictured: true, ids: {}, ...more };
}

const FILM = 11424;
const TV_SERIES = 5398426;
const ANIME_SERIES = 63952888;
const ANIME_FILM = 20650540;
const MANGA_SERIES = 21198342;
const NOVEL = 8261;
const BAND = 215380;
const ALBUM = 482994;
const HUMAN = 5;
const DISH = 746549;
const CITY = 515;
const FOOTBALLER = 937857;
const SINGER = 177220;
const DISAMBIGUATION = 4167410;

describe("the class table", () => {
  it("is generated, dated, and holds every kind the search reads", () => {
    assert.match(CLASS_TABLE_DATE, /^\d{4}-\d{2}-\d{2}$/);
    for (const kind of ["film", "tv", "anime", "manga", "games", "books", "musicGroup", "musicWork", "animals", "food", "sport", "cars", "brands", "musicianJob", "athleteJob", "notAThing"]) {
      assert.ok((CLASS_TABLE[kind] ?? "").split(",").length > 2, kind);
    }
  });
});

describe("what an item is", () => {
  it("is the kind a catalogue would call it, by its classes", () => {
    assert.equal(kindOfFacts(item("Q1", { classes: [FILM] })), "movie");
    assert.equal(kindOfFacts(item("Q1", { classes: [TV_SERIES] })), "tv");
    assert.equal(kindOfFacts(item("Q1", { classes: [ANIME_SERIES] })), "anime");
    assert.equal(kindOfFacts(item("Q1", { classes: [MANGA_SERIES] })), "manga");
    assert.equal(kindOfFacts(item("Q1", { classes: [NOVEL] })), "book");
    assert.equal(kindOfFacts(item("Q1", { classes: [BAND] })), "artist");
    assert.equal(kindOfFacts(item("Q1", { classes: [ALBUM] })), "album");
    assert.equal(kindOfFacts(item("Q1", { classes: [HUMAN] })), "person");
    assert.equal(kindOfFacts(item("Q1", { classes: [CITY] })), null);
  });

  it("is an artist in a music list when the person makes music, a person elsewhere", () => {
    const singer = item("Q36153", { classes: [HUMAN], jobs: [SINGER] });
    assert.equal(kindOfFacts(singer), "person");
    assert.equal(kindOfFacts(singer, null, "music"), "artist");
    assert.equal(kindOfFacts(item("Q1", { classes: [HUMAN], jobs: [FOOTBALLER] }), null, "music"), "person");
  });

  it("is a film in a list of films even when it is anime", () => {
    const spiritedAway = item("Q155653", { classes: [ANIME_FILM] });
    assert.equal(kindOfFacts(spiritedAway), "anime");
    assert.equal(kindOfFacts(spiritedAway, null, "film_tv"), "movie");
    assert.equal(kindOfFacts(spiritedAway, { kind: "scope", scope: "film_tv" }, "all"), "movie");
  });

  it("fits a list by its classes, what it is a subclass of, or a person's occupation", () => {
    const sushi = item("Q46383", { supers: [DISH] });
    assert.equal(factsFit(sushi, { kind: "type", type: "food" }, "all"), true);
    assert.equal(factsFit(item("Q90", { classes: [CITY] }), { kind: "type", type: "food" }, "all"), false);
    const footballer = item("Q1", { classes: [HUMAN], jobs: [FOOTBALLER] });
    assert.equal(factsFit(footballer, { kind: "type", type: "sport" }, "all"), true);
    assert.equal(factsFit(footballer, null, "music"), false);
    assert.equal(factsFit(item("Q1", { classes: [HUMAN], jobs: [SINGER] }), null, "music"), true);
    assert.equal(factsFit(footballer, null, "people"), true);
    // Anything, or places (no table): nothing to check.
    assert.equal(factsFit(sushi, { kind: "general" }, "all"), undefined);
    assert.equal(factsFit(sushi, { kind: "type", type: "places" }, "all"), undefined);
    assert.equal(factsFit(sushi, null, "all"), undefined);
  });

  it("is no thing when it is a page about a name, or says nothing of what it is", () => {
    assert.equal(notAThing(item("Q1", { classes: [DISAMBIGUATION] })), true);
    assert.equal(notAThing(item("Q1")), true);
    assert.equal(notAThing(item("Q1", { classes: [FILM] })), false);
  });
});

describe("choosing the item a name means", () => {
  const at = (wikidata?: number, wikipedia?: number): Found => ({ ...(wikidata === undefined ? {} : { wikidata }), ...(wikipedia === undefined ? {} : { wikipedia }) });

  it("takes the anime series over its better-known manga in an anime list", () => {
    const manga = item("Q26971382", { classes: [MANGA_SERIES], names: ["Naruto"], sitelinks: 122 });
    const anime = item("Q25929253", { classes: [ANIME_SERIES], names: ["Naruto"], sitelinks: 11 });
    const city = item("Q460812", { classes: [CITY], names: ["Naruto"], sitelinks: 49 });
    const chosen = chooseEntity([{ facts: manga, found: at(3, 0) }, { facts: anime, found: at(5, 2) }, { facts: city, found: at(1) }], "Naruto", null, "anime");
    assert.equal(chosen?.item, "Q25929253");
    assert.equal(chosen?.kind, "anime");
    assert.equal(chosen?.confidence, "medium");
  });

  it("is sure of a well-known item of the name and kind far ahead of the rest", () => {
    const film = item("Q47703", { classes: [FILM], names: ["The Godfather"], sitelinks: 90, ids: { tmdbMovie: "238" } });
    const novel = item("Q1139", { classes: [NOVEL], names: ["The Godfather"], sitelinks: 40 });
    const chosen = chooseEntity([{ facts: film, found: at(0, 0) }, { facts: novel, found: at(1, 1) }], "Godfather", null, "film_tv");
    assert.deepEqual(chosen, { item: "Q47703", confidence: "high", kind: "movie", ids: { tmdbMovie: "238" }, keys: ["wikidata:Q47703"] });
  });

  it("chooses nothing that is not the kind the list wants, a name's page, or found only by Wikipedia's text", () => {
    const city = item("Q90", { classes: [CITY], names: ["Paris"], sitelinks: 300 });
    assert.equal(chooseEntity([{ facts: city, found: at(0, 0) }], "Paris", { kind: "type", type: "food" }, "all"), null);
    const page = item("Q1", { classes: [DISAMBIGUATION], names: ["Mercury"] });
    assert.equal(chooseEntity([{ facts: page, found: at(0) }], "Mercury", { kind: "general" }, "all"), null);
    // "Taylor Swfit": Wikipedia's full text found an album that mentions the misspelling.
    const album = item("Q116371238", { classes: [ALBUM], names: ["Good Riddance"], sitelinks: 9 });
    assert.equal(chooseEntity([{ facts: album, found: at(undefined, 0) }], "Taylor Swfit", null, "music"), null);
  });

  it("takes a dish its plural names over a band of the plural, and on a list that says nothing, says it holds food", () => {
    const dish = item("Q44541", { supers: [DISH], names: ["pancake"], sitelinks: 67 });
    const band = item("Q838886", { classes: [BAND], names: ["Pancakes"], sitelinks: 5 });
    const found = [{ facts: band, found: at(0) }, { facts: dish, found: at(4, 0) }];
    const chosen = chooseEntity(found, "Pancakes", null, "all");
    assert.equal(chosen?.item, "Q44541");
    assert.equal(chosen?.implied, "food");
    // A list that says what it holds needs no guess; a film says nothing of food.
    assert.equal(chooseEntity(found, "Pancakes", { kind: "type", type: "food" }, "all")?.implied, undefined);
    const film = item("Q47703", { classes: [FILM], names: ["The Godfather"], sitelinks: 90 });
    assert.equal(chooseEntity([{ facts: film, found: at(0, 0) }], "The Godfather", null, "all")?.implied, undefined);
  });

  it("chooses nothing when two items are too close", () => {
    const one = item("Q1", { classes: [FILM], names: ["Avatar"], sitelinks: 80 });
    const two = item("Q2", { classes: [TV_SERIES], names: ["Avatar"], sitelinks: 80 });
    assert.equal(chooseEntity([{ facts: one, found: at(0, 1) }, { facts: two, found: at(1, 0) }], "Avatar", null, "film_tv")?.confidence, "medium");
    assert.equal(chooseEntity([{ facts: one, found: at(0, 0) }, { facts: two, found: at(0, 0) }], "Avatar", null, "film_tv"), null);
  });

  it("puts a Wikipedia disambiguation page out of the running", () => {
    const page = item("Q1721509", { classes: [FILM], names: ["Kaisen"], sitelinks: 3 });
    assert.equal(chooseEntity([{ facts: page, found: { wikipedia: 0, disambiguation: true } }], "Kaisen", null, "film_tv"), null);
  });
});

describe("Wikidata's and Wikipedia's answers", () => {
  it("reads classes, occupations, how known, names and catalogue ids, and skips deprecated claims", () => {
    const value = (id: string) => ({ mainsnak: { snaktype: "value", datavalue: { value: { id } } } });
    const text = (value: string, rank = "normal") => ({ rank, mainsnak: { snaktype: "value", datavalue: { value } } });
    const body = { entities: { Q47703: {
      labels: { en: { value: "The Godfather" }, ru: { value: "Крёстный отец" } },
      aliases: { en: [{ value: "Godfather" }] },
      descriptions: { en: { value: "1972 film by Francis Ford Coppola" } },
      sitelinks: { enwiki: {}, ruwiki: {}, dewiki: {} },
      claims: {
        P31: [value("Q11424")],
        P279: [],
        P4947: [text("999", "deprecated"), text("238")],
        P18: [text("Godfather.jpg")],
      },
    }, Q2: { missing: "" } } };
    const [facts, ...rest] = entityFacts(["Q47703", "Q2", "Q3"], body, ["ru"]);
    assert.equal(rest.length, 0);
    assert.deepEqual(facts, {
      id: "Q47703",
      classes: [11424],
      supers: [],
      jobs: [],
      performers: [],
      sitelinks: 3,
      names: ["Крёстный отец", "The Godfather", "Godfather"],
      about: "1972 film by Francis Ford Coppola",
      pictured: true,
      ids: { tmdbMovie: "238" },
    });
  });

  it("takes Wikipedia's pages in its order, with their items and disambiguation pages", () => {
    const body = { query: { pages: {
      "3": { index: 2, pageprops: { wikibase_item: "Q2", disambiguation: "" } },
      "1": { index: 1, pageprops: { wikibase_item: "Q1" } },
      "9": { index: 3, pageprops: {} },
    } } };
    assert.deepEqual(wikipediaItems(body), [{ item: "Q1", disambiguation: false }, { item: "Q2", disambiguation: true }]);
    assert.deepEqual(wikipediaItems({ batchcomplete: "" }), []);
  });
});

describe("the chosen item's pictures", () => {
  it("are known by their catalogues' keys, a TMDB id with its kind", () => {
    assert.equal(entityKey({ id: "tmdb:238", source: "tmdb", kind: "movie" }), "tmdb:movie:238");
    assert.equal(entityKey({ id: "anilist:20", source: "anilist", kind: "anime" }), "anilist:20");
    assert.deepEqual(catalogueKeys({ ids: { tmdbMovie: "238", anilist: "20", steam: "70", openLibrary: "OL45804W", inaturalist: "41944" } }), [
      "tmdb:movie:238", "anilist:20", "steam:70", "openlibrary:OL45804W", "inaturalist:41944",
    ]);
    // An Open Library edition is not the work a search hit names.
    assert.deepEqual(catalogueKeys({ ids: { openLibrary: "OL7353617M" } }), []);
  });

  it("are as sure as the choice; a second attempt's never more than medium; others stay as judged", () => {
    const hits = [
      { id: "tmdb:238", source: "tmdb" as const, kind: "movie" as const, confidence: "medium" as const, doubts: ["namesakes" as const] },
      { id: "wikidata:Q1139", source: "wikidata" as const, kind: "book" as const, confidence: "low" as const, doubts: ["otherKind" as const] },
    ];
    const chosen = { item: "Q47703", confidence: "high" as const, kind: "movie" as const, ids: { tmdbMovie: "238" }, keys: ["wikidata:Q47703", "tmdb:movie:238"] };
    assert.deepEqual(withChosen(hits, chosen, false), [{ id: "tmdb:238", source: "tmdb", kind: "movie", confidence: "high" }, hits[1]]);
    assert.deepEqual(withChosen(hits, chosen, true)[0], { id: "tmdb:238", source: "tmdb", kind: "movie", confidence: "medium", doubts: ["spelling", "namesakes"] });
    assert.deepEqual(withChosen(hits, { ...chosen, confidence: "medium" }, false)[0]?.doubts, ["namesakes"]);
    assert.deepEqual(withChosen(hits, null, false), hits);
  });
});

describe("Danylo's searches in All (26.11.2026)", () => {
  const found = (wikidata?: number, wikipedia?: number): Found => ({ ...(wikidata === undefined ? {} : { wikidata }), ...(wikipedia === undefined ? {} : { wikipedia }) });
  const HUMAN = 5;

  it("names a monarch by the name without the Roman number, a person only", () => {
    assert.equal(namedBy(item("Q517", { classes: [HUMAN], names: ["Наполеон I", "Napoleon Bonaparte"] }), "Наполеон"), true);
    assert.equal(namedBy(item("Q9682", { classes: [HUMAN], names: ["Elizabeth II"] }), "Elizabeth"), true);
    assert.equal(namedBy(item("Q517", { classes: [HUMAN], names: ["Наполеон I"] }), "Наполеон II"), false);
    assert.equal(namedBy(item("Q1", { classes: [FILM], names: ["Rocky II"] }), "Rocky"), false, "a sequel is no monarch");
    assert.equal(namedBy(item("Q2", { classes: [HUMAN], names: ["Louis CK"] }), "Louis"), false);
  });

  it("takes Napoleon I for \"Наполеон\", not the town in Ohio of exactly that name", () => {
    const town = item("Q986312", { names: ["Наполеон"], sitelinks: 41 });
    const emperor = item("Q517", { classes: [HUMAN], names: ["Наполеон I", "Наполеон Бонапарт"], sitelinks: 289 });
    const cake = item("Q105806948", { names: ["Наполеон"], sitelinks: 45 });
    const chosen = chooseEntity([{ facts: town, found: found(0) }, { facts: cake, found: found(3) }, { facts: emperor, found: found(12, 0) }], "Наполеон", null, "all");
    assert.equal(chosen?.item, "Q517");
  });

  it("takes the singer for a single and its song by one performer, neither with a picture to show, LALISA", () => {
    const song = item("Q108276514", { names: ["Lalisa"], sitelinks: 17, performers: ["Q26707663"] });
    const single = item("Q108429797", { classes: [ALBUM], names: ["Lalisa"], sitelinks: 15, performers: ["Q26707663"] });
    const lisa = item("Q26707663", { classes: [HUMAN], names: ["Лиса Манобан", "Lalisa Manobal"], sitelinks: 84 });
    const candidates = [{ facts: song, found: found(0, 1) }, { facts: single, found: found(1, 1) }, { facts: lisa, found: found(4, 0) }];
    const chosen = singerInstead(candidates, "LALISA", null, "all", new Set(["Q26707663"]));
    assert.equal(chosen?.item, "Q26707663");
    assert.equal(chosen?.confidence, "medium");
    assert.equal(chosen?.kind, "person");
    assert.equal(singerInstead(candidates.slice(0, 2), "LALISA", null, "all", new Set(["Q26707663"])), null, "a singer not found is not fetched");
    assert.equal(singerInstead(candidates, "LALISA", null, "all", new Set()), null, "nor one without a picture to show");
    assert.equal(singerInstead(candidates, "LALISA", null, "all", new Set(["Q26707663", "Q108429797"])), null, "a single whose picture shows stays itself");
    assert.equal(singerInstead(candidates, "Lisa", null, "all", new Set(["Q26707663"])), null, "only for the song's name");
  });

  it("keeps the song when a film of its name comes as close", () => {
    const song = item("Q1", { names: ["Bohemian Rhapsody"], sitelinks: 60, performers: ["Q15862"] });
    const film = item("Q2", { classes: [FILM], names: ["Bohemian Rhapsody"], sitelinks: 70 });
    const band = item("Q15862", { classes: [BAND], names: ["Queen"], sitelinks: 120 });
    const candidates = [{ facts: song, found: found(0, 0) }, { facts: film, found: found(1, 1) }, { facts: band, found: found(5) }];
    assert.equal(singerInstead(candidates, "Bohemian Rhapsody", null, "all", new Set(["Q15862"])), null);
  });

  it("reads a song's performer from its claims", () => {
    const body = { entities: { Q1: { claims: { P175: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: { id: "Q26707663" } } } }] } } } };
    assert.deepEqual(entityFacts(["Q1"], body, ["en"])[0]?.performers, ["Q26707663"]);
  });
});
