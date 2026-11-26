import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { awaitsApproval, FEED_APPROVAL_SWITCH, feedApprovalOn, forgetFeedApproval, inFeeds, noteCommunityReview, waitsOnPublish } from "../src/feedApproval";

let fakes: Fakes;

beforeEach(() => {
  fakes = install();
  forgetFeedApproval();
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

describe("approval before the feed (26.11.2026)", () => {
  it("is on with no switch written, and off only when the switch says so", async () => {
    assert.equal(await feedApprovalOn(1_000, false), true);
    forgetFeedApproval();
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: false });
    assert.equal(await feedApprovalOn(2_000, false), false);
    forgetFeedApproval();
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: true });
    assert.equal(await feedApprovalOn(3_000, false), true);
  });

  it("reads the switch at most every 30 s, and every time under the demo emulators", async () => {
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: false });
    assert.equal(await feedApprovalOn(0, false), false);
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: true });
    assert.equal(await feedApprovalOn(29_999, false), false, "still the switch read before");
    assert.equal(await feedApprovalOn(30_000, false), true);
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: false });
    assert.equal(await feedApprovalOn(30_001, true), false, "the emulators read it at once");
  });

  it("is off under the demo emulators with no switch written, so other suites see their lists", async () => {
    assert.equal(await feedApprovalOn(0, true), false);
    await fakes.db.doc(FEED_APPROVAL_SWITCH).set({ on: true });
    assert.equal(await feedApprovalOn(1, true), true);
  });

  it("makes only a new list of an ordinary account wait, while on", () => {
    assert.equal(waitsOnPublish(true, true, false), true);
    assert.equal(waitsOnPublish(true, true, true), false, "the owner and moderators publish at once");
    assert.equal(waitsOnPublish(true, false, false), false, "an Update, a house list or a ranking never waits");
    assert.equal(waitsOnPublish(false, true, false), false);
  });

  it("keeps a waiting list, as a hidden one, out of every feed; an old list without the mark is in", () => {
    assert.equal(inFeeds({}), true);
    assert.equal(inFeeds({ awaitingApproval: true }), false);
    assert.equal(inFeeds({ underReview: true }), false);
    assert.equal(inFeeds({ awaitingApproval: false, underReview: false }), true);
    assert.equal(awaitsApproval({ awaitingApproval: "yes" }), false);
  });

  it("writes one COMMUNITY_REVIEW line with the kind and the list, and nothing else", () => {
    const lines: unknown[][] = [];
    mock.method(console, "log", (...line: unknown[]) => void lines.push(line));
    noteCommunityReview("approval", "L1");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(String(lines[0]![0])), { severity: "NOTICE", message: "COMMUNITY_REVIEW", kind: "approval", listId: "L1" });
  });
});
