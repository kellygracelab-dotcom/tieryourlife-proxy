import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isModerator, nextCursor } from "../src/community";

describe("nextCursor", () => {
  it("hands back the last id when the page came back full", () => {
    assert.equal(nextCursor(["a", "b", "c"], 3), "c");
  });

  it("stops on a short page, because there is nothing after it", () => {
    assert.equal(nextCursor(["a", "b"], 3), null);
  });

  it("stops on an empty page", () => {
    assert.equal(nextCursor([], 3), null);
  });
});

describe("isModerator", () => {
  it("knows the one uid it was given", () => {
    assert.equal(isModerator("abc", "abc"), true);
  });

  it("turns everyone else away", () => {
    assert.equal(isModerator("xyz", "abc"), false);
  });

  it("makes nobody a moderator when it was never configured", () => {
    assert.equal(isModerator("abc", ""), false);
    assert.equal(isModerator("", ""), false);
  });
});
