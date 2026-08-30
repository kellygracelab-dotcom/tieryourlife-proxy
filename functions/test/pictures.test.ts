import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNCLAIMED_GRACE_MS, decideDiscard } from "../src/pictures";

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
