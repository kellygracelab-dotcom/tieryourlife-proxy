import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  settle,
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_AUTHOR,
  MAX_PREVIEW_IMAGES,
  MAX_TITLE_LENGTH,
  decidePublish,
  picturesWanted,
} from "../src/publishing";
import { MAX_OWN_PICTURES_PER_LIST } from "../src/safety";

function body(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sci-fi films",
    category: "film_tv",
    tiers: [{ label: "S", caption: "Masterpiece", colorLight: "#B03A32", colorDark: "#F1948C" }],
    items: [{ title: "Arrival", imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg" }],
    ...overrides,
  };
}

function publish(overrides: Record<string, unknown> = {}, extras: Partial<{ isAnonymous: boolean; listsAlreadyPublished: number }> = {}) {
  return decidePublish({
    body: body(overrides),
    isAnonymous: false,
    listsAlreadyPublished: 0,
    ...extras,
  });
}

describe("decidePublish", () => {
  it("accepts a list and keeps its https image", () => {
    const decision = publish();

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.draft.items[0].imageUrl, "https://image.tmdb.org/t/p/w500/a.jpg");
  });

  // Putting a name on something needs a name; reading and copying do not.
  it("refuses a guest", () => {
    const decision = publish({}, { isAnonymous: true });

    assert.deepEqual(decision, { ok: false, reason: "not_signed_in" });
  });

  it("refuses once the author has published their fill", () => {
    const decision = publish({}, { listsAlreadyPublished: MAX_LISTS_PER_AUTHOR });

    assert.deepEqual(decision, { ok: false, reason: "too_many_lists" });
  });

  // The local-image rule is enforced here, not only in the app: a modified
  // client must not be able to publish a path into someone else's gallery.
  it("drops a local image instead of refusing the whole list", () => {
    const decision = publish({ items: [{ title: "Sunday roast", imageUrl: "file:///data/photo.jpg" }] });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.draft.items[0].imageUrl, null);
    assert.equal(decision.ok && decision.draft.items[0].title, "Sunday roast");
  });

  it("drops a plain http image, keeping only https", () => {
    const decision = publish({ items: [{ title: "A", imageUrl: "http://example.com/a.jpg" }] });

    assert.equal(decision.ok && decision.draft.items[0].imageUrl, null);
  });

  it("collapses whitespace and trims an over-long title", () => {
    const decision = publish({ title: "  Every   A24\n\tfilm  " + "x".repeat(MAX_TITLE_LENGTH) });

    assert.equal(decision.ok, true);
    const title = decision.ok ? decision.draft.title : "";
    assert.equal(title.startsWith("Every A24 film"), true);
    assert.equal(title.length, MAX_TITLE_LENGTH);
  });

  // The feed searches by prefix on this, so it has to be there and lower-cased.
  it("carries a lower-cased title for searching", () => {
    const decision = publish({ title: "Every A24 Film" });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.draft.titleLower, "every a24 film");
  });

  it("refuses a category that is not one of the eight", () => {
    const madeUp = publish({ category: "waifus" });
    const missing = publish({ category: undefined });

    assert.equal(madeUp.ok === false && madeUp.reason, "invalid");
    assert.equal(missing.ok === false && missing.reason, "invalid");
  });

  it("keeps an https cover and drops a local one", () => {
    const remote = publish({ coverImageUrl: "https://image.tmdb.org/t/p/w500/cover.jpg" });
    const local = publish({ coverImageUrl: "content://media/external/images/1" });

    assert.equal(remote.ok && remote.draft.coverImageUrl, "https://image.tmdb.org/t/p/w500/cover.jpg");
    assert.equal(local.ok && local.draft.coverImageUrl, null);
  });

  // The feed draws a mosaic from these, so it must not have to open the list.
  it("collects card art for the feed, capped and free of local images", () => {
    const items = Array.from({ length: MAX_PREVIEW_IMAGES + 3 }, (_, i) => ({
      title: `item ${i}`,
      imageUrl: i === 0 ? "file:///data/photo.jpg" : `https://example.com/${i}.jpg`,
    }));

    const decision = publish({ items });

    assert.equal(decision.ok, true);
    const previews = decision.ok ? settle(decision.draft, new Map()).previewImages : [];
    assert.equal(previews.length, MAX_PREVIEW_IMAGES);
    assert.equal(previews.every((url) => url.startsWith("https://")), true);
  });

  it("refuses a list with no items", () => {
    const decision = publish({ items: [] });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses more items than the cap allows", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_LIST + 1 }, (_, i) => ({ title: `item ${i}` }));

    const decision = publish({ items });

    assert.equal(decision.ok === false && decision.reason, "too_large");
  });

  it("accepts a thousand cards, which someone can genuinely have watched", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_LIST }, (_, i) => ({
      title: `film ${i}`,
      imageUrl: `https://image.tmdb.org/t/p/w500/${i}.jpg`,
    }));

    const decision = publish({ items });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.draft.items.length, MAX_ITEMS_PER_LIST);
  });

  // A count cannot express Firestore's document limit: few cards with very long
  // addresses outweigh many with short ones.
  it("refuses a snapshot too heavy to store, however few cards it has", () => {
    const longUrl = "https://example.com/" + "x".repeat(1900);
    const items = Array.from({ length: 400 }, (_, i) => ({ title: `film ${i}`, imageUrl: longUrl }));

    const decision = publish({ items });

    assert.equal(decision.ok === false && decision.reason, "too_large");
  });

  it("refuses a tier whose colours are not hex", () => {
    const decision = publish({
      tiers: [{ label: "S", caption: null, colorLight: "red", colorDark: "#F1948C" }],
    });

    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses a body that is not an object", () => {
    const decision = decidePublish({ body: "nope", isAnonymous: false, listsAlreadyPublished: 0 });

    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("keeps a caption when there is one and null when there is not", () => {
    const withCaption = publish();
    const withoutCaption = publish({
      tiers: [{ label: "S", caption: "   ", colorLight: "#B03A32", colorDark: "#F1948C" }],
    });

    assert.equal(withCaption.ok && withCaption.draft.tiers[0].caption, "Masterpiece");
    assert.equal(withoutCaption.ok && withoutCaption.draft.tiers[0].caption, null);
  });
});

/**
 * Somebody's own photograph arrives as the name of a file in their private
 * folder, not as an address: nobody but them can read that folder, so it
 * cannot go into the feed until the publish function has copied it.
 */
describe("own photographs", () => {
  const withPictures = (ids: (string | null)[], cover: string | null = null) =>
    decidePublish({
      body: body({
        coverPictureId: cover,
        items: ids.map((pictureId, index) => ({ title: `Card ${index}`, pictureId })),
      }),
      isAnonymous: false,
      listsAlreadyPublished: 0,
    });

  it("carries the picture's name through, waiting for an address", () => {
    const decision = withPictures(["abc"]);
    assert.equal(decision.ok && decision.draft.items[0].pictureId, "abc");
    assert.equal(decision.ok && decision.draft.items[0].imageUrl, null);
  });

  it("ignores a name that could climb out of its folder", () => {
    const decision = withPictures(["../../secrets"]);
    assert.equal(decision.ok && decision.draft.items[0].pictureId, null);
  });

  it("asks for each picture once, however many cards wear it", () => {
    const decision = withPictures(["abc", "abc", "def"], "abc");
    assert.deepEqual(decision.ok ? picturesWanted(decision.draft) : [], ["abc", "def"]);
  });

  it("refuses a list carrying more of them than one publication may", () => {
    const many = Array.from({ length: MAX_OWN_PICTURES_PER_LIST + 1 }, (_, i) => `p${i}`);
    const decision = withPictures(many);
    assert.equal(decision.ok, false);
    assert.equal(!decision.ok && decision.reason, "too_large");
  });

  it("counts the distinct pictures, not the cards", () => {
    const decision = withPictures(Array.from({ length: 400 }, () => "one"));
    assert.equal(decision.ok, true);
  });
});

describe("settle", () => {
  const draftOf = (ids: (string | null)[], cover: string | null = null) => {
    const decision = decidePublish({
      body: body({
        coverPictureId: cover,
        items: ids.map((pictureId, index) => ({ title: `Card ${index}`, pictureId })),
      }),
      isAnonymous: false,
      listsAlreadyPublished: 0,
    });
    assert.equal(decision.ok, true);
    return decision.ok ? decision.draft : null!;
  };

  it("gives each card the address its picture was copied to", () => {
    const list = settle(draftOf(["abc"]), new Map([["abc", "https://example.test/abc"]]));
    assert.equal(list.items[0].imageUrl, "https://example.test/abc");
  });

  it("gives the cover its address too", () => {
    const list = settle(draftOf(["abc"], "abc"), new Map([["abc", "https://example.test/abc"]]));
    assert.equal(list.coverImageUrl, "https://example.test/abc");
  });

  // A board of ninety photographs should not be lost to the one that would
  // not copy: the card keeps its title and loses its art.
  it("leaves a card without art rather than failing the list", () => {
    const list = settle(draftOf(["abc"]), new Map());
    assert.equal(list.items[0].imageUrl, null);
    assert.equal(list.items[0].title, "Card 0");
  });

  it("shows the copies in the feed's mosaic like any other art", () => {
    const list = settle(draftOf(["abc"]), new Map([["abc", "https://example.test/abc"]]));
    assert.deepEqual(list.previewImages, ["https://example.test/abc"]);
  });

  it("leaves a poster's own address alone", () => {
    const decision = decidePublish({ body: body(), isAnonymous: false, listsAlreadyPublished: 0 });
    assert.equal(decision.ok, true);
    const list = settle(decision.ok ? decision.draft : null!, new Map());
    assert.equal(list.items[0].imageUrl, "https://image.tmdb.org/t/p/w500/a.jpg");
  });
});
