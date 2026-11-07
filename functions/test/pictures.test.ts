import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNCLAIMED_GRACE_MS, decideDiscard, picturesOfBoard } from "../src/pictures";

const NOW = 1_700_000_000_000;

function uploaded(id: string, agoMs: number) {
  return { id, uploadedAtMs: NOW - agoMs };
}

describe("decideDiscard", () => {
  it("keeps a picture a board still points at", () => {
    const doomed = decideDiscard([uploaded("a", 10 * UNCLAIMED_GRACE_MS)], new Set(["a"]), NOW);

    assert.deepEqual(doomed, []);
  });

  it("discards one nothing points at any more", () => {
    const doomed = decideDiscard([uploaded("a", 2 * UNCLAIMED_GRACE_MS)], new Set(), NOW);

    assert.deepEqual(doomed, ["a"]);
  });

  // The race this exists for: the file lands seconds before the board that
  // names it, and a sweep in between would call it rubbish.
  it("leaves a picture that has only just arrived", () => {
    const doomed = decideDiscard([uploaded("a", 60_000)], new Set(), NOW);

    assert.deepEqual(doomed, []);
  });

  it("keeps one only the trash points at", () => {
    // A board in the trash can be restored for thirty days, and restoring it
    // to blank tiles is not restoring it.
    const doomed = decideDiscard([uploaded("a", 5 * UNCLAIMED_GRACE_MS)], new Set(["a"]), NOW);

    assert.deepEqual(doomed, []);
  });

  it("sorts through a mixture without touching the wrong one", () => {
    const doomed = decideDiscard(
      [
        uploaded("kept", 5 * UNCLAIMED_GRACE_MS),
        uploaded("orphan", 5 * UNCLAIMED_GRACE_MS),
        uploaded("fresh", 1000),
      ],
      new Set(["kept"]),
      NOW,
    );

    assert.deepEqual(doomed, ["orphan"]);
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
