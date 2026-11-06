/**
 * The e2e mode end to end: `npm run test:e2e`. A guest signs up on the Auth
 * emulator and becomes an account, publishes twice from one board, keeps a
 * board, and reaches every proxied function with no App Check token and no
 * keys, by both the direct and the Hosting-style path.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { STUB_PICTURE } from "../src/emulator";
import { PROJECT, assertEmulatorsOnly, call, identity, ownerToken, seed } from "./seed-e2e";

const TIER = { label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" };

describe("the proxy under the demo emulators", () => {
  let guest = "";
  let token = "";

  before(async () => {
    assertEmulatorsOnly();
    guest = (await identity("signUp", {})).idToken;
    const suffix = Date.now().toString(36);
    token = (await identity("update", { idToken: guest, email: `e2e-${suffix}@e2e.test`, password: "e2e-password" })).idToken;
  });

  it("answers a guest without App Check, and refuses it a publication", async () => {
    assert.deepEqual((await call(guest, "GET", "/boards")).body, { boards: [], next: null });
    const refused = await call(guest, "POST", "/lists", { title: "x" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "NOT_SIGNED_IN");
  });

  it("publishes a board once, and answers its second publication with the first list", async () => {
    const kept = await call(token, "POST", "/lists/pictures/keep", { url: "https://example.invalid/a.png" });
    assert.equal(kept.status, 200);
    const board = `board-${Date.now().toString(36)}`;
    const body = {
      title: "End to end smoke list",
      category: "film_tv",
      tiers: [TIER],
      items: [{ title: "First card", tierIndex: 0 }, { title: "", pictureId: kept.body.pictureId, tierIndex: 0 }],
      boardUid: board,
    };
    const first = await call(token, "POST", "/lists", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call(token, "POST", "/lists/lists", body);
    assert.deepEqual(again, { status: 200, body: { id: first.body.id, topicId: null, existing: true } });

    const list = await call(token, "GET", `/lists/${first.body.id}`);
    assert.equal(list.status, 200);
    assert.match(String((list.body.items as { imageUrl: string }[])[1].imageUrl), /published%2F/);
    const mine = await call(token, "GET", "/lists/lists/mine");
    assert.equal((mine.body.lists as { boardUid?: string }[])[0].boardUid, board);
  });

  it("keeps a board and hands it back", async () => {
    const id = `b${Date.now().toString(36)}`;
    const board = {
      title: "Kept board",
      displayMode: "FLAT_RANKED",
      fingerprint: "fp-1",
      tiers: [{ uid: "t1", position: 0, ...TIER }],
      items: [{ uid: "i1", tierUid: "t1", position: 0, title: "Card" }],
    };
    assert.deepEqual(await call(token, "PUT", `/boards/${id}`, board), { status: 200, body: { uid: id, revision: 1 } });
    assert.deepEqual(await call(token, "PUT", `/boards/boards/${id}`, board), { status: 200, body: { uid: id, revision: 1 } });
    const stored = await call(token, "GET", `/boards/boards/${id}`);
    assert.equal(stored.body.displayMode, "FLAT_RANKED");
    assert.equal(stored.body.revision, 1);
    const index = await call(token, "GET", "/boards");
    assert.ok((index.body.boards as { uid: string }[]).some((one) => one.uid === id));
  });

  it("removes a file in someone's own folder that is not a picture, and leaves one that is", async () => {
    const bucket = getStorage(initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` }, "smoke-upload")).bucket();
    const { localId } = await identity("signUp", {});
    const fake = bucket.file(`users/${localId}/pictures/fake`);
    const real = bucket.file(`users/${localId}/pictures/real`);
    await fake.save(Buffer.from("%PDF-1.7 not a picture"), { contentType: "image/jpeg", resumable: false });
    await real.save(STUB_PICTURE, { contentType: "image/png", resumable: false });

    let gone = false;
    for (let tries = 0; tries < 40 && !gone; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      gone = !(await fake.exists())[0];
    }
    assert.ok(gone, "the fake picture is still there");
    assert.ok((await real.exists())[0]);
  });

  it("bans the author of an anonymous list taken down with a ban", async () => {
    const published = await call(token, "POST", "/lists", {
      title: "Anonymous smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }], anonymous: true,
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const reporter = (await identity("signUp", {})).idToken;
    assert.equal((await call(reporter, "POST", `/lists/${published.body.id}/report`, { reason: "spam" })).status, 204);

    const owner = await ownerToken();
    const queue = await call(owner, "GET", "/lists/reports");
    const row = (queue.body.reports as { listId: string; anonymous: boolean; authorUid: string | null }[]).find((one) => one.listId === published.body.id);
    assert.equal(row?.anonymous, true);
    assert.ok(row?.authorUid);

    assert.equal((await call(owner, "POST", `/lists/${published.body.id}/takedown`, { ban: "week" })).status, 204);
    const ban = await getFirestore(initializeApp({ projectId: PROJECT }, "smoke-ban")).collection("bans").doc(row.authorUid).get();
    assert.ok(ban.exists, "the anonymous author was not banned");
  });

  it("answers every catalogue empty, with no keys", async () => {
    for (const path of ["/tmdb/3/search/multi?query=alien", "/tmdb/tmdb/3/search/multi?query=alien"]) {
      assert.deepEqual(await call(token, "GET", path), { status: 200, body: { page: 1, results: [], total_pages: 0, total_results: 0 } });
    }
    assert.deepEqual((await call(token, "GET", "/lists/pictures?q=alien&part=quick")).body, { items: [], hasMore: false, notices: [], rest: false });
    assert.deepEqual((await call(token, "GET", "/lists/lists/pictures?q=alien")).body, { items: [], hasMore: false, notices: [] });
  });

  it("carries a guest's credits and reads them", async () => {
    const carried = await call(token, "POST", "/adoptGuestCredits", { guestToken: (await identity("signUp", {})).idToken });
    assert.equal(carried.status, 200);
    assert.equal((await call(token, "GET", "/credits")).status, 200);
  });

  it("seeds the owner and a topic, twice over", async () => {
    const first = await seed();
    const second = await seed();
    assert.deepEqual(second, first);
    assert.ok(first.sections.includes("other"));
  });
});
