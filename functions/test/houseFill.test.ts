import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardOf, extendList, MAX_JOB_QUERIES, MAX_SPACING_MS, pickHit, readJob } from "../src/houseFill";
import type { PictureHit } from "../src/pictureSources";
import type { PublishedItem } from "../src/publishing";

function hit(over: Partial<PictureHit>): PictureHit {
  return { id: "tmdb:1", title: "Up", subtitle: "2009", imageUrl: "https://i/up.jpg", thumbUrl: null, source: "tmdb", kind: "movie", ...over };
}

function card(title: string, imageUrl: string | null = `https://i/${title}.jpg`): PublishedItem {
  return { title, imageUrl, tierIndex: null };
}

describe("readJob", () => {
  it("keeps the searches it can run, a job's worth, and a spacing within bounds", () => {
    const queries = [{ typed: " Up ", scope: "film_tv" }, { typed: "x", scope: "film_tv" }, { typed: 3 }, { typed: "Felis catus", scope: "nonsense" }];
    assert.deepEqual(readJob({ queries, spacingMs: 99_999 }), {
      queries: [{ typed: "Up", scope: "film_tv" }, { typed: "Felis catus", scope: "all" }],
      spacingMs: MAX_SPACING_MS,
    });
    const many = Array.from({ length: MAX_JOB_QUERIES + 5 }, () => ({ typed: "Up", scope: "film_tv" }));
    assert.equal(readJob({ queries: many }).queries.length, MAX_JOB_QUERIES);
    assert.deepEqual(readJob(null), { queries: [], spacingMs: 0 });
  });
});

describe("pickHit", () => {
  it("takes the first hit of the card's kind, name and subtitle", () => {
    const hits = [hit({ id: "a", kind: "tv" }), hit({ id: "b", subtitle: "1997" }), hit({ id: "c" }), hit({ id: "d" })];
    assert.equal(pickHit({ title: "Up", scope: "film_tv", kind: "movie", subtitle: "2009" }, hits)?.id, "c");
  });

  it("reads names by their words, so punctuation and accents do not matter", () => {
    const hits = [hit({ title: "WALL·E", subtitle: "2008" })];
    assert.ok(pickHit({ title: "Wall-E", scope: "film_tv", kind: "movie" }, hits));
  });

  it("can go by the subtitle alone, as a Latin name, and by the catalogue's own name", () => {
    const cat = hit({ title: "Domestic Cat", subtitle: "Felis catus", kind: "animal", source: "inaturalist" });
    assert.ok(pickHit({ title: "House Cat", scope: "animals", kind: "animal", name: "", subtitle: "Felis catus" }, [cat]));
    assert.ok(pickHit({ title: "House Cat", scope: "animals", kind: "animal", name: "Domestic Cat" }, [cat]));
    assert.equal(pickHit({ title: "House Cat", scope: "animals", kind: "animal" }, [cat]), null);
  });

  it("would rather find nothing than something near", () => {
    assert.equal(pickHit({ title: "Up", scope: "film_tv", kind: "movie" }, [hit({ title: "Up in the Air" })]), null);
  });
});

describe("cardOf", () => {
  it("is an unranked card with the hit's picture and credit, cleaned as publish cleans one", () => {
    assert.deepEqual(cardOf("  Red   Fox ", hit({ imageUrl: "https://i/fox.jpg", credit: " (c) Someone,  some rights reserved (CC BY) " })), {
      title: "Red Fox",
      imageUrl: "https://i/fox.jpg",
      tierIndex: null,
      credit: "(c) Someone, some rights reserved (CC BY)",
    });
    assert.equal("credit" in cardOf("Up", hit({})), false);
  });
});

describe("extendList", () => {
  const tiers = [{}, {}, {}];

  it("keeps the old cards in their order, adds the new after them and counts them as publish does", () => {
    const old = [card("A"), { ...card("B"), tierIndex: 1 }];
    const result = extendList({ tiers, items: old, previewImages: ["https://i/A.jpg", "https://i/B.jpg"] }, [card("C"), card("D")]);
    assert.ok(result.ok);
    assert.deepEqual(result.fields.items.map((item) => item.title), ["A", "B", "C", "D"]);
    assert.equal(result.fields.itemCount, 4);
    assert.deepEqual(result.fields.tierCounts, [0, 1, 0, 3]);
    assert.deepEqual(result.fields.previewImages, ["https://i/A.jpg", "https://i/B.jpg", "https://i/C.jpg", "https://i/D.jpg"]);
  });

  it("leaves out what the list already shows, by name or by picture", () => {
    const result = extendList({ tiers, items: [card("Toy Story")], previewImages: ["https://i/Toy Story.jpg"] }, [
      card("toy story"),
      card("Another", "https://i/Toy Story.jpg"),
      card("Cars"),
      card("Cars", "https://i/other.jpg"),
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.added.map((item) => item.title), ["Cars"]);
    assert.deepEqual(result.duplicates, ["toy story", "Another", "Cars"]);
  });

  it("keeps a collage the house chose", () => {
    const result = extendList({ tiers, items: [card("A")], previewImages: ["https://i/chosen.jpg"] }, [card("B")]);
    assert.ok(result.ok);
    assert.deepEqual(result.fields.previewImages, ["https://i/chosen.jpg"]);
  });
});
