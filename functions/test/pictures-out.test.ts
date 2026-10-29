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

  it("names the author of a list published with a name, and says it is not anonymous", () => {
    const summary = toSummary("a", { ...stored, authorPhotoUrl: "https://p/face.jpg", coverImageUrl: null, previewImages: [] } as never);

    assert.equal(summary.authorUid, "u");
    assert.equal(summary.authorName, "Someone");
    assert.equal(summary.authorPhotoUrl, "https://p/face.jpg");
    assert.equal(summary.anonymous, false);
  });

  it("names nobody for an anonymous list", () => {
    const summary = toSummary("a", {
      ...stored,
      authorPhotoUrl: "https://p/face.jpg",
      anonymous: true,
      coverImageUrl: null,
      previewImages: [],
    } as never);

    assert.equal(summary.authorUid, "");
    assert.equal(summary.authorName, "");
    assert.equal(summary.authorPhotoUrl, null);
    assert.equal(summary.anonymous, true);
  });

  it("credits an anonymous original by nobody", () => {
    const summary = toSummary("a", {
      ...stored,
      coverImageUrl: null,
      previewImages: [],
      basedOn: { id: "o", title: "Original", authorUid: "", authorName: "" },
    } as never);

    assert.deepEqual(summary.basedOn, { id: "o", title: "Original", authorUid: "", authorName: "" });
  });

  // The installed app's decoder cannot read a null in basedOn; whatever is stored, none goes out.
  it("never sends a null inside basedOn, whatever is stored", () => {
    for (const basedOn of [
      { id: "o", title: "Original", authorUid: "", authorName: null },
      { id: "o", title: "Original", authorName: "Someone" },
      { id: "o", authorUid: null, authorName: undefined },
      { id: "o", title: null },
    ]) {
      const summary = toSummary("a", { ...stored, coverImageUrl: null, previewImages: [], basedOn } as never);
      assert.ok(summary.basedOn !== null, JSON.stringify(basedOn));
      for (const [key, value] of Object.entries(summary.basedOn ?? {})) {
        assert.notEqual(value, null, `${key} in ${JSON.stringify(basedOn)}`);
        assert.notEqual(value, undefined, `${key} in ${JSON.stringify(basedOn)}`);
      }
    }
  });

  describe("mine", () => {
    const anonymous = { ...stored, anonymous: true, coverImageUrl: null, previewImages: [] } as never;

    it("tells the owner their own anonymous list is theirs, while still naming nobody", () => {
      const summary = toSummary("a", anonymous, { uid: "u", isAnonymous: false });
      assert.equal(summary.mine, true);
      assert.equal(summary.authorUid, "");
      assert.equal(summary.authorName, "");
    });

    it("carries no mine at all for anybody else", () => {
      assert.equal("mine" in toSummary("a", anonymous, { uid: "someone-else", isAnonymous: false }), false);
      assert.equal("mine" in toSummary("a", anonymous), false);
    });

    it("carries no mine for a guest, even one holding the author's uid", () => {
      assert.equal("mine" in toSummary("a", anonymous, { uid: "u", isAnonymous: true }), false);
    });

    it("marks the owner's list with their name on it too", () => {
      const named = { ...stored, coverImageUrl: null, previewImages: [] } as never;
      assert.equal(toSummary("a", named, { uid: "u", isAnonymous: false }).mine, true);
      assert.equal("mine" in toSummary("a", named, { uid: "other", isAnonymous: false }), false);
    });
  });
});
