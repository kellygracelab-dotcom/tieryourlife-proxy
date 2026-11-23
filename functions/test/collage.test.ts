import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { collageUrlOf, toSummary } from "../src/community";

const pictures = ["https://image.tmdb.org/t/p/w342/a.jpg", "https://image.tmdb.org/t/p/w342/b.jpg"];
const stored = {
  authorUid: "u", authorName: "A", authorPhotoUrl: null, title: "T", titleLower: "t", category: "games", tiers: [], items: [], itemCount: 0,
  coverImageUrl: null, previewImages: pictures, tierColors: [], updatedAt: Timestamp.fromMillis(1795500000123),
};

describe("a list's collage as one picture (23.11.2026)", () => {
  it("names the website's collage, versioned by the last save", () => {
    assert.equal(collageUrlOf("AbC123", null, pictures, 1795500000123), "https://tieryourlife.com/img/collage/AbC123.webp?v=1795500000123");
    assert.equal(toSummary("AbC123", stored as never).collageUrl, "https://tieryourlife.com/img/collage/AbC123.webp?v=1795500000123");
  });

  it("is left out for a card with a cover of its own or fewer than two pictures", () => {
    assert.equal("collageUrl" in toSummary("l", { ...stored, coverImageUrl: "https://image.tmdb.org/t/p/w780/c.jpg" } as never), false);
    assert.equal("collageUrl" in toSummary("l", { ...stored, previewImages: [pictures[0]] } as never), false);
    assert.equal("collageUrl" in toSummary("l", { ...stored, previewImages: [pictures[0], "null"] } as never), false);
  });

  it("still counts an old list's word \"null\" as no cover", () => {
    assert.ok(toSummary("l", { ...stored, coverImageUrl: "null" } as never).collageUrl);
  });
});
