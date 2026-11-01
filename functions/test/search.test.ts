import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold, matchesSearch, missOf, parseTranslations, searchKeysFor, searchQueryOf, wordsOf } from "../src/search";

describe("fold", () => {
  it("makes ё an е, é an e, and capitals small", () => {
    assert.equal(fold("Звёздные Войны"), "звездные войны");
    assert.equal(fold("Pokémon"), "pokemon");
  });
});

describe("wordsOf", () => {
  it("splits on anything not a letter or a digit", () => {
    assert.deepEqual(wordsOf("Star Wars: Episode IV"), ["star", "wars", "episode", "iv"]);
    assert.deepEqual(wordsOf("スター・ウォーズ"), ["スター", "ウォース"]);
  });
});

describe("searchKeysFor", () => {
  it("holds every start of every word, once", () => {
    assert.deepEqual(searchKeysFor(["Star Wars", "star"]), ["s", "st", "sta", "star", "w", "wa", "war", "wars"]);
  });
});

describe("searchQueryOf", () => {
  it("asks for the longest word and keeps the rest to check", () => {
    assert.deepEqual(searchQueryOf("  wars STAR "), { key: "wars", words: ["wars", "star"] });
  });

  it("is nothing for punctuation or nothing at all", () => {
    assert.equal(searchQueryOf("!!"), null);
    assert.equal(searchQueryOf(null), null);
  });
});

describe("matchesSearch", () => {
  const keys = searchKeysFor(["Star Wars", "Звёздные войны"]);

  it("finds a word from the middle of the title", () => {
    assert.ok(matchesSearch(keys, searchQueryOf("wars")!));
  });

  it("finds a translation, ё or е", () => {
    assert.ok(matchesSearch(keys, searchQueryOf("звездные во")!));
  });

  it("wants every word typed", () => {
    assert.equal(matchesSearch(keys, searchQueryOf("star trek")!), false);
  });

  it("is never true for a document without keys", () => {
    assert.equal(matchesSearch(undefined, searchQueryOf("star")!), false);
  });
});

describe("parseTranslations", () => {
  it("reads one array of names per title, fenced or not", () => {
    assert.deepEqual(parseTranslations('```json\n[["Star Wars","Звёздные войны"],["Pizza"]]\n```', 2), [["Star Wars", "Звёздные войны"], ["Pizza"]]);
  });

  it("refuses an answer of the wrong length or shape", () => {
    assert.equal(parseTranslations('[["a"]]', 2), null);
    assert.equal(parseTranslations("not json", 1), null);
  });

  it("drops what is not a short string", () => {
    assert.deepEqual(parseTranslations(`[["ok", 3, "${"x".repeat(201)}"]]`, 1), [["ok"]]);
  });
});

describe("missOf", () => {
  it("keeps the folded words, and nothing shorter than two letters", () => {
    assert.equal(missOf("  Звёздные   войны! "), "звездные войны");
    assert.equal(missOf("a"), null);
    assert.equal(missOf(42), null);
  });
});
