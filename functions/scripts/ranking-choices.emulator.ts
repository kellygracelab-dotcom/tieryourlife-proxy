/** Real HTTP + Firestore regression. Only the existing demo emulators are accepted. */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { assertEmulatorsOnly, call, identity, passwordAccount, ownerToken, PROJECT, seed } from "./seed-e2e";

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

  it("refuses a new private photograph in somebody's list as a list of one's own without leaking it, with the same image priority as publication", async () => {
    const kept = await call(reader, "POST", "/lists/pictures/keep", { url: "https://example.invalid/private-photo.png" });
    assert.equal(kept.status, 200, JSON.stringify(kept));
    const pictureId = String(kept.body.pictureId);
    const changed = { ...draft(), items: [{ ...ITEMS[0], pictureId }, ...ITEMS.slice(1)] };
    const count = (await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size;
    for (const path of ["/lists/classify", "/lists"]) {
      const answer = await call(reader, "POST", path, changed);
      assert.deepEqual([answer.status, answer.body.code, answer.body.listId], [409, "RANK_INSTEAD", original], JSON.stringify(answer));
      assert.equal(JSON.stringify(answer.body).includes(pictureId), false);
    }
    assert.equal((await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size, count);
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

  it("refuses a changed copy of somebody else's list as a list of one's own (RANK_INSTEAD), and keeps an existing copy a list", async () => {
    const count = (await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size;
    for (const change of [{ title: "Derivative title" }, { items: [ITEMS[0], ITEMS[1], { ...ITEMS[2], title: "Picture renamed" }] }, { tiers: [{ ...TIERS[0], caption: "Other criterion" }, TIERS[1]] }, { tiers: [...TIERS].reverse() }]) {
      for (const path of ["/lists/classify", "/lists"]) {
        const answer = await call(reader, "POST", path, { ...draft(), ...change, boardUid: `public-${boardId}` });
        assert.deepEqual([answer.status, answer.body.code, answer.body.listId], [409, "RANK_INSTEAD", original], JSON.stringify(answer));
      }
    }
    assert.equal((await db.collection("publishedLists").where("authorUid", "==", readerUid).get()).size, count);
    // A copy published before the refusal existed stays a list when its author replaces it.
    const { takenFrom: _taken, sourceVersion: _version, ...independent } = draft();
    const created = await call(reader, "POST", "/lists", { ...independent, title: "Derivative title", boardUid: `public-${boardId}` });
    assert.equal(created.status, 201, JSON.stringify(created));
    await db.collection("publishedLists").doc(String(created.body.id)).update({ basedOn: { id: original, title: "Ranking source", authorUid: "", authorName: "" } });
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
      assert.deepEqual([preflight.status, preflight.body.code, preflight.body.listId], [409, "RANK_INSTEAD", id], JSON.stringify(preflight));
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
    assert.equal((await call(reader, "POST", "/lists", { ...exact, title: "A new public list" })).body.code, "RANK_INSTEAD");
    const { takenFrom: _taken, sourceVersion: _version, ...own } = exact;
    const refused = await call(reader, "POST", "/lists", { ...own, title: "A new public list" });
    assert.equal(refused.status, 409); assert.equal(refused.body.code, "TOO_MANY_LISTS");
    const saved = await call(reader, "PUT", `/boards/quota-${boardId}`, { ...privateBoard(), title: "Private survives quota" });
    assert.equal(saved.status, 200, JSON.stringify(saved));
  });
});

describe("rankings sheet: the author first, likes, added cards, withdrawal and erasure (14.11.2026)", () => {
  const app = initializeApp({ projectId: PROJECT }, "rankings-sheet");
  const db = getFirestore(app);
  const PHOTO = "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/large.jpeg";
  const PHOTO_CREDIT = "(c) Douglas Goldman, some rights reserved (CC BY-SA)";
  const OUTSIDE = `https://example.com/added-${Date.now().toString(36)}.png`;
  type Person = { token: string; uid: string };
  let author: Person, one: Person, two: Person, three: Person, guest = "", list = "", version = 0;
  const sheet = async (who: string, query = "?withAuthor=1") => call(who, "GET", `/lists/${list}/rankings${query}`);
  const ids = (answer: Awaited<ReturnType<typeof call>>) => (answer.body.rankings as { uid: string }[]).map((one) => one.uid);
  const placing = { tierLabels: ["S", "A"], rows: [[0], [1]] };
  async function person(prefix: string): Promise<Person> {
    const start = await identity("signUp", {});
    const made = await passwordAccount(start.idToken, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.test`);
    return { token: made.idToken, uid: made.localId };
  }
  async function filesIn(folder: string, anyAddress: string): Promise<string[]> {
    const bucket = getStorage(app).bucket(anyAddress.split("/v0/b/")[1]!.split("/")[0]!);
    const [files] = await bucket.getFiles({ prefix: `published/${folder}/` });
    return files.map((file) => file.name.slice(`published/${folder}/`.length)).sort();
  }

  before(async () => {
    assertEmulatorsOnly();
    [author, one, two, three] = await Promise.all([person("sheet-author"), person("sheet-one"), person("sheet-two"), person("sheet-three")]);
    guest = (await identity("signUp", {})).idToken;
    const published = await call(author.token, "POST", "/lists", { title: "Sheet source", category: "film_tv", tiers: TIERS, items: [{ title: "First", tierIndex: 1 }, { title: "Second", tierIndex: null }, { title: "Third", tierIndex: 1 }] });
    assert.equal(published.status, 201, JSON.stringify(published));
    list = String(published.body.id);
    version = Number((await call(one.token, "GET", `/lists/${list}`)).body.updatedAt);
    for (const who of [one, two, three]) {
      const ranked = await call(who.token, "PUT", `/lists/${list}/rankings/mine`, { ...placing, rows: [[0], [1, 2]], version });
      assert.equal(ranked.status, 200, JSON.stringify(ranked));
    }
  });

  it("starts with the author's own placing, then the newest, the reader's own in its place", async () => {
    const answer = await sheet(one.token);
    assert.equal(answer.status, 200, JSON.stringify(answer));
    assert.deepEqual(ids(answer), [author.uid, three.uid, two.uid, one.uid]);
    const [first, , , mine] = answer.body.rankings as Record<string, unknown>[];
    assert.deepEqual(first, { uid: author.uid, authorName: first.authorName, authorPhotoUrl: first.authorPhotoUrl, arrangement: [1, null, 1], rows: [[], [0, 2]], tierLabels: ["S", "A"], updatedAtMs: version, mine: false, isAuthor: true, likedByMe: false });
    assert.deepEqual([mine.mine, mine.isAuthor, mine.likedByMe], [true, false, false]);
    assert.equal(((await sheet(author.token)).body.rankings as { mine: boolean }[])[0].mine, true);
    assert.deepEqual(ids(await sheet(one.token, "")), [three.uid, two.uid, one.uid]);
    assert.equal(JSON.stringify(answer.body).includes("likeCount"), false);
    for (const old of ["~1790000000.1", `${list}_${one.uid}`]) {
      const gone = await sheet(one.token, `?withAuthor=1&after=${encodeURIComponent(old)}`);
      assert.deepEqual([gone.status, gone.body.code], [409, "CURSOR_GONE"]);
    }
  });

  it("likes a ranking once, puts the most liked first, and never says how many", async () => {
    const like = () => call(one.token, "PUT", `/lists/${list}/rankings/${two.uid}/like`);
    assert.deepEqual(await like(), { status: 200, body: { likedByMe: true } });
    assert.deepEqual(await like(), { status: 200, body: { likedByMe: true } });
    assert.equal((await db.collection("rankings").doc(`${list}_${two.uid}`).get()).get("likeCount"), 1);
    const answer = await sheet(one.token);
    assert.deepEqual(ids(answer), [author.uid, two.uid, three.uid, one.uid]);
    assert.equal((answer.body.rankings as { likedByMe: boolean }[])[1].likedByMe, true);
    assert.equal(((await sheet(three.token)).body.rankings as { likedByMe: boolean }[])[1].likedByMe, false);
    assert.equal(JSON.stringify(answer.body).includes("likeCount"), false);
    // Replacing the liked ranking keeps its likes.
    assert.equal((await call(two.token, "PUT", `/lists/${list}/rankings/mine`, placing)).status, 200);
    assert.equal((await db.collection("rankings").doc(`${list}_${two.uid}`).get()).get("likeCount"), 1);
    const back = () => call(one.token, "DELETE", `/lists/${list}/rankings/${two.uid}/like`);
    assert.deepEqual(await back(), { status: 200, body: { likedByMe: false } });
    assert.deepEqual(await back(), { status: 200, body: { likedByMe: false } });
    assert.equal((await db.collection("rankings").doc(`${list}_${two.uid}`).get()).get("likeCount"), 0);
  });

  it("refuses a guest, one's own, the author's, a ranking not there, a hidden list and the 301st like in an hour", async () => {
    const at = (who: string, uid: string, method = "PUT") => call(who, method, `/lists/${list}/rankings/${uid}/like`);
    assert.deepEqual([(await at(guest, two.uid)).status, (await at(guest, two.uid)).body.code], [403, "NOT_SIGNED_IN"]);
    assert.deepEqual((await at(one.token, one.uid)).body, { error: "That one cannot be liked", code: "CANNOT_LIKE", detail: "own" });
    assert.deepEqual([(await at(one.token, author.uid)).status, (await at(one.token, author.uid)).body.detail], [409, "author"]);
    assert.equal((await at(one.token, "NobodyRankedThisList1")).status, 404);
    const ref = db.collection("publishedLists").doc(list);
    await ref.update({ underReview: true });
    try {
      assert.equal((await at(one.token, two.uid)).status, 404);
    } finally {
      await ref.update({ underReview: false });
    }
    const quota = db.collection("likeQuota").doc(one.uid);
    await quota.set({ events: Array.from({ length: 300 }, (_, i) => Date.now() - 1000 + i) });
    try {
      const limited = await at(one.token, three.uid);
      assert.equal(limited.status, 429, JSON.stringify(limited));
      assert.equal(limited.body.code, "LIKE_LIMIT");
      assert.ok(Number(limited.body.retryAt) > Date.now());
      assert.deepEqual((await at(one.token, three.uid, "DELETE")).body, { likedByMe: false }, "asking for what is already so costs nothing");
    } finally {
      await quota.delete();
    }
  });

  it("keeps cards the reader added, with copies of their pictures in the ranking's own folder, and drops the ones taken away", async () => {
    const kept = await call(one.token, "POST", "/lists/pictures/keep", { url: "https://example.invalid/added-photo.png" });
    assert.equal(kept.status, 200, JSON.stringify(kept));
    const addedCards = [
      { title: "Lion", imageUrl: PHOTO, credit: PHOTO_CREDIT, tierIndex: 0 },
      { title: "My own", pictureId: kept.body.pictureId },
      { title: "From a site", imageUrl: OUTSIDE },
    ];
    for (const [body, detail] of [
      [{ ...placing, addedCards: Array.from({ length: 51 }, () => ({ title: "x" })) }, "addedCards"],
      [{ ...placing, addedCards: [{ title: "" }] }, "addedCards"],
      [{ ...placing, rows: [[0, 6], [1]], addedCards }, "rows"],
    ] as [unknown, string][]) {
      const refused = await call(one.token, "PUT", `/lists/${list}/rankings/mine`, body);
      assert.deepEqual([refused.status, refused.body.code, refused.body.detail], [400, "INVALID", detail], JSON.stringify(refused));
    }
    const saved = await call(one.token, "PUT", `/lists/${list}/rankings/mine`, { tierLabels: ["S", "A"], rows: [[3, 0], [1, 4, 5]], version, addedCards });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.deepEqual(saved.body.rows, [[0], [1]]);
    assert.deepEqual(saved.body.arrangement, [0, 1, null]);
    assert.deepEqual(saved.body.allRows, [[3, 0], [1, 4, 5]]);
    const folder = `ranking-${list}_${one.uid}`;
    const cards = saved.body.addedCards as { title: string; imageUrl: string; attribution?: Record<string, string>; credit?: string }[];
    assert.deepEqual(cards.map((card) => card.title), ["Lion", "My own", "From a site"]);
    assert.match(cards[0].imageUrl, new RegExp(`published%2F${folder}%2Fw-[0-9a-f]{32}`));
    assert.deepEqual([cards[0].attribution?.source, cards[0].attribution?.originalUrl, cards[0].credit], ["inaturalist", PHOTO, PHOTO_CREDIT]);
    assert.match(cards[1].imageUrl, new RegExp(`published%2F${folder}%2F`));
    assert.match(cards[2].imageUrl, new RegExp(`published%2F${folder}%2Fw-[0-9a-f]{32}`));
    assert.equal((await filesIn(folder, cards[0].imageUrl)).length, 3);
    const shown = ((await sheet(two.token)).body.rankings as { uid: string; addedCards?: unknown[]; allRows?: unknown }[]).find((one_) => one_.uid === one.uid)!;
    assert.deepEqual([shown.addedCards?.length, shown.allRows], [3, [[3, 0], [1, 4, 5]]]);
    // Sent back as read, the lion keeps its copy; the photograph and the outside picture go.
    const again = await call(one.token, "PUT", `/lists/${list}/rankings/mine`, { tierLabels: ["S"], rows: [[3, 2]], addedCards: [cards[0]] });
    assert.equal(again.status, 200, JSON.stringify(again));
    assert.equal((again.body.addedCards as { imageUrl: string }[])[0].imageUrl, cards[0].imageUrl);
    const left = await filesIn(folder, cards[0].imageUrl);
    assert.deepEqual(left, [decodeURIComponent(cards[0].imageUrl.split("%2F").pop()!.split("?")[0]!)]);
    // Without added cards they all go, and old readers' rows never held them.
    const plain = await call(one.token, "PUT", `/lists/${list}/rankings/mine`, placing);
    assert.equal(plain.body.addedCards, undefined);
    assert.deepEqual(await filesIn(folder, cards[0].imageUrl), []);
  });

  it("withdraws a ranking with the likes it was given and its copies", async () => {
    const added = await call(three.token, "PUT", `/lists/${list}/rankings/mine`, { tierLabels: ["S"], rows: [[3]], addedCards: [{ title: "Lion", imageUrl: PHOTO, credit: PHOTO_CREDIT }] });
    assert.equal(added.status, 200, JSON.stringify(added));
    const address = (added.body.addedCards as { imageUrl: string }[])[0].imageUrl;
    assert.equal((await call(two.token, "PUT", `/lists/${list}/rankings/${three.uid}/like`)).status, 200);
    const count = (await db.collection("publishedLists").doc(list).get()).get("rankingCount");
    assert.equal((await call(three.token, "DELETE", `/lists/${list}/rankings/mine`)).status, 204);
    assert.equal((await db.collection("rankings").doc(`${list}_${three.uid}`).get()).exists, false);
    assert.equal((await db.collection("rankingLikes").where("rankingId", "==", `${list}_${three.uid}`).get()).size, 0);
    assert.deepEqual(await filesIn(`ranking-${list}_${three.uid}`, address), []);
    assert.equal((await db.collection("publishedLists").doc(list).get()).get("rankingCount"), count - 1);
    assert.equal((await call(two.token, "PUT", `/lists/${list}/rankings/${three.uid}/like`)).status, 404);
  });

  it("erases an account's likes and rankings with its account", async () => {
    const four = await person("sheet-four");
    const added = await call(four.token, "PUT", `/lists/${list}/rankings/mine`, { tierLabels: ["S"], rows: [[3]], addedCards: [{ title: "Lion", imageUrl: PHOTO, credit: PHOTO_CREDIT }] });
    assert.equal(added.status, 200, JSON.stringify(added));
    const address = (added.body.addedCards as { imageUrl: string }[])[0].imageUrl;
    assert.deepEqual((await call(four.token, "PUT", `/lists/${list}/rankings/${two.uid}/like`)).body, { likedByMe: true });
    assert.deepEqual((await call(two.token, "PUT", `/lists/${list}/rankings/${four.uid}/like`)).body, { likedByMe: true });
    const count = (await db.collection("publishedLists").doc(list).get()).get("rankingCount");
    const twoLikes = (await db.collection("rankings").doc(`${list}_${two.uid}`).get()).get("likeCount");
    assert.equal((await call(four.token, "DELETE", "/boards/account")).status, 204);
    assert.equal((await db.collection("rankings").doc(`${list}_${four.uid}`).get()).exists, false);
    assert.equal((await db.collection("publishedLists").doc(list).get()).get("rankingCount"), count - 1);
    assert.equal((await db.collection("rankings").doc(`${list}_${two.uid}`).get()).get("likeCount"), twoLikes - 1);
    assert.equal((await db.collection("rankingLikes").where("uid", "==", four.uid).get()).size, 0);
    assert.equal((await db.collection("rankingLikes").where("rankedBy", "==", four.uid).get()).size, 0);
    assert.equal((await db.collection("likeQuota").doc(four.uid).get()).exists, false);
    assert.deepEqual(await filesIn(`ranking-${list}_${four.uid}`, address), []);
    assert.equal(ids(await sheet(one.token)).includes(four.uid), false);
  });

  it("shows a topic's lists whatever section is asked with it", async () => {
    const { topic } = await seed();
    const published = await call(author.token, "POST", "/lists", { title: "Topic feed", category: "film_tv", topicId: topic.id, tiers: TIERS, items: [{ title: "Card", tierIndex: 0 }] });
    assert.equal(published.status, 201, JSON.stringify(published));
    for (const sort of ["recent", "popular"]) {
      const withSection = await call(guest, "GET", `/lists?category=film_tv&topic=${topic.id}&sort=${sort}`);
      const alone = await call(guest, "GET", `/lists?topic=${topic.id}&sort=${sort}`);
      assert.equal(withSection.status, 200, JSON.stringify(withSection));
      const named = (answer: typeof alone) => (answer.body.lists as { id: string }[]).map((one_) => one_.id);
      assert.ok(named(withSection).includes(String(published.body.id)), sort);
      assert.deepEqual(named(withSection), named(alone));
    }
  });
});
