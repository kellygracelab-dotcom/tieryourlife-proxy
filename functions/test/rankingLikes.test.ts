import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorRanking,
  compareRankings,
  likeCursor,
  likeId,
  likeQuota,
  likeRefusal,
  LIKES_PER_HOUR,
  LIKE_WINDOW_MS,
  rankingFolderOf,
  rankingIdOf,
  rankingsPage,
  readLikeCount,
  readLikeCursor,
  readLikeEvents,
  type RankingKey,
} from "../src/rankingLikes";

const key = (id: string, likeCount: number, seconds: number, nanoseconds = 0): RankingKey => ({ id, likeCount, seconds, nanoseconds });

describe("where a like and a ranking's copies live", () => {
  it("names one like per account and ranking, and the ranking's own folder", () => {
    assert.equal(likeId("liker", rankingIdOf("L1", "u1")), "liker:L1_u1");
    assert.equal(rankingFolderOf(rankingIdOf("L1", "u1")), "ranking-L1_u1");
  });
});

describe("likeRefusal", () => {
  const caller = { uid: "me", isAnonymous: false, banned: false };
  const list = { authorUid: "author", underReview: false };
  const target = { uid: "someone", list, rankingExists: true };

  it("lets a signed-in reader like somebody's ranking of a list everybody sees", () => {
    assert.equal(likeRefusal(caller, target), null);
  });

  it("refuses the guest, then the banned, then a list gone or hidden, then one's own, then the author's, then a ranking not there", () => {
    assert.equal(likeRefusal({ ...caller, isAnonymous: true, banned: true }, target), "not_signed_in");
    assert.equal(likeRefusal({ ...caller, banned: true }, target), "banned");
    assert.equal(likeRefusal(caller, { ...target, list: null }), "missing");
    assert.equal(likeRefusal(caller, { ...target, list: { ...list, underReview: true } }), "missing");
    assert.equal(likeRefusal(caller, { ...target, uid: "me", rankingExists: false }), "own");
    assert.equal(likeRefusal(caller, { ...target, uid: "author", rankingExists: false }), "author");
    assert.equal(likeRefusal(caller, { ...target, rankingExists: false }), "missing");
  });
});

describe("likeQuota", () => {
  const now = 10 * LIKE_WINDOW_MS;

  it("adds this change to the hour's, forgetting older ones", () => {
    assert.deepEqual(likeQuota([now - LIKE_WINDOW_MS - 1, now - 5], now), { allowed: true, events: [now - 5, now] });
  });

  it("refuses the 301st change within the hour, until the oldest of the last 300 is an hour old", () => {
    const full = Array.from({ length: LIKES_PER_HOUR }, (_, at) => now - 1000 + at);
    assert.deepEqual(likeQuota(full, now), { allowed: false, retryAt: now - 1000 + LIKE_WINDOW_MS });
    assert.equal(likeQuota(full.slice(1), now).allowed, true);
  });

  it("reads back only numbers", () => {
    assert.deepEqual(readLikeEvents([1, "2", null, 3]), [1, 3]);
    assert.deepEqual(readLikeEvents("x"), []);
  });
});

describe("the order of a list's rankings", () => {
  it("puts the most liked first, the newest first among equals, the reader's own in its place", () => {
    const rankings = [key("old-liked", 3, 100), key("mine", 0, 500), key("new", 0, 600), key("liked", 5, 50), key("old", 0, 10)];
    assert.deepEqual(rankingsPage(rankings, null, 30).page.map((one) => one.id), ["liked", "old-liked", "new", "mine", "old"]);
  });

  it("breaks a tie of likes and time by nanoseconds, then by id, so it never wavers", () => {
    assert.ok(compareRankings(key("a", 1, 5, 2), key("b", 1, 5, 1)) < 0);
    assert.ok(compareRankings(key("a", 1, 5), key("b", 1, 5)) < 0);
  });

  it("reads a missing or broken count as none", () => {
    assert.deepEqual([readLikeCount(undefined), readLikeCount(-2), readLikeCount(1.5), readLikeCount(4)], [0, 0, 0, 4]);
  });
});

describe("pages of rankings", () => {
  const rankings = Array.from({ length: 5 }, (_, at) => key(`r${at}`, 5 - at, 100));

  it("carries on after the last ranking shown, and says when there is no more", () => {
    const first = rankingsPage(rankings, null, 2);
    assert.deepEqual(first.page.map((one) => one.id), ["r0", "r1"]);
    const second = rankingsPage(rankings, readLikeCursor(likeCursor(first.next!)), 2);
    assert.deepEqual(second.page.map((one) => one.id), ["r2", "r3"]);
    const last = rankingsPage(rankings, second.next, 2);
    assert.deepEqual(last.page.map((one) => one.id), ["r4"]);
    assert.equal(last.next, null);
  });

  it("keeps its place when the ranking the cursor names was withdrawn meanwhile", () => {
    const first = rankingsPage(rankings, null, 2);
    const withdrawn = rankings.filter((one) => one.id !== "r1");
    assert.deepEqual(rankingsPage(withdrawn, first.next, 2).page.map((one) => one.id), ["r2", "r3"]);
  });

  it("is empty past the end", () => {
    assert.deepEqual(rankingsPage(rankings, key("zz", 0, 0), 2), { page: [], next: null });
  });
});

describe("the rankings cursor", () => {
  it("reads back what it wrote, and nothing else", () => {
    const last = key("L1_u1", 3, 1_790_000_000, 123_456_000);
    const cursor = likeCursor(last);
    assert.match(cursor, /^r2\./);
    assert.deepEqual(readLikeCursor(cursor), last);
  });

  it("reads a cursor of the old kind, an id or a time, as gone", () => {
    for (const old of ["L1_u1", "~1790000000.123456000", "r2.", "r2.bm90IGpzb24", `r2.${Buffer.from("[1,2,3]").toString("base64url")}`, `r2.${Buffer.from('[-1,2,3,"x"]').toString("base64url")}`]) {
      assert.equal(readLikeCursor(old), null, old);
    }
  });
});

describe("the author's placing at the head of the sheet", () => {
  const list = {
    authorUid: "author",
    authorName: "Ann",
    authorPhotoUrl: "https://example.test/ann.png",
    tiers: [{ label: "S" }, { label: "A" }],
    items: [{ tierIndex: 1 }, { tierIndex: null }, { tierIndex: 0 }, { tierIndex: 1 }, { tierIndex: 7 }],
  };

  it("is the list as its author placed it, the cards of each tier in the list's order", () => {
    assert.deepEqual(authorRanking(list, 1234, { uid: "reader", isAnonymous: false }), {
      uid: "author",
      authorName: "Ann",
      authorPhotoUrl: "https://example.test/ann.png",
      arrangement: [1, null, 0, 1, null],
      rows: [[2], [0, 3]],
      tierLabels: ["S", "A"],
      updatedAtMs: 1234,
      mine: false,
      isAuthor: true,
      likedByMe: false,
    });
  });

  it("is the reader's own when the author reads it, and nobody's by name on an anonymous list", () => {
    assert.equal(authorRanking(list, 0, { uid: "author", isAnonymous: false }).mine, true);
    const anonymous = authorRanking({ ...list, anonymous: true }, 0, { uid: "author", isAnonymous: false });
    assert.deepEqual([anonymous.uid, anonymous.authorName, anonymous.authorPhotoUrl, anonymous.mine], ["", "", null, true]);
  });
});
