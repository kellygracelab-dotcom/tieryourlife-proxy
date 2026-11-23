import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRESH_MAX, freshEligible, freshRow } from "../src/freshRow";

const card = (picture: boolean) => ({ title: "x", imageUrl: picture ? "https://image.tmdb.org/t/p/w342/a.jpg" : null });
const cards = (pictured: number, plain = 0) => [...Array.from({ length: pictured }, () => card(true)), ...Array.from({ length: plain }, () => card(false))];
const previews = (n: number) => Array.from({ length: n }, (_, at) => `https://image.tmdb.org/t/p/w342/${at}.jpg`);
const good = { authorUid: "danylo", items: cards(16), coverImageUrl: null, previewImages: previews(4) };

describe("the row of new lists from the community (23.11.2026)", () => {
  it("takes a person's named list with eight pictured cards and a collage", () => {
    assert.equal(freshEligible(good), true);
  });

  it("leaves out the house's, anonymous ones and ones under review", () => {
    assert.equal(freshEligible({ ...good, authorUid: "tyl-editorial" }), false);
    assert.equal(freshEligible({ ...good, anonymous: true }), false);
    assert.equal(freshEligible({ ...good, underReview: true }), false);
  });

  it("asks for eight cards, four in five with a picture", () => {
    assert.equal(freshEligible({ ...good, items: cards(7) }), false);
    assert.equal(freshEligible({ ...good, items: cards(8, 2) }), true);
    assert.equal(freshEligible({ ...good, items: cards(7, 2) }), false);
    assert.equal(freshEligible({ ...good, items: [...cards(8), { title: "x", imageUrl: "file:///a.jpg" }, { title: "y" }] }), true);
    assert.equal(freshEligible({ ...good, items: [...cards(7), { title: "x", imageUrl: "file:///a.jpg" }, { title: "y" }] }), false);
  });

  it("asks for a cover or four collage pictures", () => {
    assert.equal(freshEligible({ ...good, previewImages: previews(3) }), false);
    assert.equal(freshEligible({ ...good, previewImages: previews(3), coverImageUrl: "https://image.tmdb.org/t/p/w780/c.jpg" }), true);
    assert.equal(freshEligible({ ...good, previewImages: ["null", "null", "null", "null"] }), false);
  });

  it("keeps three of an author's newest and lets authors take turns", () => {
    const list = (id: string, authorUid: string) => ({ id, authorUid });
    const row = freshRow([list("a1", "a"), list("a2", "a"), list("b1", "b"), list("a3", "a"), list("a4", "a"), list("c1", "c"), list("b2", "b")]);
    assert.deepEqual(row.map((one) => one.id), ["a1", "b1", "c1", "a2", "b2", "a3"]);
  });

  it("shows Danylo's three alone, newest first", () => {
    const row = freshRow([{ id: "games", authorUid: "d" }, { id: "anime", authorUid: "d" }, { id: "films", authorUid: "d" }]);
    assert.deepEqual(row.map((one) => one.id), ["games", "anime", "films"]);
  });

  it("holds twelve at most", () => {
    const many = Array.from({ length: 30 }, (_, at) => ({ id: String(at), authorUid: `author${at}` }));
    assert.equal(freshRow(many).length, FRESH_MAX);
    assert.deepEqual(freshRow(many).map((one) => one.id), many.slice(0, FRESH_MAX).map((one) => one.id));
  });
});
