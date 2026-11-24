import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Chosen } from "../src/pictureEntity";
import { builtInWant, hintOf, trimmedTail, type Want } from "../src/pictureIntent";
import { rankFor, scoreFor, sectionWant } from "../src/pictureOrder";
import { goodMatches, mergeHits, quickSourcesFor, tmdbKeyOf, type PictureHit } from "../src/pictureSources";

/** Real catalogue answers of searches made with the All filter, kept by the server on 24.11.2026, eight hits each. */
interface Case {
  q: string;
  section: string | null;
  parts: { source: string; hits: PictureHit[]; twins?: Record<string, string[]>; chosen?: Chosen }[];
}
const cases = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "picture-order-cases.json"), "utf-8")) as Case[];
const caseOf = (q: string, section: string | null) => cases.find((one) => one.q === q && one.section === section);

/** The quick search's order, as `askCatalogues` merges the catalogues' answers. */
function ordered(q: string, want: Want | null, found: Case): PictureHit[] {
  const by = new Map(found.parts.map((part) => [part.source, part]));
  const answers = quickSourcesFor("all").map((source) => by.get(source) ?? { hits: [] as PictureHit[], twins: undefined });
  const tmdb = new Set(answers.flatMap((answer) => answer.hits).map(tmdbKeyOf).filter((key): key is string => key !== null));
  const hits = answers.map((answer) => answer.hits.filter((hit) => !(answer.twins?.[hit.id] ?? []).some((id) => tmdb.has(id))));
  const chosen = by.get("wikidata")?.chosen ?? null;
  const input = { typed: q, scope: "all" as const, want: sectionWant({ typed: q, scope: "all", want }, hits.flat()) };
  return mergeHits(q, hits, "all", rankFor(input, chosen), scoreFor(input, chosen));
}

/** The first hit as `search` gives it: the text as typed, then, finding nothing by that name, the text without its tail. */
function first(q: string, section: string | null): string | undefined {
  const want = builtInWant(section) ?? null;
  const asTyped = ordered(q, want, caseOf(q, section)!);
  if (goodMatches(q, asTyped) > 0) return asTyped[0]?.title;
  const trimmed = trimmedTail(q);
  const hinted = hintOf(q);
  const again = trimmed ? caseOf(trimmed, hinted?.kind === "type" ? hinted.type : section) : undefined;
  return again ? ordered(trimmed!, hinted ?? want, again)[0]?.title : asTyped[0]?.title;
}

describe("the order of a search made with the All filter (25.11.2026)", () => {
  it("gives the thing meant first, on a board of another kind too: real answers", () => {
    const expected: [string, string | null, string][] = [
      ["борщ блюдо", "games", "borscht"],
      ["борщ", "games", "borscht"],
      ["борщ", "food", "borscht"],
      ["Пельмени", "food", "pelmeni"],
      ["Оливье", "food", "Olivier salad"],
      ["Наполеон", "food", "Napoleon cake"],
      ["Плов", "food", "pilaf"],
      ["Titanic", "film_tv", "Titanic"],
      ["Dracula", "film_tv", "Dracula"],
      ["Shutter Island", "film_tv", "Shutter Island"],
      ["Star Wars", "film_tv", "Star Wars"],
      ["Monster energy", null, "Monster Energy"],
      ["Dune", null, "dune"],
    ];
    assert.deepEqual(expected.map(([q, section]) => [q, section, first(q, section)]), expected);
  });

  it("lets a catalogue's section rank only when its own kind matched what was typed", () => {
    const games: Want = { kind: "scope", scope: "games" };
    const hit = (kind: PictureHit["kind"], title: string): PictureHit => ({ id: title, title, subtitle: null, imageUrl: `https://x/${title}`, thumbUrl: null, source: kind === "game" ? "igdb" : "wikidata", kind });
    assert.equal(sectionWant({ typed: "борщ", scope: "all", want: games }, [hit("thing", "борщ"), hit("game", "Soup Shooter")]), null);
    assert.deepEqual(sectionWant({ typed: "Celeste", scope: "all", want: games }, [hit("game", "Celeste"), hit("thing", "Celeste")]), games);
    // The games filter itself, and a kind of thing, stay as they were.
    assert.deepEqual(sectionWant({ typed: "борщ", scope: "games", want: games }, [hit("thing", "борщ")]), games);
    assert.deepEqual(sectionWant({ typed: "борщ", scope: "all", want: { kind: "type", type: "food" } }, []), { kind: "type", type: "food" });
  });

  it("puts a person after a thing that matches as well, but not on a board of people, music or sport", () => {
    const person: PictureHit = { id: "tmdb:1", title: "Borsch", subtitle: "Acting", imageUrl: "https://x/p", thumbUrl: null, source: "tmdb", kind: "person" };
    const thing: PictureHit = { id: "Q1", title: "Borsch", subtitle: "soup", imageUrl: "https://x/t", thumbUrl: null, source: "wikidata", kind: "thing" };
    const order = (want: Want | null) => mergeHits("Borsch", [[person], [thing]], "all", rankFor({ typed: "Borsch", scope: "all", want }), scoreFor({ typed: "Borsch", scope: "all", want })).map((one) => one.kind);
    assert.deepEqual(order(null), ["thing", "person"]);
    assert.deepEqual(order({ kind: "general" }), ["thing", "person"]);
    assert.deepEqual(order({ kind: "scope", scope: "people" }), ["person", "thing"]);
    assert.deepEqual(order({ kind: "type", type: "sport" })[0], "thing", "Wikidata's things fit sport first, as before");
    // A person matching better still comes first.
    assert.deepEqual(mergeHits("Tom Hanks", [[{ ...person, title: "Tom Hanks" }], [{ ...thing, title: "Tom Hanks filmography" }]], "all", rankFor({ typed: "Tom Hanks", scope: "all" }), scoreFor({ typed: "Tom Hanks", scope: "all" })).map((one) => one.kind), ["person", "thing"]);
  });

  it("takes a kind word at the end as a hint for the second attempt only", () => {
    assert.equal(trimmedTail("борщ блюдо"), "борщ");
    assert.deepEqual(hintOf("борщ блюдо"), { kind: "type", type: "food" });
    assert.deepEqual(hintOf("Dune film"), { kind: "scope", scope: "film_tv" });
    assert.deepEqual(hintOf("лиса животное"), { kind: "scope", scope: "animals" });
    assert.equal(hintOf("Игра престолов"), null);
    assert.equal(hintOf("борщ"), null);
    assert.equal(trimmedTail("Игра престолов"), null);
  });
});
