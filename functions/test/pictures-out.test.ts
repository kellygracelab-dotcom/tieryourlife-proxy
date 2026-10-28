import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toSummary, webPicture } from "../src/community";

describe("webPicture", () => {
  it("keeps a web address", () => {
    assert.equal(webPicture("https://image.tmdb.org/t/p/w500/a.jpg"), "https://image.tmdb.org/t/p/w500/a.jpg");
  });

  it("drops the word null that old lists stored as a cover", () => {
    assert.equal(webPicture("null"), null);
  });

  it("drops anything that is not a web address", () => {
    assert.equal(webPicture(""), null);
    assert.equal(webPicture("file:///pictures/1"), null);
    assert.equal(webPicture(null), null);
    assert.equal(webPicture(undefined), null);
  });
});

describe("toSummary", () => {
  const stored = {
    title: "Oscar films 2025",
    titleLower: "oscar films 2025",
    authorUid: "u",
    authorName: "Someone",
    category: "film_tv",
    itemCount: 3,
    tiers: [],
    items: [],
    tierColors: [],
  };

  it("sends no cover for one stored as the word null, so the app draws the mosaic", () => {
    const summary = toSummary("a", { ...stored, coverImageUrl: "null", previewImages: ["https://p/1.jpg", "null"] } as never);

    assert.equal(summary.coverImageUrl, null);
    assert.deepEqual(summary.previewImages, ["https://p/1.jpg"]);
  });

  it("sends a web cover as it is", () => {
    const summary = toSummary("a", { ...stored, coverImageUrl: "https://i/c.jpg", previewImages: [] } as never);

    assert.equal(summary.coverImageUrl, "https://i/c.jpg");
  });
});
