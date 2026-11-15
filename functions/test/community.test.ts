import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorRoleOf, feedEqualities, isModerator, lists, movesLists, nextCursor, segmentsOf } from "../src/community";

describe("segmentsOf", () => {
  it("drops the function's own name, which Hosting puts first and a direct call does not", () => {
    assert.deepEqual(segmentsOf("/lists/mine"), ["mine"]);
    assert.deepEqual(segmentsOf("/mine"), ["mine"]);
    assert.deepEqual(segmentsOf("/lists"), []);
    assert.deepEqual(segmentsOf("/"), []);
  });

  it("keeps a later \"lists\", the admin's listing of a section", () => {
    assert.deepEqual(segmentsOf("/lists/admin/lists"), ["admin", "lists"]);
    assert.deepEqual(segmentsOf("/admin/lists/"), ["admin", "lists"]);
  });
});

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

describe("authorRoleOf", () => {
  const who = (uid: string, email: string | null = null) => ({ uid, email });

  it("knows the owner by uid or by verified address, appointed or not", () => {
    assert.equal(authorRoleOf(who("abc"), false, "abc", ""), "owner");
    assert.equal(authorRoleOf(who("other", "me@example.com"), true, "abc", "me@example.com"), "owner");
  });

  it("knows an appointed moderator", () => {
    assert.equal(authorRoleOf(who("mod"), true, "abc", "me@example.com"), "moderator");
  });

  it("finds no role in anybody else", () => {
    assert.equal(authorRoleOf(who("reader", "reader@example.com"), false, "abc", "me@example.com"), null);
    assert.equal(authorRoleOf(who("reader"), false, "", ""), null);
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

describe("the lists function", () => {
  it("has the memory for pictures from other sites in flight beside a board", () => {
    assert.equal((lists as unknown as { __endpoint: { availableMemoryMb: number } }).__endpoint.availableMemoryMb, 512);
  });
});

describe("feedEqualities", () => {
  it("leaves the section out when a topic is asked: the website sends both, the app the topic alone, and both see the same lists", () => {
    assert.deepEqual(feedEqualities({ category: "anime", author: null, topic: "T1" }), [["topicId", "T1"]]);
    assert.deepEqual(feedEqualities({ category: null, author: null, topic: "T1" }), [["topicId", "T1"]]);
  });

  it("filters by the section, the author, or both, as before", () => {
    assert.deepEqual(feedEqualities({ category: "anime", author: null, topic: null }), [["category", "anime"]]);
    assert.deepEqual(feedEqualities({ category: "anime", author: "u1", topic: null }), [["category", "anime"], ["authorUid", "u1"]]);
    assert.deepEqual(feedEqualities({ category: null, author: null, topic: null }), []);
  });
});

describe("movesLists", () => {
  it("is every call that can add, change or remove a list in a section's counts, and no read or personal call", () => {
    const moves = (method: string, path: string, verb: string | null = null, aboutAPerson = false) => movesLists(method, segmentsOf(path), verb, aboutAPerson);
    assert.equal(moves("POST", "/lists"), true);
    assert.equal(moves("PUT", "/lists/abcdefghij0123456789"), true);
    assert.equal(moves("DELETE", "/lists/abcdefghij0123456789"), true);
    for (const verb of ["report", "takedown", "dismiss", "move"]) assert.equal(moves("POST", `/lists/abcdefghij0123456789/${verb}`, verb), true, verb);
    assert.equal(moves("PUT", "/lists/editorial/abcdefghij0123456789"), true);
    assert.equal(moves("POST", "/lists/topics/abc/merge"), true);
    assert.equal(moves("POST", "/lists/sections/cars/follow"), true);
    assert.equal(moves("POST", "/lists/admin/lists/move"), true);

    assert.equal(moves("GET", "/lists"), false);
    assert.equal(moves("GET", "/lists/sections"), false);
    assert.equal(moves("HEAD", "/lists/editorial"), false);
    assert.equal(moves("OPTIONS", "/lists"), false);
    assert.equal(moves("POST", "/lists/pictures/keep"), false);
    assert.equal(moves("POST", "/lists/search-misses"), false);
    assert.equal(moves("PUT", "/lists/moderators/u1"), false);
    assert.equal(moves("PUT", "/lists/bans/u1"), false);
    assert.equal(moves("POST", "/lists/classify"), false);
    assert.equal(moves("PUT", "/lists/abcdefghij0123456789/rankings/mine"), false);
    assert.equal(moves("PUT", "/lists/abcdefghij0123456789/rankings/u1/like"), false);
    assert.equal(moves("POST", "/lists/abcdefghij0123456789/taken", "taken"), false);
    assert.equal(moves("POST", "/lists/follow/u1", null, true), false);
    assert.equal(moves("PUT", "/lists/face", null, true), false);
  });
});
