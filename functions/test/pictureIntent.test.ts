import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builtInWant,
  cleanId,
  fitsType,
  judgeHits,
  keepsNumbers,
  latinOf,
  nearSpelling,
  nameKey,
  otherLayout,
  otherScript,
  sameName,
  sameOrPlural,
  trimmedTail,
  typeOfNames,
  wantKey,
  wantRank,
  wantScore,
  wikipediaOf,
  wikipediaSuggestion,
  type Described,
} from "../src/pictureIntent";
import { hitScore, mergeHits, type PictureHit } from "../src/pictureSources";

const hit = (id: string, title: string, more: Partial<Described> = {}): Described => ({
  id,
  title,
  subtitle: null,
  imageUrl: `https://example.org/${id.replace(/\W/g, "-")}.jpg`,
  thumbUrl: null,
  source: id.split(":")[0] as PictureHit["source"],
  kind: "thing",
  ...more,
  ...(more.about && more.subtitle === undefined ? { subtitle: more.about } : {}),
});

describe("what a list wants", () => {
  it("reads built-in sections, leaves its own to their names, and keeps old clients as they were", () => {
    assert.equal(builtInWant(null), null);
    assert.deepEqual(builtInWant("film_tv"), { kind: "scope", scope: "film_tv" });
    assert.deepEqual(builtInWant("food"), { kind: "type", type: "food" });
    assert.deepEqual(builtInWant("sport"), { kind: "type", type: "sport" });
    assert.deepEqual(builtInWant("other"), { kind: "general" });
    assert.equal(builtInWant("abc123"), undefined);
    assert.equal(cleanId("food"), "food");
    assert.equal(cleanId("../etc"), null);
    assert.equal(cleanId(42), null);
  });

  it("tells a section's or topic's kind from its names, in the app's languages", () => {
    assert.equal(typeOfNames(["Cars"]), "cars");
    assert.equal(typeOfNames(["Supercars", "Суперкари"]), "cars");
    assert.equal(typeOfNames(["Міста світу"]), "places");
    assert.equal(typeOfNames(["Capitals of Europe"]), "places");
    assert.equal(typeOfNames(["Garden flowers"]), "plants");
    assert.equal(typeOfNames(["Football clubs"]), "sport");
    assert.equal(typeOfNames(["Tech brands"]), "brands");
    assert.equal(typeOfNames(["Fruits"]), "food");
    assert.equal(typeOfNames(["Random stuff"]), null);
  });

  it("keys the cache by what it made of them, not by the ids", () => {
    assert.equal(wantKey(null), "");
    assert.equal(wantKey({ kind: "type", type: "food" }), "t:food");
    assert.equal(wantKey({ kind: "scope", scope: "games" }), "s:games");
    assert.equal(wantKey({ kind: "general" }), "g");
  });
});

describe("a section without a catalogue", () => {
  const dish = hit("wikidata:Q46383", "Sushi", { about: "Japanese dish of vinegared rice" });
  const anime = hit("anilist:1", "Sushi", { kind: "anime", subtitle: "2011" });
  const name = hit("wikidata:Q1", "Sushi", { about: "Wikimedia disambiguation page" });
  const town = hit("wikidata:Q2", "Sushi", { about: "village in Japan" });

  it("tells a thing's kind by its English description", () => {
    assert.equal(fitsType(dish, "food"), true);
    assert.equal(fitsType(town, "food"), false);
    assert.equal(fitsType(town, "places"), true);
    assert.equal(fitsType(name, "places"), false);
    assert.equal(fitsType(anime, "food"), false);
    assert.equal(fitsType(hit("inaturalist:1", "Roses", { kind: "plant", source: "inaturalist" }), "plants"), true);
  });

  it("puts Wikidata's thing of the kind first, its others next, the catalogues after, a name's page last", () => {
    const food = { kind: "type", type: "food" } as const;
    const merged = mergeHits("Sushi", [[anime], [name, town, dish]], "all", (one) => wantRank(one, "all", food));
    assert.deepEqual(merged.map((one) => one.id), ["wikidata:Q46383", "wikidata:Q2", "anilist:1", "wikidata:Q1"]);
    const anything = mergeHits("Sushi", [[anime], [name, town, dish]], "all", (one) => wantRank(one, "all", { kind: "general" }));
    assert.deepEqual(anything.map((one) => one.id), ["wikidata:Q2", "wikidata:Q46383", "anilist:1", "wikidata:Q1"]);
  });

  it("keeps the order of an old client that sends no section", () => {
    const before = mergeHits("Sushi", [[anime], [name, town, dish]], "all");
    const now = mergeHits("Sushi", [[anime], [name, town, dish]], "all", (one) => wantRank(one, "all", null));
    assert.deepEqual(now.map((one) => one.id), before.map((one) => one.id));
    assert.equal(before[0]?.id, "anilist:1");
  });
});

describe("names", () => {
  it("compare without case, accents, punctuation, a leading article or Roman numbers", () => {
    assert.equal(sameName("The Matrix", "matrix"), true);
    assert.equal(sameName("Final Fantasy VII", "Final Fantasy 7"), true);
    assert.equal(sameName("Pokémon", "Pokemon"), true);
    // The item's name may be the singular of what was typed (20.11.2026).
    assert.equal(sameOrPlural("pancake", "Pancakes"), true);
    assert.equal(sameOrPlural("taco", "Tacos"), true);
    assert.equal(sameOrPlural("cherry", "Cherries"), true);
    assert.equal(sameOrPlural("Pancakes", "pancake"), true);
    assert.equal(sameOrPlural("French toast", "French toasts"), true);
    assert.equal(sameOrPlural("A", "As"), false);
    assert.equal(sameOrPlural("cat", "cats and dogs"), false);
    assert.equal(sameOrPlural("блин", "блины"), false);
    assert.equal(sameName("Crème brûlée", "Creme Brulee"), true);
    assert.equal(sameName("Fast & Furious", "fast and furious"), true);
    assert.equal(sameName("The", "the"), true);
    assert.equal(sameName("Matrix Reloaded", "Matrix"), false);
    assert.equal(nameKey("I, Robot"), nameKey("I Robot"));
  });

  it("tell a translation from a near miss by the writing", () => {
    assert.equal(otherScript("Крёстный отец", ["The Godfather"]), true);
    assert.equal(otherScript("Godfahter", ["The Godfather"]), false);
    assert.equal(otherScript("東京", ["Tokyo"]), true);
  });
});

describe("how sure", () => {
  const game = hit("igdb:1", "Hollow Knight", { kind: "game", source: "igdb" });
  const manga = hit("anilist:9", "Hollow Knight", { kind: "manga", source: "anilist" });

  it("is high for the one hit of the name and of the kind the list wants", () => {
    const [first, second] = judgeHits([game, manga], "Hollow Knight", "games", null, false, true);
    assert.equal(first?.confidence, "high");
    assert.equal(first?.doubts, undefined);
    assert.equal(second?.confidence, "low");
    assert.deepEqual(second?.doubts, ["otherKind"]);
  });

  it("is medium with namesakes of the kind, or where the list says nothing of what it holds", () => {
    const dune = [hit("tmdb:1", "Dune", { kind: "movie", source: "tmdb", subtitle: "2021" }), hit("tmdb:2", "Dune", { kind: "movie", source: "tmdb", subtitle: "1984" })];
    assert.deepEqual(judgeHits(dune, "Dune", "film_tv", null, false, true).map((one) => [one.confidence, one.doubts]), [["medium", ["namesakes"]], ["medium", ["namesakes"]]]);
    const apple = [hit("anilist:5", "Apple", { kind: "manga", source: "anilist" }), hit("wikidata:Q89", "Apple", { about: "fruit of the apple tree" })];
    const judged = judgeHits(apple, "Apple", "all", { kind: "general" }, false, true);
    assert.deepEqual(judged.map((one) => [one.confidence, one.doubts]), [["medium", ["noSection", "namesakes"]], ["medium", ["noSection", "namesakes"]]]);
  });

  it("takes the section's own first answer for a name in another script, and says it is another name", () => {
    const godfather = hit("tmdb:238", "The Godfather", { kind: "movie", source: "tmdb", subtitle: "1972" });
    const [first] = judgeHits([godfather], "Крёстный отец", "film_tv", null, false, true);
    assert.equal(first?.confidence, "medium");
    assert.deepEqual(first?.doubts, ["otherName"]);
    const [latin] = judgeHits([godfather], "Godfahter", "film_tv", null, false, true);
    assert.equal(latin?.confidence, "low");
  });

  it("sends the name a hit was found by, never its alias or description", () => {
    const kyiv = hit("wikidata:Q1899", "Kyiv", { alias: "Киев", about: "capital and largest city of Ukraine" });
    const [first] = judgeHits([kyiv], "Киев", "all", { kind: "type", type: "places" }, false, true);
    assert.equal(first?.matchedName, "Киев");
    assert.equal(first?.confidence, "high");
    assert.equal("alias" in (first ?? {}), false);
    assert.equal("about" in (first ?? {}), false);
  });

  it("is never high after a second attempt, and low for the web; later pages are not judged", () => {
    const [retried] = judgeHits([game], "Hollow Knight", "games", null, true, true);
    assert.deepEqual([retried?.confidence, retried?.doubts], ["medium", ["spelling"]]);
    const [web] = judgeHits([hit("web:1", "Hollow Knight", { kind: "web", source: "web" })], "Hollow Knight", "all", null, false, true);
    assert.deepEqual([web?.confidence, web?.doubts], ["low", ["web"]]);
    const [later] = judgeHits([game], "Hollow Knight", "games", null, false, false);
    assert.equal(later?.confidence, undefined);
  });
});

describe("the second attempt", () => {
  it("cuts what people add after a title", () => {
    assert.equal(trimmedTail("Игра престолов 8 сезон смотреть онлайн"), "Игра престолов");
    assert.equal(trimmedTail("Breaking Bad season 2 watch online"), "Breaking Bad");
    assert.equal(trimmedTail("Interstellar full movie"), "Interstellar");
    assert.equal(trimmedTail("Inception"), null);
    assert.equal(trimmedTail("Online"), null);
  });

  it("reads a title typed on the other keyboard layout", () => {
    assert.equal(otherLayout("Ьфекшч", "en"), "Matrix");
    assert.equal(otherLayout("Vfnhbwf", "ru"), "Матрица");
    assert.equal(otherLayout("Vfnhbwf", "en"), null);
    assert.equal(otherLayout("Intersteller", "en"), null);
    assert.equal(otherLayout("Борщ", "uk") === null || typeof otherLayout("Борщ", "uk") === "string", true);
  });

  it("takes Wikipedia's suggestion when it says another name", () => {
    assert.equal(wikipediaSuggestion({ query: { searchinfo: { suggestion: "interstellar" } } }, "Intersteller"), "interstellar");
    assert.equal(wikipediaSuggestion({ query: { searchinfo: { suggestion: "interstellar" } } }, "Interstellar"), null);
    assert.equal(wikipediaSuggestion({ query: {} }, "x"), null);
    // QA D2, 19.11.2026: "1984" became "1988", the 1988 Olympics first.
    assert.equal(wikipediaSuggestion({ query: { searchinfo: { suggestion: "1988" } } }, "1984"), null);
    assert.equal(wikipediaSuggestion({ query: { searchinfo: { suggestion: "blade runner 2049" } } }, "blade runer 2049"), "blade runner 2049");
    assert.equal(keepsNumbers("Rocky 2", "rocky 3"), false);
    assert.equal(keepsNumbers("Rocky", "rocky 2"), false);
    assert.equal(keepsNumbers("Intersteller", "interstellar"), true);
    assert.equal(wikipediaOf("pt-BR"), "pt");
    assert.equal(wikipediaOf("zh-Hant"), "zh");
  });
});

describe("Wikidata's own order", () => {
  it("decides among its things where the list is of a kind, not their titles", () => {
    const sport = { kind: "type", type: "sport" } as const;
    const player = hit("wikidata:Q1", "Kamil Glik", { alias: "Juventus", about: "Polish association football player" });
    const club = hit("wikidata:Q2", "Juventus FC", { about: "association football club in Turin, Italy" });
    const order = (want: typeof sport | null) =>
      mergeHits("Juventus", [[club, player]], "all", (one) => wantRank(one, "all", want), (one) => wantScore(one, want, hitScore(one, "Juventus"))).map((one) => one.id);
    assert.deepEqual(order(sport), ["wikidata:Q2", "wikidata:Q1"]);
    assert.deepEqual(order(null), ["wikidata:Q1", "wikidata:Q2"]);
  });
});

describe("a name typed in Cyrillic, and Wikipedia's other words (26.11.2026)", () => {
  it("writes Cyrillic as English writes names, \"з\" between vowels as \"s\"", () => {
    assert.equal(latinOf("лализа"), "lalisa");
    assert.equal(latinOf("Лиза"), "lisa");
    assert.equal(latinOf("Изабелла"), "isabella");
    assert.equal(latinOf("Зара"), "zara", "not first: no vowel before");
    assert.equal(latinOf("Мазда"), "mazda");
    assert.equal(latinOf("Щелкунчик"), "shchelkunchik");
    assert.equal(latinOf("Matrix"), null);
    assert.equal(latinOf("Ведьмак 3"), "vedmak 3");
    assert.equal(latinOf("Ведьмак Geralt"), null);
  });

  it("takes Wikipedia's spelling as a typo put right, not as another word", () => {
    assert.equal(nearSpelling("Intersteller", "interstellar"), true);
    assert.equal(nearSpelling("Гари Потер", "Гарри Поттер"), true);
    assert.equal(nearSpelling("наполен", "наполеон"), true);
    assert.equal(nearSpelling("лализа", "лариса"), false);
    assert.equal(nearSpelling("raiden", "rhydon"), false);
  });
});
