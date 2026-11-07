import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outsideAddressesIn } from "../src/outsidePictures";
import { decidePublish, settle } from "../src/publishing";
import { arrangementOver, sameCards } from "../src/rankings";
import { withoutDeezer } from "../scripts/remove-deezer-covers";

const DZ = (n: number) => `https://cdn-images.dzcdn.net/images/cover/${n}/1000x1000-000000-80-0-0.jpg`;
const DZ_OLD = "https://e-cdns-images.dzcdn.net/images/artist/abc/500x500.jpg";
const TMDB = "https://image.tmdb.org/t/p/w500/a.jpg";
const WIKI = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Band.jpg";

function publish(overrides: Record<string, unknown>) {
  const decision = decidePublish({
    body: {
      title: "Albums",
      category: "music",
      tiers: [{ label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
      items: [{ title: "Discovery", imageUrl: DZ(1), tierIndex: 0 }, { title: "Band", imageUrl: WIKI }],
      ...overrides,
    },
    isAnonymous: false,
    listsAlreadyPublished: 0,
    uploaderUid: "u1",
  });
  assert.ok(decision.ok);
  return decision.draft;
}

describe("publishing drops Deezer's covers", () => {
  it("keeps the card by its title without art, and the other pictures as they are", () => {
    const draft = publish({});
    assert.deepEqual(draft.items.map((item) => [item.title, item.imageUrl, item.tierIndex]), [["Discovery", null, 0], ["Band", WIKI, null]]);
  });

  it("leaves out a Deezer cover and collage picture, and the collage falls back to the cards' art", () => {
    const draft = publish({ coverImageUrl: DZ_OLD, coverImageUrls: [DZ(1), DZ(2)] });
    assert.equal(draft.coverImageUrl, null);
    assert.deepEqual(draft.coverImageUrls, []);
    assert.deepEqual(settle(draft, new Map()).previewImages, [WIKI]);
    assert.deepEqual(publish({ coverImageUrls: [DZ(1), WIKI] }).coverImageUrls, [WIKI]);
  });

  it("still publishes a card that had only a Deezer cover, and copies nothing", () => {
    const draft = publish({ items: [{ imageUrl: DZ(1) }, { title: "Band", imageUrl: WIKI }] });
    assert.deepEqual(draft.items.map((item) => item.imageUrl), [null, WIKI]);
    // Nothing from Deezer reaches the copying, so nothing is fetched or counted as dropped.
    assert.deepEqual(outsideAddressesIn(settle(draft, new Map()), "list1", "bucket"), []);
    const lookalike = publish({ items: [{ title: "X", imageUrl: "https://x.dzcdn.net/a.jpg" }] });
    assert.deepEqual(outsideAddressesIn(settle(lookalike, new Map()), "list1", "bucket"), []);
  });

  it("a ranking sent again of a list that still holds Deezer's covers is the same cards", () => {
    const list = [{ title: "Discovery", imageUrl: DZ(1) }, { title: "Arrival", imageUrl: TMDB }];
    const draft = publish({ items: [{ title: "Arrival", imageUrl: TMDB, tierIndex: 0 }, { title: "Discovery", imageUrl: DZ(1), tierIndex: 0 }] });
    assert.equal(sameCards(list, draft.items), true);
    assert.deepEqual(arrangementOver(list, draft.items), [0, 0]);
  });
});

describe("removing Deezer's covers from what is published", () => {
  const items = [
    { title: "Discovery", imageUrl: DZ(1), tierIndex: 0 },
    { title: "Band", imageUrl: WIKI, tierIndex: null },
    { title: "Homework", imageUrl: DZ(2), tierIndex: 1, credit: "someone" },
  ];

  it("leaves the cards by their titles, and draws a collage that followed them again", () => {
    const removal = withoutDeezer({ title: "Albums", items, coverImageUrl: null, previewImages: [DZ(1), WIKI, DZ(2)] });
    assert.ok(removal);
    assert.equal(removal.cards, 2);
    assert.deepEqual(removal.fields.items, [
      { title: "Discovery", imageUrl: null, tierIndex: 0 },
      items[1],
      { title: "Homework", imageUrl: null, tierIndex: 1, credit: "someone" },
    ]);
    assert.deepEqual(removal.fields.previewImages, [WIKI]);
    assert.deepEqual(Object.keys(removal.fields).sort(), ["items", "previewImages"]);
    assert.deepEqual(removal.before, { items, previewImages: [DZ(1), WIKI, DZ(2)] });
  });

  it("keeps a chosen collage without Deezer's pictures, and falls back to the cards when none is left", () => {
    const chosen = withoutDeezer({ items, coverImageUrl: DZ_OLD, previewImages: [TMDB, DZ(9)] });
    assert.deepEqual(chosen?.fields.previewImages, [TMDB]);
    assert.equal(chosen?.fields.coverImageUrl, null);
    const emptied = withoutDeezer({ items, previewImages: [DZ(9)] });
    assert.deepEqual(emptied?.fields.previewImages, [WIKI]);
  });

  it("finds nothing to do a second time, or on a list or ranking without Deezer", () => {
    const first = withoutDeezer({ items, coverImageUrl: DZ_OLD, previewImages: [DZ(1), WIKI, DZ(2)] });
    assert.ok(first);
    assert.equal(withoutDeezer({ items, coverImageUrl: DZ_OLD, previewImages: [DZ(1), WIKI, DZ(2)], ...first.fields }), null);
    assert.equal(withoutDeezer({ items: [items[1]], coverImageUrl: TMDB, previewImages: [WIKI] }), null);
    assert.equal(withoutDeezer({ listId: "a", uid: "b", arrangement: [0, null], authorPhotoUrl: null }), null);
  });
});
