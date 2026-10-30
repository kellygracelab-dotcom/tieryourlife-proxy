import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { viewerFollowsFor } from "../src/anonymous";
import { toSummary } from "../src/community";
import { tierCountsOf } from "../src/publishing";

describe("tierCountsOf", () => {
  it("counts the cards of each tier in tier order, and the unranked last as the pool", () => {
    const items = [{ tierIndex: 0 }, { tierIndex: 2 }, { tierIndex: 0 }, { tierIndex: null }];
    assert.deepEqual(tierCountsOf(3, items), [2, 0, 1, 1]);
  });

  it("counts a card naming a tier the list does not have, or none at all, with the pool", () => {
    assert.deepEqual(tierCountsOf(2, [{ tierIndex: 5 }, { tierIndex: -1 }, { tierIndex: 1.5 }, {}]), [0, 0, 4]);
  });

  it("is all zeros, pool included, for a list without cards", () => {
    assert.deepEqual(tierCountsOf(2, []), [0, 0, 0]);
  });
});

describe("viewerFollowsFor", () => {
  const list = { authorUid: "author-1" };
  const reader = { uid: "reader", isAnonymous: false };

  it("says whether a signed-in reader follows the author", () => {
    assert.deepEqual(viewerFollowsFor(list, reader, new Set(["author-1"])), { viewerFollowsAuthor: true });
    assert.deepEqual(viewerFollowsFor(list, reader, new Set(["someone-else"])), { viewerFollowsAuthor: false });
  });

  it("says nothing for a guest, who follows nobody", () => {
    assert.deepEqual(viewerFollowsFor(list, { uid: "guest", isAnonymous: true }, new Set(["author-1"])), {});
    assert.deepEqual(viewerFollowsFor(list, null, new Set(["author-1"])), {});
  });

  // An anonymous list names nobody; whether you follow its author would name them.
  it("says nothing for an anonymous list", () => {
    assert.deepEqual(viewerFollowsFor({ ...list, anonymous: true }, reader, new Set(["author-1"])), {});
  });

  it("says nothing when the follows were not read", () => {
    assert.deepEqual(viewerFollowsFor(list, reader, null), {});
  });
});

describe("a summary's first frame", () => {
  const stored = {
    title: "Space films",
    titleLower: "space films",
    authorUid: "author-1",
    authorName: "Someone",
    authorPhotoUrl: null,
    category: "film_tv",
    itemCount: 3,
    tiers: [{ label: "S" }, { label: "A" }],
    items: [{ title: "Arrival", tierIndex: 0 }, { title: "Moon", tierIndex: null }, { title: "Sunshine", tierIndex: 1 }],
    coverImageUrl: null,
    previewImages: [],
    tierColors: [],
  };
  const reader = { uid: "reader", isAnonymous: false };

  it("carries the counts stored at publication", () => {
    assert.deepEqual(toSummary("a", { ...stored, tierCounts: [7, 1, 0] } as never).tierCounts, [7, 1, 0]);
  });

  it("works them out for a list published before they were kept", () => {
    assert.deepEqual(toSummary("a", stored as never).tierCounts, [1, 1, 1]);
  });

  it("carries whether the reader follows the author, read once for the page", () => {
    const followed = new Set(["author-1"]);
    assert.equal(toSummary("a", stored as never, reader, followed).viewerFollowsAuthor, true);
    assert.equal(toSummary("a", stored as never, reader, new Set()).viewerFollowsAuthor, false);
  });

  it("leaves it out for a guest and for an anonymous list", () => {
    const followed = new Set(["author-1"]);
    assert.equal("viewerFollowsAuthor" in toSummary("a", stored as never, { uid: "g", isAnonymous: true }, followed), false);
    assert.equal("viewerFollowsAuthor" in toSummary("a", { ...stored, anonymous: true } as never, reader, followed), false);
  });
});
