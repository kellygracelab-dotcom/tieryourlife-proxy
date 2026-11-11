/** Real HTTP + Firestore regression. Only the existing demo emulators are accepted. */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { assertEmulatorsOnly, call, identity, ownerToken, PROJECT } from "./seed-e2e";

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
      return identity("update", { idToken: start.idToken, email: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.test`, password: "e2e-password" });
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

  it("rejects invalid duplicate positions without a public mutation", async () => {
    for (const indices of [[0, 0, 2], [0, 1, 9], [2, 1, 0]]) {
      const answer = await call(reader, "POST", "/lists", { ...draft(), items: ITEMS.map((item, i) => ({ ...item, sourceIndex: indices[i] })) });
      assert.equal(answer.status, 400, JSON.stringify(answer)); assert.equal(answer.body.detail, "sourceIndex");
    }
    const { sourceVersion: _version, ...unversioned } = draft();
    const unbound = await call(reader, "POST", "/lists/classify", { ...unversioned, items: ITEMS.map((item, sourceIndex) => ({ ...item, sourceIndex })) });
    assert.equal(unbound.status, 400); assert.equal(unbound.body.detail, "sourceVersion");
    assert.equal((await db.collection("publishedLists").doc(original).get()).get("rankingCount"), 0);
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
