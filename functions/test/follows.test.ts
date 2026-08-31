import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunked,
  cursorOf,
  decideFollow,
  followId,
  MAX_FOLLOWING,
  mergePages,
  readCursor,
  sortOrder,
  type Follower,
  type Ranked,
} from "../src/follows";

const signedIn: Follower = { uid: "readerUid1234", isAnonymous: false, following: 0 };

describe("decideFollow", () => {
  it("lets a signed-in person follow somebody else", () => {
    assert.deepEqual(decideFollow(signedIn, "authorUid5678"), { ok: true });
  });

  // A guest is an identity we hand out and later sweep away. Letting one build
  // a following list would be promising to keep something we delete.
  it("turns away a guest", () => {
    assert.deepEqual(
      decideFollow({ ...signedIn, isAnonymous: true }, "authorUid5678"),
      { ok: false, reason: "not_signed_in" },
    );
  });

  it("refuses to follow yourself", () => {
    assert.deepEqual(decideFollow(signedIn, "readerUid1234"), { ok: false, reason: "yourself" });
  });

  it("refuses anything that is not a uid", () => {
    assert.deepEqual(decideFollow(signedIn, "no"), { ok: false, reason: "invalid" });
    assert.deepEqual(decideFollow(signedIn, "with spaces"), { ok: false, reason: "invalid" });
  });

  it("stops at the ceiling the feed can actually read", () => {
    assert.deepEqual(
      decideFollow({ ...signedIn, following: MAX_FOLLOWING }, "authorUid5678"),
      { ok: false, reason: "too_many" },
    );
  });
});

describe("followId", () => {
  // Following twice writes the same document, so it needs no read first and
  // cannot leave two rows saying the same thing.
  it("is the same both times somebody follows", () => {
    assert.equal(followId("readerUid1234", "authorUid5678"), followId("readerUid1234", "authorUid5678"));
  });

  it("says which way round it is", () => {
    assert.notEqual(followId("readerUid1234", "authorUid5678"), followId("authorUid5678", "readerUid1234"));
  });
});

describe("chunked", () => {
  it("splits into runs Firestore will answer", () => {
    const uids = Array.from({ length: 65 }, (_, at) => `uid${at}`);
    assert.deepEqual(chunked(uids).map((run) => run.length), [30, 30, 5]);
  });

  it("leaves nothing behind", () => {
    const uids = Array.from({ length: 65 }, (_, at) => `uid${at}`);
    assert.equal(chunked(uids).flat().length, 65);
  });

  it("has nothing to do with an empty following list", () => {
    assert.deepEqual(chunked([]), []);
  });
});

const list = (id: string, updatedAt: number, takeCount = 0): Ranked => ({ id, updatedAt, takeCount });

describe("mergePages", () => {
  // Without this the first thirty authors' lists would sit ahead of everyone
  // else's whatever their date, because that run was read first.
  it("interleaves the runs by date rather than by which query answered", () => {
    const merged = mergePages(
      [[list("a", 300), list("d", 100)], [list("b", 200), list("c", 150)]],
      "recent",
      10,
    );
    assert.deepEqual(merged.map((one) => one.id), ["a", "b", "c", "d"]);
  });

  it("orders by takes when that is what was asked for", () => {
    const merged = mergePages(
      [[list("a", 300, 1)], [list("b", 100, 9)]],
      "popular",
      10,
    );
    assert.deepEqual(merged.map((one) => one.id), ["b", "a"]);
  });

  // A page boundary that wobbles repeats a list or skips one.
  it("breaks ties on id so the same page comes back the same way twice", () => {
    const merged = mergePages([[list("b", 100), list("a", 100)]], "recent", 10);
    assert.deepEqual(merged.map((one) => one.id), ["a", "b"]);
  });

  it("hands back one page, not everything it read", () => {
    const merged = mergePages([[list("a", 3), list("b", 2), list("c", 1)]], "recent", 2);
    assert.deepEqual(merged.map((one) => one.id), ["a", "b"]);
  });

  // Somebody who follows two people who both published the same list would
  // otherwise see it twice in one page.
  it("shows a list once even when two runs carry it", () => {
    const merged = mergePages([[list("a", 100)], [list("a", 100)]], "recent", 10);
    assert.deepEqual(merged.map((one) => one.id), ["a"]);
  });
});

describe("cursorOf", () => {
  it("says there is no next page when the page came back short", () => {
    assert.equal(cursorOf([list("a", 100)], 10, "recent"), null);
  });

  it("carries the value the ordering actually used", () => {
    const page = [list("a", 300, 4), list("b", 200, 7)];
    assert.equal(cursorOf(page, 2, "recent"), "200:b");
    assert.equal(cursorOf(page, 2, "popular"), "7:b");
  });

  it("comes back out the way it went in", () => {
    assert.deepEqual(readCursor(cursorOf([list("a", 100)], 1, "recent")), { value: 100, id: "a" });
  });
});

describe("readCursor", () => {
  it("starts from the top rather than failing on something we did not write", () => {
    assert.equal(readCursor("nonsense"), null);
    assert.equal(readCursor(""), null);
    assert.equal(readCursor(undefined), null);
    assert.equal(readCursor(":a"), null);
    assert.equal(readCursor("100:"), null);
  });
});

describe("sortOrder", () => {
  it("reads the two it knows", () => {
    assert.equal(sortOrder("popular"), "popular");
    assert.equal(sortOrder("recent"), "recent");
  });

  it("treats anything else as newest first", () => {
    assert.equal(sortOrder("best"), "recent");
    assert.equal(sortOrder(undefined), "recent");
  });
});
