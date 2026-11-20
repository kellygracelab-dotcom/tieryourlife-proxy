import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNCLAIMED_GRACE_MS, UNCLAIMED_KEEP_MS, decideSweep, picturesOfBoard } from "../src/pictures";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function uploaded(id: string, agoMs: number, retiredAgoMs: number | null = null) {
  return { id, uploadedAtMs: NOW - agoMs, retiredAtMs: retiredAgoMs === null ? null : NOW - retiredAgoMs };
}

const nothing = { retire: [], unretire: [], remove: [] };

describe("decideSweep", () => {
  it("keeps a picture a board still points at", () => {
    assert.deepEqual(decideSweep([uploaded("a", 10 * UNCLAIMED_GRACE_MS)], new Set(["a"]), NOW, false), nothing);
  });

  // 20.11.2026: a board that lives only on a device names pictures the server cannot see.
  it("marks one nothing points at any more, and keeps it", () => {
    assert.deepEqual(decideSweep([uploaded("a", 2 * UNCLAIMED_GRACE_MS)], new Set(), NOW, false), { ...nothing, retire: ["a"] });
  });

  it("removes a marked one a month later, not a day sooner", () => {
    assert.equal(UNCLAIMED_KEEP_MS, 30 * DAY);
    const stored = [uploaded("old", 60 * DAY, 30 * DAY), uploaded("young", 60 * DAY, 29 * DAY)];
    assert.deepEqual(decideSweep(stored, new Set(), NOW, false), { ...nothing, remove: ["old"] });
  });

  it("drops the mark of one a board names again", () => {
    assert.deepEqual(decideSweep([uploaded("a", 60 * DAY, 40 * DAY)], new Set(["a"]), NOW, false), { ...nothing, unretire: ["a"] });
  });

  it("removes nothing of an account at the board limit, whose further boards live only on its devices", () => {
    const stored = [uploaded("old", 90 * DAY, 60 * DAY), uploaded("new", 2 * DAY)];
    assert.deepEqual(decideSweep(stored, new Set(), NOW, true), { ...nothing, retire: ["new"] });
  });

  // The race the grace exists for: the file lands seconds before the board that
  // names it, and a sweep in between would call it rubbish.
  it("leaves a picture that has only just arrived", () => {
    assert.deepEqual(decideSweep([uploaded("a", 60_000)], new Set(), NOW, false), nothing);
  });

  it("keeps one only the trash points at", () => {
    // A board in the trash can be restored for thirty days, and restoring it
    // to blank tiles is not restoring it.
    assert.deepEqual(decideSweep([uploaded("a", 5 * UNCLAIMED_GRACE_MS, 31 * DAY)], new Set(["a"]), NOW, false), { ...nothing, unretire: ["a"] });
  });

  it("sorts through a mixture without touching the wrong one", () => {
    const decision = decideSweep(
      [
        uploaded("kept", 5 * UNCLAIMED_GRACE_MS),
        uploaded("orphan", 5 * UNCLAIMED_GRACE_MS),
        uploaded("long-gone", 90 * DAY, 31 * DAY),
        uploaded("fresh", 1000),
      ],
      new Set(["kept"]),
      NOW,
      false,
    );
    assert.deepEqual(decision, { retire: ["orphan"], unretire: [], remove: ["long-gone"] });
  });
});

describe("picturesOfBoard", () => {
  const own = (uid: string, id: string) =>
    `https://firebasestorage.googleapis.com/v0/b/x/o/users%2F${uid}%2Fpictures%2F${id}?alt=media&token=t`;

  it("counts the cover photo and own pictures named by address, not only the cards'", () => {
    const ids = picturesOfBoard(
      {
        items: [{ pictureId: "card" }, { imageUrl: own("u1", "card-by-address") }, { imageUrl: "https://example.test/a.jpg" }],
        coverPictureId: "cover",
        coverImageUrl: own("u1", "cover-by-address"),
        coverImageUrls: [own("u1", "collage"), own("u2", "someone-else"), "https://example.test/b.jpg"],
      },
      "u1",
    );
    assert.deepEqual(ids.sort(), ["card", "card-by-address", "collage", "cover", "cover-by-address"]);
  });

  it("reads a board with nothing, or with a broken address, without throwing", () => {
    assert.deepEqual(picturesOfBoard({}, "u1"), []);
    assert.deepEqual(picturesOfBoard({ coverImageUrls: ["https://x/o/users%2Fu1%2Fpictures%2F%E0%A4%A"] }, "u1"), []);
  });
});
