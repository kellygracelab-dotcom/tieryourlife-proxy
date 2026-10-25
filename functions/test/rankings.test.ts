import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arrangementOver,
  cardIdentity,
  decidePublication,
  mineFirst,
  readTakenFrom,
  sameCards,
  type Card,
  type SourceList,
} from "../src/rankings";

const poster = (name: string): Card => ({ title: name, imageUrl: `https://image.tmdb.org/t/p/w500/${name}.jpg` });
const typed = (name: string): Card => ({ title: name, imageUrl: null });

function source(some: Partial<SourceList> = {}): SourceList {
  return {
    id: "list-1",
    authorUid: "author-1",
    title: "Space films that hold up",
    authorName: "Artiman",
    underReview: false,
    items: [poster("arrival"), poster("moon"), typed("Sunshine")],
    ...some,
  };
}

describe("cardIdentity", () => {
  it("is the picture when there is one, whatever the caption says", () => {
    assert.equal(cardIdentity({ title: "Arrival", imageUrl: "https://i/a.jpg" }), cardIdentity({ title: "ARRIVAL (2016)", imageUrl: "https://i/a.jpg" }));
  });

  it("is the name, read loosely, when there is no picture", () => {
    assert.equal(cardIdentity(typed("  Sun  shine ")), cardIdentity(typed("sun shine")));
    assert.notEqual(cardIdentity(typed("Sunshine")), cardIdentity(typed("Moon")));
  });

  it("never mistakes a name for a picture", () => {
    assert.notEqual(cardIdentity(typed("https://i/a.jpg")), cardIdentity({ title: "x", imageUrl: "https://i/a.jpg" }));
  });
});

describe("sameCards", () => {
  it("does not care about order", () => {
    assert.equal(sameCards([poster("a"), poster("b")], [poster("b"), poster("a")]), true);
  });

  it("counts copies: two of one card are not one", () => {
    assert.equal(sameCards([poster("a"), poster("a")], [poster("a")]), false);
    assert.equal(sameCards([poster("a"), poster("a")], [poster("a"), poster("a")]), true);
  });

  it("notices a card added, and one taken away", () => {
    assert.equal(sameCards([poster("a")], [poster("a"), poster("b")]), false);
    assert.equal(sameCards([poster("a"), poster("b")], [poster("a")]), false);
  });

  it("is the same cards whatever tier they went to", () => {
    const placed = [{ ...poster("a"), tierIndex: 0 }, { ...poster("b"), tierIndex: null }];
    assert.equal(sameCards([poster("b"), poster("a")], placed), true);
  });
});

describe("arrangementOver", () => {
  it("follows the source's order, not the reader's", () => {
    const placed = [
      { ...typed("Sunshine"), tierIndex: 2 },
      { ...poster("arrival"), tierIndex: 0 },
      { ...poster("moon"), tierIndex: null },
    ];
    assert.deepEqual(arrangementOver(source().items, placed), [0, null, 2]);
  });

  it("matches two copies of one card in the order they come", () => {
    const twice = [poster("a"), poster("a")];
    const placed = [{ ...poster("a"), tierIndex: 1 }, { ...poster("a"), tierIndex: 3 }];
    assert.deepEqual(arrangementOver(twice, placed), [1, 3]);
  });

  it("leaves a card the reader does not have unranked, and ignores one the source does not", () => {
    const placed = [{ ...poster("arrival"), tierIndex: 0 }, { ...poster("stranger"), tierIndex: 0 }];
    assert.deepEqual(arrangementOver(source().items, placed), [0, null, null]);
  });
});

describe("readTakenFrom", () => {
  it("takes an id as Firestore writes them", () => {
    assert.equal(readTakenFrom("GZwIJrkyxK4wtPiycOzX"), "GZwIJrkyxK4wtPiycOzX");
  });

  it("takes nothing else", () => {
    assert.equal(readTakenFrom(""), null);
    assert.equal(readTakenFrom("a/b"), null);
    assert.equal(readTakenFrom(42), null);
    assert.equal(readTakenFrom(undefined), null);
  });
});

describe("decidePublication", () => {
  const items = source().items;

  it("is a list of its own when nothing was taken from anywhere", () => {
    assert.deepEqual(decidePublication({ takenFrom: null, source: null, callerUid: "reader", items }), { kind: "list", basedOn: null });
  });

  it("is a ranking when the cards are the author's, in whatever order and tiers", () => {
    const reordered = [items[2], items[0], items[1]];
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source(), callerUid: "reader", items: reordered }), {
      kind: "ranking",
      listId: "list-1",
    });
  });

  // A card added or taken away makes it the reader's own list, with the
  // author named on it rather than a copy nobody can tell from the original.
  it("is a new list based on the source once a card has changed", () => {
    const changed = [...items, poster("sunshine")];
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source(), callerUid: "reader", items: changed }), {
      kind: "list",
      basedOn: { id: "list-1", title: "Space films that hold up", authorName: "Artiman" },
    });
  });

  it("ignores a source that is gone", () => {
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: null, callerUid: "reader", items }), { kind: "list", basedOn: null });
  });

  it("ignores a source that is under review", () => {
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source({ underReview: true }), callerUid: "reader", items }), {
      kind: "list",
      basedOn: null,
    });
  });

  it("lets an author publish their own list again as a list", () => {
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source(), callerUid: "author-1", items }), { kind: "list", basedOn: null });
  });
});

describe("mineFirst", () => {
  it("puts the reader's own ranking first and flags it", () => {
    const page = [{ uid: "a" }, { uid: "me" }, { uid: "b" }];
    assert.deepEqual(mineFirst(page, "me"), [
      { uid: "me", mine: true },
      { uid: "a", mine: false },
      { uid: "b", mine: false },
    ]);
  });

  it("leaves a page without the reader as it came", () => {
    assert.deepEqual(mineFirst([{ uid: "a" }], "me"), [{ uid: "a", mine: false }]);
  });
});
