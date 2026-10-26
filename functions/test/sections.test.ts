import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePages, type Ranked } from "../src/follows";
import {
  collageImage,
  countWithout,
  followedSectionRun,
  isSectionId,
  pickCollage,
  sectionFollowId,
  SECTION_IDS,
  TimedCache,
  withFollowing,
  type CollageCandidate,
  type SectionStats,
} from "../src/sections";

function list(some: Partial<CollageCandidate> & { id: string }): CollageCandidate {
  return {
    rankingCount: 9,
    underReview: false,
    coverImageUrl: `https://img.test/${some.id}.jpg`,
    previewImages: [],
    ...some,
  };
}

describe("isSectionId", () => {
  it("knows the nine, in the order the app draws them", () => {
    assert.deepEqual(SECTION_IDS, ["anime", "film_tv", "games", "music", "books", "food", "sport", "people", "other"]);
    assert.equal(isSectionId("food"), true);
  });

  it("refuses anything else", () => {
    assert.equal(isSectionId("Food"), false);
    assert.equal(isSectionId("cooking"), false);
    assert.equal(isSectionId(""), false);
    assert.equal(isSectionId(undefined), false);
    assert.equal(isSectionId(["food"]), false);
  });
});

describe("sectionFollowId", () => {
  it("is one document per person and section", () => {
    assert.equal(sectionFollowId("uid123", "food"), "uid123_food");
  });
});

describe("collageImage", () => {
  it("takes the list's own cover when it is on the web", () => {
    assert.equal(collageImage({ coverImageUrl: "https://a/c.jpg", previewImages: ["https://a/p.jpg"] }), "https://a/c.jpg");
  });

  it("falls back to the first card picture on the web", () => {
    assert.equal(
      collageImage({ coverImageUrl: "file:///phone/c.jpg", previewImages: ["content://x", "https://a/p.jpg"] }),
      "https://a/p.jpg",
    );
  });

  it("is nothing for a list without a picture", () => {
    assert.equal(collageImage({ coverImageUrl: null, previewImages: [] }), null);
  });
});

describe("pickCollage", () => {
  it("takes the first four that qualify, in the order given", () => {
    const candidates = ["a", "b", "c", "d", "e"].map((id) => list({ id }));
    assert.deepEqual(pickCollage(candidates, new Set()), [
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
      "https://img.test/d.jpg",
    ]);
  });

  it("skips lists with few rankings, under review or with an open report", () => {
    const candidates = [
      list({ id: "few", rankingCount: 4 }),
      list({ id: "hidden", underReview: true }),
      list({ id: "reported" }),
      ...["a", "b", "c", "d"].map((id) => list({ id })),
    ];
    assert.deepEqual(pickCollage(candidates, new Set(["reported"])), [
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
      "https://img.test/d.jpg",
    ]);
  });

  it("never repeats a picture", () => {
    const same = "https://img.test/poster.jpg";
    const candidates = [
      list({ id: "a", coverImageUrl: same }),
      list({ id: "b", coverImageUrl: same }),
      ...["c", "d", "e"].map((id) => list({ id })),
    ];
    assert.deepEqual(pickCollage(candidates, new Set()), [same, "https://img.test/c.jpg", "https://img.test/d.jpg", "https://img.test/e.jpg"]);
  });

  it("draws nothing when fewer than four qualify", () => {
    const candidates = ["a", "b", "c"].map((id) => list({ id }));
    assert.deepEqual(pickCollage(candidates, new Set()), []);
  });
});

describe("withFollowing", () => {
  it("marks the sections this reader follows and leaves the counts alone", () => {
    const stats: SectionStats[] = [
      { id: "food", listCount: 3, followerCount: 1, newThisWeek: 2, collage: [] },
      { id: "games", listCount: 5, followerCount: 0, newThisWeek: 0, collage: [] },
    ];
    assert.deepEqual(withFollowing(stats, new Set(["games"])), [
      { ...stats[0], following: false },
      { ...stats[1], following: true },
    ]);
  });
});

describe("countWithout", () => {
  it("never goes below nothing", () => {
    assert.equal(countWithout(10, 3), 7);
    assert.equal(countWithout(1, 2), 0);
  });
});

describe("followedSectionRun", () => {
  it("reads every followed section for the whole feed", () => {
    assert.deepEqual(followedSectionRun(["games", "food"], null), ["games", "food"]);
  });

  it("reads only the narrowed section, and only if it is followed", () => {
    assert.deepEqual(followedSectionRun(["games", "food"], "food"), ["food"]);
    assert.deepEqual(followedSectionRun(["games"], "food"), []);
  });
});

describe("a following page with sections", () => {
  const row = (id: string, updatedAt: number): Ranked => ({ id, updatedAt, takeCount: 0 });

  it("merges a section run with people and topics, once per list, newest first", () => {
    const people = [row("p1", 50), row("shared", 40)];
    const topics = [row("t1", 45)];
    const sections = [row("shared", 40), row("s1", 48), row("s2", 10)];
    assert.deepEqual(
      mergePages([people, topics, sections], "recent", 20).map((one) => one.id),
      ["p1", "s1", "t1", "shared", "s2"],
    );
  });
});

describe("TimedCache", () => {
  it("reads once while the value is fresh, and again once it is old", async () => {
    let now = 0;
    let reads = 0;
    const cache = new TimedCache<number>(1000, () => now);
    const load = async () => ++reads;

    assert.equal(await cache.get(load), 1);
    now = 999;
    assert.equal(await cache.get(load), 1);
    now = 1000;
    assert.equal(await cache.get(load), 2);
  });

  it("shares one read between callers asking at once", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new TimedCache<number>(1000, () => 0);
    const load = async () => {
      reads += 1;
      await gate;
      return 7;
    };

    const both = Promise.all([cache.get(load), cache.get(load)]);
    release();
    assert.deepEqual(await both, [7, 7]);
    assert.equal(reads, 1);
  });

  it("keeps nothing from a read that failed", async () => {
    let fail = true;
    const cache = new TimedCache<number>(1000, () => 0);
    const load = async () => {
      if (fail) throw new Error("offline");
      return 3;
    };

    await assert.rejects(cache.get(load));
    fail = false;
    assert.equal(await cache.get(load), 3);
  });
});
