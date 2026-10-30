import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arrangementOver,
  cardIdentity,
  creditFor,
  creditNeedsRewrite,
  decidePublication,
  isOwnedRanking,
  mineFirst,
  rankingRefusal,
  rankingWrite,
  arrangementFromRows,
  readRankingBody,
  rowsFromDocument,
  rowsToDocument,
  readTakenFrom,
  sameCards,
  shownCredit,
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
    anonymous: false,
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

  // Two people may share a taste to the letter; the copy is a list of its own, crediting the first.
  it("is a list of its own based on the source even with the very same cards", () => {
    const reordered = [items[2], items[0], items[1]];
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source(), callerUid: "reader", items: reordered }), {
      kind: "list",
      basedOn: { id: "list-1", title: "Space films that hold up", authorUid: "author-1", authorName: "Artiman" },
    });
  });

  // A card added or taken away makes it the reader's own list, with the
  // author named on it rather than a copy nobody can tell from the original.
  it("is a new list based on the source once a card has changed", () => {
    const changed = [...items, poster("sunshine")];
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source(), callerUid: "reader", items: changed }), {
      kind: "list",
      basedOn: { id: "list-1", title: "Space films that hold up", authorUid: "author-1", authorName: "Artiman" },
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

describe("credits", () => {
  it("credit an anonymous list by nobody, with an empty uid", () => {
    assert.deepEqual(decidePublication({ takenFrom: "list-1", source: source({ anonymous: true }), callerUid: "reader", items: [] }), {
      kind: "list",
      basedOn: { id: "list-1", title: "Space films that hold up", authorUid: "", authorName: "" },
    });
    assert.deepEqual(creditFor({ ...source(), anonymous: true }), { id: "list-1", title: "Space films that hold up", authorUid: "", authorName: "" });
  });

  // The installed app reads authorName as a string that is never null.
  it("go out whole, an old one without the author's uid with an empty one, never with a null", () => {
    assert.deepEqual(shownCredit({ id: "list-1", title: "Space films", authorName: "Artiman" }), {
      id: "list-1",
      title: "Space films",
      authorUid: "",
      authorName: "Artiman",
    });
    assert.deepEqual(shownCredit({ id: "list-1", title: "Space films", authorUid: "", authorName: null }), {
      id: "list-1",
      title: "Space films",
      authorUid: "",
      authorName: "",
    });
  });

  it("are nothing when nothing is stored", () => {
    assert.equal(shownCredit(null), null);
    assert.equal(shownCredit(undefined), null);
    assert.equal(shownCredit({ title: "no id" }), null);
  });
});

describe("isOwnedRanking", () => {
  it("is a ranking somebody signed in made", () => {
    assert.equal(isOwnedRanking({ uid: "reader-1" }), true);
  });

  it("is not a visitor's ranking from the website, which has no account behind it", () => {
    assert.equal(isOwnedRanking({}), false);
    assert.equal(isOwnedRanking({ uid: "" }), false);
    assert.equal(isOwnedRanking({ uid: null }), false);
  });
});

describe("creditNeedsRewrite", () => {
  it("rewrites a copy that still names an original gone anonymous", () => {
    assert.equal(creditNeedsRewrite({ authorUid: "author-1" }, true), true);
    assert.equal(creditNeedsRewrite({ authorUid: "" }, true), false);
  });

  it("rewrites a copy that still credits nobody once the original has its name back", () => {
    assert.equal(creditNeedsRewrite({ authorUid: "" }, false), true);
    assert.equal(creditNeedsRewrite({ authorUid: "author-1" }, false), false);
  });
});

describe("readRankingBody", () => {
  const labels = ["S", "A", "B"];

  it("takes one tier or null per card of the list, in its order", () => {
    assert.deepEqual(readRankingBody({ arrangement: [0, null, 2], tierLabels: labels }, 3), {
      ok: true,
      arrangement: [0, null, 2],
      rows: null,
      tierLabels: labels,
    });
  });

  it("cleans the labels the way a tier's are cleaned", () => {
    const read = readRankingBody({ arrangement: [0], tierLabels: ["  Must   watch "] }, 1);
    assert.deepEqual(read.ok && read.tierLabels, ["Must watch"]);
  });

  it("refuses a placing that does not fit the list", () => {
    for (const arrangement of [[0, 1], [0, 1, 2, 0], [0, 3, null], [0, -1, null], [0, 1.5, null], [0, "1", null], "0,1,2"]) {
      assert.deepEqual(readRankingBody({ arrangement, tierLabels: labels }, 3), { ok: false, detail: "arrangement" }, JSON.stringify(arrangement));
    }
  });

  it("refuses labels that are none, too many, or not labels", () => {
    const twentyOne = Array.from({ length: 21 }, (_, at) => `T${at}`);
    for (const tierLabels of [[], twentyOne, ["S", "  "], ["S", 7], "S"]) {
      assert.deepEqual(readRankingBody({ arrangement: [null], tierLabels }, 1), { ok: false, detail: "tierLabels" }, JSON.stringify(tierLabels));
    }
  });

  it("allows twenty tiers, and a card in the last of them", () => {
    const twenty = Array.from({ length: 20 }, (_, at) => `T${at}`);
    assert.equal(readRankingBody({ arrangement: [19], tierLabels: twenty }, 1).ok, true);
  });
});

describe("rankingRefusal", () => {
  const reader = { uid: "reader", isAnonymous: false, banned: false };
  const list = { authorUid: "author-1", underReview: false };

  it("lets somebody signed in rank somebody else's list", () => {
    assert.equal(rankingRefusal(reader, list), null);
  });

  it("refuses a guest, and somebody banned", () => {
    assert.equal(rankingRefusal({ ...reader, isAnonymous: true }, list), "not_signed_in");
    assert.equal(rankingRefusal({ ...reader, banned: true }, list), "banned");
  });

  it("finds no list that is gone or under review", () => {
    assert.equal(rankingRefusal(reader, null), "missing");
    assert.equal(rankingRefusal(reader, { ...list, underReview: true }), "missing");
  });

  // An anonymous list goes out by nobody; whose it is comes from what is stored.
  it("refuses the list's own author, by the stored author", () => {
    assert.equal(rankingRefusal({ ...reader, uid: "author-1" }, list), "own_list");
  });
});

describe("rankingWrite", () => {
  it("counts a new ranking once", () => {
    assert.deepEqual(rankingWrite(false), { created: true, countChange: 1 });
  });

  it("counts nothing for a ranking being replaced", () => {
    assert.deepEqual(rankingWrite(true), { created: false, countChange: 0 });
  });
});

describe("rows of a ranking", () => {
  const labels = ["S", "A", "B"];

  // The point of rows: inside a tier, left to right is part of the placing.
  it("keeps the order inside each tier, and derives the tier per card for older readers", () => {
    const read = readRankingBody({ rows: [[3, 0], [], [1]], tierLabels: labels }, 5);
    assert.deepEqual(read, { ok: true, rows: [[3, 0], [], [1]], arrangement: [0, 2, null, 0, null], tierLabels: labels });
  });

  it("ignores an arrangement sent beside rows", () => {
    const read = readRankingBody({ rows: [[1], [0], []], arrangement: [2, 2], tierLabels: labels }, 2);
    assert.deepEqual(read.ok && read.arrangement, [1, 0]);
  });

  it("still takes the old body, which keeps no order and stores no rows", () => {
    assert.deepEqual(readRankingBody({ arrangement: [0, null], tierLabels: labels }, 2), {
      ok: true,
      arrangement: [0, null],
      rows: null,
      tierLabels: labels,
    });
  });

  it("refuses a card twice, across rows or within one", () => {
    assert.deepEqual(readRankingBody({ rows: [[0], [0], []], tierLabels: labels }, 3), { ok: false, detail: "rows" });
    assert.deepEqual(readRankingBody({ rows: [[1, 1], [], []], tierLabels: labels }, 3), { ok: false, detail: "rows" });
  });

  it("refuses a card the list does not have, or one that is not a whole number", () => {
    for (const rows of [[[3], [], []], [[-1], [], []], [[0.5], [], []], [["0"], [], []]]) {
      assert.deepEqual(readRankingBody({ rows, tierLabels: labels }, 3), { ok: false, detail: "rows" }, JSON.stringify(rows));
    }
  });

  it("refuses rows that are not one per tier", () => {
    assert.deepEqual(readRankingBody({ rows: [[0], [1]], tierLabels: labels }, 3), { ok: false, detail: "rows" });
    assert.deepEqual(readRankingBody({ rows: [[0], [1], [], []], tierLabels: labels }, 3), { ok: false, detail: "rows" });
    assert.deepEqual(readRankingBody({ rows: "0,1", tierLabels: labels }, 3), { ok: false, detail: "rows" });
  });

  it("checks the labels first, and asks for rows when neither rows nor an arrangement is sent", () => {
    assert.deepEqual(readRankingBody({ rows: [[0], [0]], tierLabels: [] }, 3), { ok: false, detail: "tierLabels" });
    assert.deepEqual(readRankingBody({ tierLabels: labels }, 3), { ok: false, detail: "rows" });
  });

  it("are stored as {items}, since Firestore keeps no array inside an array, and read back as they went in", () => {
    const stored = rowsToDocument([[3, 0], [], [1]]);
    assert.deepEqual(stored, [{ items: [3, 0] }, { items: [] }, { items: [1] }]);
    assert.deepEqual(rowsFromDocument(stored), [[3, 0], [], [1]]);
  });

  it("are none for a ranking stored without them, or with something else", () => {
    assert.deepEqual(rowsFromDocument(undefined), []);
    assert.deepEqual(rowsFromDocument([{ items: ["x"] }]), []);
  });

  it("leave a card in no row unranked", () => {
    assert.deepEqual(arrangementFromRows([[2], []], 4), [null, null, 0, null]);
  });
});
