import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillVisible, isAnonymous, ownAuthor, readAnonymous, shownAuthor } from "../src/anonymous";

const list = { authorUid: "u1", authorName: "Danylo", authorPhotoUrl: "https://p/face.jpg" };

describe("readAnonymous", () => {
  it("is asked for with true and nothing else", () => {
    assert.equal(readAnonymous(true), true);
    for (const value of [false, "true", 1, null, undefined]) assert.equal(readAnonymous(value), false, String(value));
  });
});

describe("shownAuthor", () => {
  it("names the author of a list published with a name", () => {
    assert.deepEqual(shownAuthor(list), { ...list, anonymous: false });
    assert.equal(isAnonymous({ ...list, anonymous: false }), false);
    assert.equal(isAnonymous({ ...list, anonymous: true }), true);
  });

  it("names nobody for an anonymous list", () => {
    assert.deepEqual(shownAuthor({ ...list, anonymous: true }), {
      authorUid: "",
      authorName: "",
      authorPhotoUrl: null,
      anonymous: true,
    });
  });
});

describe("ownAuthor", () => {
  it("tells the author it is theirs, and that it goes out without their name", () => {
    assert.deepEqual(ownAuthor({ ...list, anonymous: true }), { ...list, anonymous: true });
  });
});

describe("fillVisible", () => {
  /** Rows 0..n-1 in pages, each read recorded, as Firestore would hand them over. */
  function source(rows: number[]) {
    const reads: (number | null)[] = [];
    const fetch = async (after: number | null) => {
      reads.push(after);
      const from = after === null ? 0 : rows.indexOf(after) + 1;
      return rows.slice(from, from + 3);
    };
    return { fetch, reads };
  }
  const even = (row: number) => row % 2 === 0;

  it("reads on past hidden rows until the page is full", async () => {
    const { fetch, reads } = source([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(await fillVisible(fetch, even, 3), { rows: [0, 2, 4], more: true });
    assert.deepEqual(reads, [null, 2]);
  });

  it("says when there is nothing more", async () => {
    const { fetch } = source([0, 1, 2, 3]);
    assert.deepEqual(await fillVisible(fetch, even, 3), { rows: [0, 2], more: false });
  });

  // The cursor is the last row returned, so a hidden row never becomes one.
  it("always ends a full page on a row it shows", async () => {
    const { fetch } = source([1, 0, 3, 2, 5, 4, 7]);
    const page = await fillVisible(fetch, even, 3);
    assert.deepEqual(page.rows, [0, 2, 4]);
  });

  it("stops after as many reads as it is allowed, carrying on only from a row it showed", async () => {
    const { fetch } = source([0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
    assert.deepEqual(await fillVisible(fetch, even, 3, 2), { rows: [0], more: true });
    const { fetch: hidden } = source([1, 3, 5, 7, 9, 11, 13]);
    assert.deepEqual(await fillVisible(hidden, even, 3, 2), { rows: [], more: false });
  });
});
