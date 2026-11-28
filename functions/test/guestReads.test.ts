import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mineFor, viewerFollowsFor } from "../src/anonymous";
import { segmentsOf, toSummary } from "../src/community";
import { GUEST_READER_UID, guestReadable, guestReader, sendsNoToken } from "../src/guestReads";

const LIST = "AbCdEfGhIjKlMnOpQrSt";
const read = (path: string, query: Record<string, unknown> = {}, method = "GET") => guestReadable(method, segmentsOf(path), query);

describe("public reads with App Check alone (28.11.2026)", () => {
  it("lets the feed, a list, the sections and the topics through", () => {
    // The function's own path ("/", "/{id}") and the Hosting-style one with its name first ("/lists/{id}").
    for (const path of ["/", "/lists", `/${LIST}`, `/lists/${LIST}`, "/sections", "/lists/sections", "/lists/sections/street-food", "/topics", "/lists/topics", `/lists/topics/${LIST}`, "/lists/topics/t_1-x"]) {
      assert.equal(read(path), true, path);
    }
    for (const query of [{ sort: "popular" }, { fresh: "1" }, { author: "u1" }, { topic: "t1", category: "games" }, { q: "cats", after: LIST }, { following: "0" }]) {
      assert.equal(read("/lists", query), true, JSON.stringify(query));
    }
    assert.equal(read("/lists/topics", { q: "an", section: "games", limit: "5", cursor: "x" }), true);
  });

  it("keeps everything personal, staff's and every write behind the token", () => {
    for (const path of [
      "/lists/mine", "/lists/following", "/lists/reports", "/lists/follow", "/lists/follow/u1", "/lists/face", "/lists/pictures",
      "/lists/pictures/link", "/lists/editorial", "/lists/search-misses", "/lists/admin/stats", "/lists/stats", "/lists/moderators",
      "/lists/bans", "/lists/sections/queue", "/lists/sections/proposals", "/lists/sections/order", "/lists/sections/name-check",
      "/lists/sections/a/follow", "/lists/topics/mine", "/lists/topics/pending", `/lists/topics/${LIST}/follow`,
      `/lists/${LIST}/rankings`, `/lists/${LIST}/taken`, "/lists/short-id", "/lists/AbCdEfGhIjKlMnOpQrS_",
    ]) {
      assert.equal(read(path), false, path);
    }
    assert.equal(read("/lists", { following: "1" }), false, "the feed of whom one follows");
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      assert.equal(read(`/lists/${LIST}`, {}, method), false, method);
      assert.equal(read("/lists", {}, method), false, method);
    }
  });

  it("takes only a request with no Authorization header at all", () => {
    assert.equal(sendsNoToken(undefined), true);
    assert.equal(sendsNoToken(""), false);
    assert.equal(sendsNoToken("Bearer "), false);
    assert.equal(sendsNoToken("Bearer bad"), false);
  });

  it("reads as a guest who owns and follows nothing", () => {
    const reader = guestReader();
    assert.equal(reader.isAnonymous, true);
    assert.equal(reader.uid, GUEST_READER_UID);
    assert.match(reader.uid, /~/, "no Firebase uid has a ~, so no stored uid can equal it");
    assert.deepEqual(reader.banKeys, []);
    assert.equal(reader.email, null);
    assert.deepEqual(mineFor({ authorUid: GUEST_READER_UID }, reader), {});
    assert.deepEqual(viewerFollowsFor({ authorUid: "u1" }, reader, new Set(["u1"])), {});
    const summary = toSummary(LIST, { title: "T", authorUid: GUEST_READER_UID, authorName: "A", itemCount: 0 } as never, reader, new Set([GUEST_READER_UID]));
    assert.equal("mine" in summary, false);
    assert.equal("viewerFollowsAuthor" in summary, false);
  });
});
