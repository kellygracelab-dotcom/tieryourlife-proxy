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
  const who = (uid: string, email: string | null = null) => ({ uid, email });

  it("knows the one uid it was given", () => {
    assert.equal(isModerator(who("abc"), "abc", ""), true);
  });

  it("turns everyone else away", () => {
    assert.equal(isModerator(who("xyz"), "abc", ""), false);
  });

  it("makes nobody a moderator when it was never configured", () => {
    assert.equal(isModerator(who("abc"), "", ""), false);
    assert.equal(isModerator(who(""), "", ""), false);
  });

  // The second key. A lost account takes its uid with it; the address can be
  // signed in with again.
  it("knows the address as well as the uid", () => {
    assert.equal(isModerator(who("other", "me@example.com"), "abc", "me@example.com"), true);
  });

  it("compares addresses without caring about case or stray spaces", () => {
    assert.equal(isModerator(who("other", "me@example.com"), "", "  Me@Example.com  "), true);
  });

  // Identity only ever carries an address the provider verified, so a null
  // here is a caller who has none -- never one who merely claims one.
  it("turns away a caller with no verified address", () => {
    assert.equal(isModerator(who("other", null), "abc", "me@example.com"), false);
  });

  it("makes nobody a moderator when only an empty address is configured", () => {
    assert.equal(isModerator(who("other", "me@example.com"), "", ""), false);
  });
});
