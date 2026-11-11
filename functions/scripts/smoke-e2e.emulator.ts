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
import { decideStore, MAX_BOARD_BYTES, MAX_PLAY_HISTORY } from "../src/sync";
import { PROJECT, assertEmulatorsOnly, call, identity, ownerToken, seed } from "./seed-e2e";

const TIER = { label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" };

/** An account of its own: the smoke's main one is banned along the way. */
async function newAuthor(prefix: string): Promise<string> {
  const guest = (await identity("signUp", {})).idToken;
  return (await identity("update", { idToken: guest, email: `${prefix}-${Date.now().toString(36)}@e2e.test`, password: "e2e-password" })).idToken;
}

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

    assert.equal((await call(owner, "DELETE", `/lists/bans/${row.authorUid}`)).status, 204);
    assert.equal((await ban.ref.get()).exists, false, "the owner could not lift the ban");
  });

  it("keeps a hidden list hidden when its author publishes it again", async () => {
    // Its own author: the one above was banned with its anonymous list.
    const guest = (await identity("signUp", {})).idToken;
    const author = (await identity("update", { idToken: guest, email: `hold-${Date.now().toString(36)}@e2e.test`, password: "e2e-password" })).idToken;
    const body = { title: "Hidden smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }] };
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-hold")).collection("publishedLists");
    await lists.doc(id).set({ underReview: true }, { merge: true });

    const again = await call(author, "POST", `/lists/${id}`, { ...body, title: "Hidden smoke list, again" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await lists.doc(id).get()).get("underReview"), true);
  });

  it("leaves a list its author removed removed when staff dismiss its reports", async () => {
    const published = await call(token, "POST", "/lists", {
      title: "Removed smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }],
    });
    const reporter = (await identity("signUp", {})).idToken;
    assert.equal((await call(reporter, "POST", `/lists/${published.body.id}/report`, { reason: "spam" })).status, 204);
    assert.equal((await call(token, "DELETE", `/lists/${published.body.id}`)).status, 204);

    assert.equal((await call(await ownerToken(), "POST", `/lists/${published.body.id}/dismiss`, {})).status, 204);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-husk")).collection("publishedLists");
    assert.equal((await lists.doc(String(published.body.id)).get()).exists, false);
  });

  it("keeps a hidden list hidden when its author withdraws it and publishes it again from another board", async () => {
    const guest = (await identity("signUp", {})).idToken;
    const author = (await identity("update", { idToken: guest, email: `again-${Date.now().toString(36)}@e2e.test`, password: "e2e-password" })).idToken;
    const body = { title: "Withdrawn smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }], boardUid: `held-${Date.now().toString(36)}` };
    const visible = await call(author, "POST", "/lists", { ...body, title: "Visible smoke list", boardUid: `visible-${Date.now().toString(36)}` });
    const first = await call(author, "POST", "/lists", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-again")).collection("publishedLists");
    await lists.doc(String(first.body.id)).set({ underReview: true }, { merge: true });
    assert.equal((await call(author, "DELETE", `/lists/${first.body.id}`)).status, 204);
    const marker = await getFirestore(initializeApp({ projectId: PROJECT }, "smoke-marker")).collection("auditLog")
      .where("target", "==", `publishedLists/${first.body.id}`).where("what", "==", "list.withdrawn_hidden").get();
    assert.equal(marker.size, 1);
    assert.deepEqual(
      (({ role, before, after }) => ({ role, before, after }))(marker.docs[0].data()),
      { role: "author", before: { underReview: true }, after: null },
    );

    const again = await call(author, "POST", "/lists", { ...body, boardUid: `copy-${Date.now().toString(36)}` });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await lists.doc(String(again.body.id)).get()).get("underReview"), true);
    const owner = await ownerToken();
    const queue = await call(owner, "GET", "/lists/reports");
    assert.ok((queue.body.reports as { listId: string }[]).some((one) => one.listId === again.body.id));

    // A decoy does not spend the hold: the next one is held too, until staff decide.
    const third = await call(author, "POST", "/lists", { ...body, boardUid: `third-${Date.now().toString(36)}` });
    assert.equal((await lists.doc(String(third.body.id)).get()).get("underReview"), true);
    assert.equal((await call(author, "POST", `/lists/${visible.body.id}`, body)).status, 200);
    assert.equal((await lists.doc(String(visible.body.id)).get()).get("underReview"), true);
    assert.equal((await call(owner, "POST", `/lists/${first.body.id}/dismiss`, {})).status, 204);
    const fourth = await call(author, "POST", "/lists", { ...body, boardUid: `fourth-${Date.now().toString(36)}` });
    assert.equal((await lists.doc(String(fourth.body.id)).get()).get("underReview"), false);
  });

  it("takes nineteen ranked tiers on a new list, and lets a list of twenty keep its twenty", async () => {
    const author = await newAuthor("tiers");
    const tiers = (count: number) => Array.from({ length: count }, (_unused, index) => ({ ...TIER, label: `T${index}` }));
    const body = { title: "Tiers smoke list", category: "film_tv", tiers: tiers(19), items: [{ title: "Card", tierIndex: 0 }] };
    const refused = await call(author, "POST", "/lists", { ...body, tiers: tiers(20) });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "TOO_MANY_TIERS");
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);

    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(20) })).body.code, "TOO_MANY_TIERS");
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-tiers")).collection("publishedLists");
    await lists.doc(id).set({ tiers: tiers(20) }, { merge: true });
    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(20) })).status, 200);
    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(21) })).body.code, "TOO_MANY_TIERS");
  });

  it("keeps a list where staff moved it when its author republishes the same board, until the author says otherwise", async () => {
    const { topic } = await seed();
    const author = await newAuthor("moved");
    const body = { title: "Moved smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }] };
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);
    assert.equal((await call(await ownerToken(), "POST", `/lists/${id}/move`, { topicId: topic.id })).status, 204);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-move")).collection("publishedLists");
    assert.deepEqual((await lists.doc(id).get()).get("movedByStaff"), {
      category: { from: "film_tv", to: topic.section },
      topicId: { from: null, to: topic.id },
    });

    assert.deepEqual(await call(author, "POST", `/lists/${id}`, body), { status: 200, body: { id, topicId: topic.id, underReview: false } });
    const kept = await lists.doc(id).get();
    assert.equal(kept.get("category"), topic.section);
    assert.equal(kept.get("topicId"), topic.id);

    assert.deepEqual(await call(author, "POST", `/lists/${id}`, { ...body, category: "games" }), { status: 200, body: { id, topicId: null, underReview: false } });
    const chosen = await lists.doc(id).get();
    assert.equal(chosen.get("category"), "games");
    assert.equal(chosen.get("topicId"), null);
    assert.equal(chosen.get("movedByStaff"), undefined);
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

  it("keeps a near-limit board and long game atomically, including legacy edit, explicit clear and account erasure", async () => {
    const author = await newAuthor("large-play");
    const uid = JSON.parse(Buffer.from(author.split(".")[1], "base64url").toString()).user_id as string;
    const db = getFirestore(initializeApp({ projectId: PROJECT }, "large-play-smoke"));
    const ref = db.collection("accounts").doc(uid).collection("boards").doc("large-play");
    const gameRef = db.collection("accounts").doc(uid).collection("plays").doc("large-play");
    const items = Array.from({ length: 2000 }, (_, i) => ({ uid: `card-${i}`, tierUid: "tier-1", position: i, title: "Card", imageUrl: "" }));
    const base = { title: "Large board", fingerprint: "large-1", tiers: [{ ...TIER, uid: "tier-1", position: 0 }], items };
    let bytes = 0;
    for (const item of items) {
      const decision = decideStore({ body: base, isAnonymous: false, boardsAlreadyKept: 0, nowMs: Date.now() });
      assert.ok(decision.ok);
      bytes = Buffer.byteLength(JSON.stringify(decision.board), "utf8");
      if (bytes > MAX_BOARD_BYTES - 3000) break;
      item.imageUrl = `https://img.test/${"x".repeat(1800)}`;
    }
    assert.ok(bytes > MAX_BOARD_BYTES - 3000 && bytes < MAX_BOARD_BYTES);
    const play = { kind: "swiss", count: 2000, seed: 42, refine: true, ids: items.map((x) => x.uid),
      history: Array.from({ length: MAX_PLAY_HISTORY }, (_, i) => [i % 2000, (i + 1) % 2000, i % 3 === 0 ? null : i % 2000]),
      round: 12, startedAt: Date.now() - 1000 };
    const created = await call(author, "PUT", "/boards/large-play", { ...base, play });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await ref.get()).get("separatePlay"), true);
    assert.equal((await ref.get()).get("play"), undefined);
    assert.equal((await gameRef.get()).get("play.historyEncoding"), "u16le-v1");
    assert.deepEqual((await call(author, "GET", "/boards/large-play")).body.play, play);

    const renamed = { ...base, title: "Legacy rename", fingerprint: "large-2", basedOn: 1 };
    assert.equal((await call(author, "PUT", "/boards/large-play", renamed)).status, 200);
    const recovered = (await call(author, "GET", "/boards/large-play")).body;
    assert.deepEqual(recovered.play, play);
    assert.match(recovered.fingerprint as string, /^game-v1:[a-f0-9]{64}$/);
    const index = await call(author, "GET", "/boards");
    assert.equal((index.body.boards as { uid: string; fingerprint: string }[]).find((x) => x.uid === "large-play")?.fingerprint, recovered.fingerprint);
    // A repeated legacy request whose acknowledgement was lost remains idempotent.
    assert.equal((await call(author, "PUT", "/boards/large-play", renamed)).body.revision, 2);
    const stale = await call(author, "PUT", "/boards/large-play", { ...renamed, play: null });
    assert.equal(stale.status, 409);
    assert.deepEqual((stale.body.board as { play: unknown }).play, play);

    // The opaque board fingerprint may not have changed; explicit clear must still be applied.
    assert.equal((await call(author, "PUT", "/boards/large-play", { ...renamed, fingerprint: recovered.fingerprint, basedOn: 2, play: null })).status, 200);
    assert.equal((await gameRef.get()).exists, false);
    assert.equal((await call(author, "GET", "/boards/large-play")).body.play, undefined);
    assert.equal((await call(author, "PUT", "/boards/large-play", { ...renamed, basedOn: 3, fingerprint: "large-3" })).status, 200);
    assert.equal((await call(author, "GET", "/boards/large-play")).body.play, undefined);

    const withGame = await call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "large-4", basedOn: 4, play });
    assert.equal(withGame.status, 200);
    const concurrent = await Promise.all([
      call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "concurrent-edit", basedOn: 5 }),
      call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "concurrent-clear", basedOn: 5, play: null }),
    ]);
    assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 409]);
    const current = await call(author, "GET", "/boards/large-play");
    assert.equal(current.status, 200);
    const reset = await call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "large-5", basedOn: current.body.revision, play });
    assert.equal(reset.status, 200);
    assert.equal((await call(author, "DELETE", "/boards/large-play")).status, 204);
    assert.equal((await gameRef.get()).exists, false);
    assert.equal((await call(author, "PUT", "/boards/erase-play", { ...base, fingerprint: "erase", play })).status, 200);
    assert.equal((await db.collection("accounts").doc(uid).collection("plays").doc("erase-play").get()).exists, true);
    // Race writes already entering the handler against the erasure marker and cleanup.
    const inflight = [0, 1, 2].map((i) => call(author, "PUT", "/boards/erase-play", { ...base, fingerprint: `inflight-${i}`, basedOn: 1, play }));
    const erasure = call(author, "DELETE", "/boards/account");
    const replies = await Promise.all(inflight);
    assert.ok(replies.every((x) => [200, 401, 409].includes(x.status)), JSON.stringify(replies.map((x) => x.status)));
    assert.equal((await erasure).status, 204);
    assert.equal((await db.collection("accounts").doc(uid).collection("plays").get()).size, 0);
    assert.equal((await db.collection("accounts").doc(uid).collection("boards").get()).size, 0);
    assert.equal((await db.collection("accounts").doc(uid).get()).exists, false);
    assert.equal((await call(author, "PUT", "/boards/resurrect", { ...base, play })).status, 401);
  });
});
