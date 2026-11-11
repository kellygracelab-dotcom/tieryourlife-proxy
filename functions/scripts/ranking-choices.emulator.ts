/** Real HTTP + Firestore regression. Only the existing demo emulators are accepted. */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { assertEmulatorsOnly, call, identity, passwordAccount, ownerToken, PROJECT } from "./seed-e2e";

const TIERS = [{ label: "S", caption: "Best", colorLight: "#FF7777", colorDark: "#773333" }, { label: "A", caption: null, colorLight: "#FFFF77", colorDark: "#777733" }];
const ITEMS = [{ title: "Duplicate", imageUrl: null, tierIndex: null }, { title: "Duplicate", imageUrl: null, tierIndex: null }, { title: "Picture", imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg", tierIndex: null }];

describe("ranking choices and authoritative publication under the demo emulators", () => {
  const db = getFirestore(initializeApp({ projectId: PROJECT }, "ranking-choices"));
  let author = "", reader = "", guest = "", readerUid = "", original = "", version = 0;
  const draft = () => ({ title: "Ranking source", category: "film_tv", tiers: TIERS, items: ITEMS, takenFrom: original, sourceVersion: version });
  const boardId = `ranking-board-${Date.now().toString(36)}`;
  const privateBoard = () => ({ title: "Ranking source", fingerprint: "same-client-hash", origin: { listId: original, version }, takenFrom: original, rankingChoice: "offered", tiers: [{ uid: "s", position: 0, ...TIERS[0] }, { uid: "a", position: 1, ...TIERS[1] }, { uid: "pool", position: 2, ...TIERS[1], isPool: true }], items: ITEMS.map((card, i) => ({ uid: `card${i}`, tierUid: "pool", position: i, title: card.title, imageUrl: card.imageUrl, sourceIndex: i })) });

  before(async () => {
    assertEmulatorsOnly();
    async function account(prefix: string) {
      const start = await identity("signUp", {});
      return passwordAccount(start.idToken, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.test`);
    }
    author = (await account("origin")).idToken;
    const person = await account("reader"); reader = person.idToken; readerUid = person.localId;
    guest = (await identity("signUp", {})).idToken;
    const published = await call(author, "POST", "/lists", { title: "Ranking source", category: "film_tv", tiers: TIERS, items: ITEMS });
    assert.equal(published.status, 201, JSON.stringify(published));
    original = String(published.body.id);
    version = Number((await call(reader, "GET", `/lists/${original}`)).body.updatedAt);
  });

  it("preflights a guest without a public/private write and treats cosmetic tiers as the same list", async () => {
    const before = (await db.collection("rankings").where("listId", "==", original).get()).size;
    const answer = await call(guest, "POST", "/lists/lists/classify", { ...draft(), tiers: TIERS.map((tier) => ({ ...tier, colorLight: "#000000", colorDark: "#FFFFFF" })), items: [...ITEMS].reverse() });
    assert.deepEqual(answer, { status: 200, body: { kind: "ranking", listId: original, version } });
    assert.equal((await db.collection("rankings").where("listId", "==", original).get()).size, before);
    assert.equal((await call(guest, "PUT", `/boards/${boardId}`, privateBoard())).status, 403);
  });

  it("keeps invalid tokens refused", async () => {
    const refused = await call("not-a-token", "GET", "/boards");
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "UNAUTHENTICATED");
  });

  it("starts a fresh password session across a second boundary without accepting a revoked guest token", async () => {
    const start = await identity("signUp", {});
    const oldAuthTime = (JSON.parse(Buffer.from(start.idToken.split(".")[1], "base64url").toString("utf8")) as { auth_time: number }).auth_time;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, (oldAuthTime + 2) * 1000 - Date.now())));
    const linked = await passwordAccount(start.idToken, `boundary-${Date.now()}@e2e.test`);
    const auth = getAuth(initializeApp({ projectId: PROJECT }, "password-boundary"));
    const verified = await auth.verifyIdToken(linked.idToken);
    assert.equal(linked.localId, start.localId);
    assert.equal(verified.uid, start.localId);
    assert.ok(verified.auth_time > oldAuthTime);
    await assert.rejects(auth.verifyIdToken(start.idToken), { code: "auth/id-token-revoked" });
  });

  it("keeps origin/choice/index through legacy rename, same-hash decision, conflict and null", async () => {
    assert.equal((await call(reader, "PUT", `/boards/${boardId}`, privateBoard())).status, 200);
    const chosen = await call(reader, "PUT", `/boards/${boardId}`, { ...privateBoard(), basedOn: 1, rankingChoice: "private" });
    assert.equal(chosen.body.revision, 2);
    const { origin: _origin, takenFrom: _taken, rankingChoice: _choice, ...legacy } = privateBoard();
    legacy.items = legacy.items.map(({ sourceIndex: _index, ...item }) => item) as typeof legacy.items;
    const renamed = await call(reader, "PUT", `/boards/${boardId}`, { ...legacy, title: "Private rename", basedOn: 2 });
    assert.equal(renamed.body.revision, 3, JSON.stringify(renamed));
    const loaded = await call(reader, "GET", `/boards/${boardId}`);
    assert.equal(loaded.body.rankingChoice, "private"); assert.deepEqual(loaded.body.origin, { listId: original, version });
    assert.match(String(loaded.body.fingerprint), /^state-v1:/);
    assert.deepEqual((loaded.body.items as { sourceIndex: number }[]).map((item) => item.sourceIndex), [0, 1, 2]);
    const repeated = await call(reader, "PUT", `/boards/${boardId}`, { ...legacy, title: "Private rename", basedOn: 2 });
    assert.equal(repeated.body.revision, 3, "legacy retry of accepted state must be idempotent");
    const conflict = await call(reader, "PUT", `/boards/${boardId}`, { ...legacy, title: "Other rename", basedOn: 1 });
    assert.equal(conflict.status, 409); assert.equal((conflict.body.board as Record<string, unknown>).rankingChoice, "private");
    const nulled = await call(reader, "PUT", `/boards/${boardId}`, { ...loaded.body, basedOn: 3, origin: null, takenFrom: null, rankingChoice: null });
    assert.equal(nulled.status, 200, JSON.stringify(nulled));
    assert.equal((await call(reader, "GET", `/boards/${boardId}`)).body.rankingChoice, "private");
    assert.equal((await db.collection("publishedLists").doc(original).get()).get("rankingCount"), 0);
  });

  it("publishes exact permutations once as positional Rankings and withdrawal preserves private progress", async () => {
    const body = { ...draft(), items: [{ ...ITEMS[1], sourceIndex: 1, tierIndex: 0 }, { ...ITEMS[2], sourceIndex: 2, tierIndex: 0 }, { ...ITEMS[0], sourceIndex: 0, tierIndex: 1 }] };
    const results = await Promise.all([call(reader, "POST", "/lists", body), call(reader, "POST", "/lists", body)]);
    for (const result of results) assert.deepEqual(result, { status: 200, body: { id: original, ranking: true } });
    const mine = (await db.collection("rankings").doc(`${original}_${readerUid}`).get()).data()!;
    assert.deepEqual(mine.rows, [{ items: [1, 2] }, { items: [0] }]);
    assert.deepEqual(mine.arrangement, [1, 0, 0]);
    assert.equal(mine.sourceVersion, version);
    assert.equal((await db.collection("publishedLists").doc(original).get()).get("rankingCount"), 1);
    assert.equal((await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size, 0);
    assert.equal((await call(reader, "DELETE", `/lists/${original}/rankings/mine`)).status, 204);
    const board = await call(reader, "GET", `/boards/${boardId}`);
    assert.equal(board.body.rankingChoice, "private"); assert.equal((board.body.items as unknown[]).length, 3);
  });

  it("cannot rebind a copied board to another list or override its immutable lineage at preflight/publication", async () => {
    const { takenFrom: _taken, sourceVersion: _version, ...independent } = draft();
    const ownB = await call(reader, "POST", "/lists", independent);
    assert.equal(ownB.status, 201, JSON.stringify(ownB));
    const bId = String(ownB.body.id);
    const bVersion = Number((await call(reader, "GET", `/lists/${bId}`)).body.updatedAt);
    const loaded = (await call(reader, "GET", `/boards/${boardId}`)).body;
    const rebind = await call(reader, "PUT", `/boards/${boardId}`, { ...loaded, basedOn: loaded.revision, origin: { listId: bId, version: bVersion }, takenFrom: bId });
    assert.equal(rebind.status, 400, JSON.stringify(rebind));
    const alias = await call(reader, "PUT", `/boards/${boardId}`, { ...loaded, basedOn: loaded.revision, origin: null, takenFrom: bId });
    assert.equal(alias.status, 400, JSON.stringify(alias));
    const count = (await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size;
    for (const path of ["/lists/classify", "/lists"]) {
      const spoof = await call(reader, "POST", path, { ...draft(), boardUid: boardId, takenFrom: bId, sourceVersion: bVersion });
      assert.equal(spoof.status, 400, JSON.stringify(spoof)); assert.equal(spoof.body.detail, "takenFrom");
    }
    assert.equal((await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size, count);
    assert.deepEqual((await call(reader, "GET", `/boards/${boardId}`)).body.origin, { listId: original, version });
    const honest = await call(reader, "POST", "/lists/classify", { ...draft(), boardUid: boardId });
    assert.equal(honest.body.kind, "ranking", JSON.stringify(honest));
  });

  it("classifies a new private photograph as changed content without leaking it, with the same image priority as publication", async () => {
    const kept = await call(reader, "POST", "/lists/pictures/keep", { url: "https://example.invalid/private-photo.png" });
    assert.equal(kept.status, 200, JSON.stringify(kept));
    const pictureId = String(kept.body.pictureId);
    const changed = { ...draft(), items: [{ ...ITEMS[0], pictureId }, ...ITEMS.slice(1)] };
    const preflight = await call(reader, "POST", "/lists/classify", changed);
    assert.equal(preflight.body.kind, "list", JSON.stringify(preflight));
    assert.equal(JSON.stringify(preflight.body).includes(pictureId), false);
    const published = await call(reader, "POST", "/lists", changed);
    assert.equal(published.status, 201, JSON.stringify(published));
    assert.equal(published.body.ranking, undefined);
    const saved = await call(reader, "GET", `/lists/${published.body.id}`);
    assert.ok((saved.body.items as { imageUrl: string | null }[])[0].imageUrl, "the new photograph must really be published");
    const samePublicPicture = { ...draft(), items: [ITEMS[0], ITEMS[1], { ...ITEMS[2], pictureId }] };
    assert.equal((await call(reader, "POST", "/lists/classify", samePublicPicture)).body.kind, "ranking");
    assert.deepEqual(await call(reader, "POST", "/lists", samePublicPicture), { status: 200, body: { id: original, ranking: true } });
    assert.equal((await call(reader, "DELETE", `/lists/${original}/rankings/mine`)).status, 204);
  });

  it("rejects invalid duplicate positions without a public mutation", async () => {
    const before = (await db.collection("publishedLists").doc(original).get()).get("rankingCount");
    for (const indices of [[0, 0, 2], [0, 1, 9], [2, 1, 0]]) {
      const answer = await call(reader, "POST", "/lists", { ...draft(), items: ITEMS.map((item, i) => ({ ...item, sourceIndex: indices[i] })) });
      assert.equal(answer.status, 400, JSON.stringify(answer)); assert.equal(answer.body.detail, "sourceIndex");
    }
    const { sourceVersion: _version, ...unversioned } = draft();
    const unbound = await call(reader, "POST", "/lists/classify", { ...unversioned, items: ITEMS.map((item, sourceIndex) => ({ ...item, sourceIndex })) });
    assert.equal(unbound.status, 400); assert.equal(unbound.body.detail, "sourceVersion");
    assert.equal((await db.collection("publishedLists").doc(original).get()).get("rankingCount"), before);
  });

  it("unbinds duplicate indices on an origin version change and preserves ordinary legacy idempotency", async () => {
    const id = `version-${boardId}`;
    const first = privateBoard();
    assert.equal((await call(reader, "PUT", `/boards/${id}`, first)).status, 200);
    const nextItems = first.items.map(({ sourceIndex: _index, ...item }) => item);
    const updated = await call(reader, "PUT", `/boards/${id}`, { ...first, basedOn: 1, origin: { listId: original, version: version + 1 }, items: nextItems });
    assert.equal(updated.status, 200, JSON.stringify(updated));
    const restored = await call(reader, "GET", `/boards/${id}`);
    assert.ok((restored.body.items as { sourceIndex?: number }[]).every((item) => item.sourceIndex === undefined));
    const rebound = await call(reader, "PUT", `/boards/${id}`, { ...restored.body, basedOn: restored.body.revision, items: nextItems.map((item, i) => ({ ...item, sourceIndex: i < 2 ? 1 - i : i })) });
    assert.equal(rebound.status, 200);
    assert.deepEqual(((await call(reader, "GET", `/boards/${id}`)).body.items as { sourceIndex: number }[]).map((item) => item.sourceIndex), [1, 0, 2]);
    const { origin: _origin, takenFrom: _taken, rankingChoice: _choice, ...ordinary } = first;
    const normal = { ...ordinary, items: nextItems };
    const ordinaryId = `ordinary-${boardId}`;
    assert.equal((await call(reader, "PUT", `/boards/${ordinaryId}`, normal)).body.revision, 1);
    const repeat = await call(reader, "PUT", `/boards/${ordinaryId}`, { ...normal, items: [...nextItems].reverse() });
    assert.equal(repeat.status, 200); assert.equal(repeat.body.revision, 1);
  });

  it("permits meaningful derivatives with attribution, and preserves existing public list type", async () => {
    for (const change of [{ title: "Derivative title" }, { items: [ITEMS[0], ITEMS[1], { ...ITEMS[2], title: "Picture renamed" }] }, { tiers: [{ ...TIERS[0], caption: "Other criterion" }, TIERS[1]] }, { tiers: [...TIERS].reverse() }]) {
      const body = { ...draft(), ...change };
      const classified = await call(reader, "POST", "/lists/classify", body);
      assert.equal(classified.body.kind, "list"); assert.equal((classified.body.basedOn as { id: string }).id, original);
    }
    const created = await call(reader, "POST", "/lists", { ...draft(), title: "Derivative title", boardUid: `public-${boardId}` });
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(((await call(reader, "GET", `/lists/${created.body.id}`)).body.basedOn as { id: string }).id, original);
    const replaced = await call(reader, "POST", `/lists/${created.body.id}`, draft());
    assert.equal(replaced.status, 200); assert.equal(replaced.body.id, created.body.id); assert.equal(replaced.body.ranking, undefined);
  });

  it("refuses a source hidden since preflight even when its updatedAt did not change", async () => {
    const before = await call(reader, "POST", "/lists/classify", draft());
    assert.equal(before.body.kind, "ranking");
    const ref = db.collection("publishedLists").doc(original);
    await ref.update({ underReview: true });
    try {
      for (const path of ["/lists", "/lists/classify"]) {
        for (const title of ["Ranking source", "Derivative of now hidden source"]) {
          const answer = await call(reader, "POST", path, { ...draft(), title });
          assert.equal(answer.status, 409, JSON.stringify(answer)); assert.equal(answer.body.code, "LIST_CHANGED");
        }
      }
      assert.equal((await ref.get()).get("updatedAt").toMillis(), version);
    } finally { await ref.update({ underReview: false }); }
  });

  it("checks source versions on both publication routes and keeps legacy occurrence mapping readable", async () => {
    const stale = version;
    const changed = await call(author, "POST", `/lists/${original}`, { ...draft(), title: "Source version changed" });
    assert.equal(changed.status, 200, JSON.stringify(changed));
    for (const path of ["/lists", "/lists/classify"]) {
      const answer = await call(reader, "POST", path, { ...draft(), sourceVersion: stale });
      assert.equal(answer.status, 409); assert.equal(answer.body.code, "LIST_CHANGED");
    }
    const rank = await call(reader, "PUT", `/lists/${original}/rankings/mine`, { tierLabels: ["S", "A"], rows: [[1, 2], [0]], version: stale });
    assert.equal(rank.status, 409); assert.equal(rank.body.code, "LIST_CHANGED");
    version = Number((await call(reader, "GET", `/lists/${original}`)).body.updatedAt);
    const { sourceVersion: _version, ...legacy } = draft();
    const result = await call(reader, "POST", "/lists", { ...legacy, title: "Source version changed", items: ITEMS.map((item, i) => ({ ...item, tierIndex: i % 2 })) });
    assert.equal(result.body.ranking, true, JSON.stringify(result));
    assert.deepEqual((await db.collection("rankings").doc(`${original}_${readerUid}`).get()).get("rows"), [{ items: [0, 2] }, { items: [1] }]);
  });

  it("ranks one complete official language version, preserves duplicate positions and refuses a stale translation version", async () => {
    const owner = await ownerToken();
    const body = { title: "Films", category: "film_tv", tiers: [{ ...TIERS[0], label: "Best", caption: "Criterion" }], items: [{ title: "Arrival", tierIndex: null }, { title: "Arrival", tierIndex: null }, { title: "Moon", imageUrl: ITEMS[2].imageUrl, tierIndex: null }] };
    const house = await call(owner, "POST", "/lists/editorial", body);
    assert.equal(house.status, 201, JSON.stringify(house));
    const id = String(house.body.id);
    const translations = { ru: { Films: "Фильмы", Best: "Лучшие", Criterion: "Критерий", Arrival: "Прибытие", Moon: "Луна" }, uk: { Films: "Фільми", Best: "Найкращі", Criterion: "Критерій", Arrival: "Прибуття", Moon: "Місяць" } };
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}/translations`, { translations })).status, 200);
    const sourceVersion = Number((await call(reader, "GET", `/lists/${id}`)).body.updatedAt);
    const russian = { ...body, title: "Фильмы", takenFrom: id, sourceVersion, tiers: [{ ...body.tiers[0], label: "Лучшие", caption: "Критерий" }], items: [{ title: "Прибытие", sourceIndex: 1, tierIndex: 0 }, { title: "Луна", imageUrl: ITEMS[2].imageUrl, sourceIndex: 2, tierIndex: 0 }, { title: "Прибытие", sourceIndex: 0, tierIndex: null }] };
    assert.equal((await call(reader, "POST", "/lists/classify", russian)).body.kind, "ranking");
    const published = await call(reader, "POST", "/lists", russian);
    assert.deepEqual(published, { status: 200, body: { id, ranking: true } });
    assert.deepEqual((await db.collection("rankings").doc(`${id}_${readerUid}`).get()).get("rows"), [{ items: [1, 2] }]);
    for (const edit of [{ title: "Мои фильмы" }, { items: [{ ...russian.items[0], title: "Прибуття" }, ...russian.items.slice(1)] }, { items: [russian.items[0], { ...russian.items[1], title: "Renamed same picture" }, russian.items[2]] }]) {
      const preflight = await call(reader, "POST", "/lists/classify", { ...russian, ...edit });
      assert.equal(preflight.body.kind, "list", JSON.stringify(preflight));
    }
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}/translations`, { translations: { ...translations, ru: { ...translations.ru, Films: "Кино" } } })).status, 200);
    const stale = await call(reader, "POST", "/lists", russian);
    assert.equal(stale.status, 409); assert.equal(stale.body.code, "LIST_CHANGED");
  });

  it("keeps Rankings and private boards outside the current list limit", async () => {
    const batch = db.batch();
    for (let i = 0; i < 50; i++) batch.set(db.collection("publishedLists").doc(`quota-${readerUid}-${i}`), { authorUid: readerUid });
    await batch.commit();
    const repeat = await call(reader, "POST", "/lists", { ...draft(), title: "Derivative title", boardUid: `public-${boardId}` });
    assert.equal(repeat.status, 200, JSON.stringify(repeat)); assert.equal(repeat.body.existing, true);
    const exact = { ...draft(), title: "Source version changed" };
    assert.equal((await call(reader, "POST", "/lists", exact)).body.ranking, true);
    const refused = await call(reader, "POST", "/lists", { ...exact, title: "A new public list" });
    assert.equal(refused.status, 409); assert.equal(refused.body.code, "TOO_MANY_LISTS");
    const saved = await call(reader, "PUT", `/boards/quota-${boardId}`, { ...privateBoard(), title: "Private survives quota" });
    assert.equal(saved.status, 200, JSON.stringify(saved));
  });
});
