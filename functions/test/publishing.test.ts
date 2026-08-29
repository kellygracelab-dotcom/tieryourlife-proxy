import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_AUTHOR,
  MAX_PREVIEW_IMAGES,
  MAX_TITLE_LENGTH,
  decidePublish,
} from "../src/publishing";

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
    assert.equal(decision.ok && decision.list.items[0].imageUrl, "https://image.tmdb.org/t/p/w500/a.jpg");
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
    assert.equal(decision.ok && decision.list.items[0].imageUrl, null);
    assert.equal(decision.ok && decision.list.items[0].title, "Sunday roast");
  });

  it("drops a plain http image, keeping only https", () => {
    const decision = publish({ items: [{ title: "A", imageUrl: "http://example.com/a.jpg" }] });

    assert.equal(decision.ok && decision.list.items[0].imageUrl, null);
  });

  it("collapses whitespace and trims an over-long title", () => {
    const decision = publish({ title: "  Every   A24\n\tfilm  " + "x".repeat(MAX_TITLE_LENGTH) });

    assert.equal(decision.ok, true);
    const title = decision.ok ? decision.list.title : "";
    assert.equal(title.startsWith("Every A24 film"), true);
    assert.equal(title.length, MAX_TITLE_LENGTH);
  });

  // The feed searches by prefix on this, so it has to be there and lower-cased.
  it("carries a lower-cased title for searching", () => {
    const decision = publish({ title: "Every A24 Film" });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.list.titleLower, "every a24 film");
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

    assert.equal(remote.ok && remote.list.coverImageUrl, "https://image.tmdb.org/t/p/w500/cover.jpg");
    assert.equal(local.ok && local.list.coverImageUrl, null);
  });

  // The feed draws a mosaic from these, so it must not have to open the list.
  it("collects card art for the feed, capped and free of local images", () => {
    const items = Array.from({ length: MAX_PREVIEW_IMAGES + 3 }, (_, i) => ({
      title: `item ${i}`,
      imageUrl: i === 0 ? "file:///data/photo.jpg" : `https://example.com/${i}.jpg`,
    }));

    const decision = publish({ items });

    assert.equal(decision.ok, true);
    const previews = decision.ok ? decision.list.previewImages : [];
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

    assert.equal(withCaption.ok && withCaption.list.tiers[0].caption, "Masterpiece");
    assert.equal(withoutCaption.ok && withoutCaption.list.tiers[0].caption, null);
  });
});
