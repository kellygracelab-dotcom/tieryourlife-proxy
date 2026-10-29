import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anonymityAfter, fillVisible, isAnonymous, mineFor, ownAuthor, readAnonymous, shownAuthor } from "../src/anonymous";

const list = { authorUid: "u1", authorName: "Danylo", authorPhotoUrl: "https://p/face.jpg" };

describe("readAnonymous", () => {
  it("says what a boolean says, and nothing for anything else", () => {
    assert.equal(readAnonymous(true), true);
    assert.equal(readAnonymous(false), false);
    for (const value of ["true", 1, null, undefined]) assert.equal(readAnonymous(value), null, String(value));
  });
});

describe("anonymityAfter", () => {
  it("does what a publish says", () => {
    assert.equal(anonymityAfter(true, null), true);
    assert.equal(anonymityAfter(false, { anonymous: true }), false);
    assert.equal(anonymityAfter(true, { anonymous: false }), true);
  });

  // The installed app's republish has never heard of the flag: it must not turn an anonymous list public.
  it("keeps what a republished list was when the publish says nothing", () => {
    assert.equal(anonymityAfter(null, { anonymous: true }), true);
    assert.equal(anonymityAfter(null, { anonymous: false }), false);
    assert.equal(anonymityAfter(null, {}), false);
  });

  it("publishes a new list with its author's name when nothing is said", () => {
    assert.equal(anonymityAfter(null, null), false);
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
    assert.deepEqual(await fillVisible(fetch, even, 3), { rows: [0, 2, 4], next: 4 });
    assert.deepEqual(reads, [null, 2]);
  });

  it("says when there is nothing more", async () => {
    const { fetch } = source([0, 1, 2, 3]);
    assert.deepEqual(await fillVisible(fetch, even, 3), { rows: [0, 2], next: null });
  });

  // The cursor is the last row returned, so a hidden row never becomes one.
  it("always ends a full page on a row it shows", async () => {
    const { fetch } = source([1, 0, 3, 2, 5, 4, 7]);
    const page = await fillVisible(fetch, even, 3);
    assert.deepEqual(page, { rows: [0, 2, 4], next: 4 });
  });

  it("stops after as many reads as it is allowed, carrying on only from a row it showed", async () => {
    const { fetch } = source([0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
    assert.deepEqual(await fillVisible(fetch, even, 3, { rounds: 2 }), { rows: [0], next: 0 });
    const { fetch: hidden } = source([1, 3, 5, 7, 9, 11, 13]);
    assert.deepEqual(await fillVisible(hidden, even, 3, { rounds: 2 }), { rows: [], next: null });
  });

  // Visitors' rankings can outnumber the shown ones by far; the sheet must not stop at them.
  it("can carry on from the last row read, shown or not, while rows remain", async () => {
    const { fetch } = source([1, 3, 5, 7, 9, 11, 13, 15]);
    assert.deepEqual(await fillVisible(fetch, even, 3, { rounds: 2, resumeFromHidden: true }), { rows: [], next: 11 });
    const { fetch: done } = source([1, 3, 5]);
    assert.deepEqual(await fillVisible(done, even, 3, { rounds: 1, resumeFromHidden: true }), { rows: [], next: 5 });
    const { fetch: short } = source([1, 3]);
    assert.deepEqual(await fillVisible(short, even, 3, { resumeFromHidden: true }), { rows: [], next: null });
  });
});

describe("mineFor", () => {
  const owner = { uid: "u1", isAnonymous: false };

  it("tells the author a list is theirs, by the stored author", () => {
    assert.deepEqual(mineFor(list, owner), { mine: true });
  });

  it("tells nobody else anything", () => {
    assert.deepEqual(mineFor(list, { uid: "u2", isAnonymous: false }), {});
    assert.deepEqual(mineFor(list, null), {});
  });

  // A guest's uid lives in one install and publishes nothing; it never owns a list.
  it("tells a guest nothing, whatever their uid", () => {
    assert.deepEqual(mineFor(list, { uid: "u1", isAnonymous: true }), {});
    assert.deepEqual(mineFor({ ...list, authorUid: "" }, { uid: "", isAnonymous: false }), {});
  });
});
