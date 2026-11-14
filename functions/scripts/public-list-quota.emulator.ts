/** Actual HTTP/transaction regressions. Synthetic history is written only to the isolated demo database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { PUBLIC_LIST_WINDOW_MS, readPublicListQuotaLimit } from "../src/publicListQuota";
import { EDITORIAL_UID } from "../src/editorial";
import { assertEmulatorsOnly, call, FUNCTIONS, identity, OWNER, ownerToken, passwordAccount, PROJECT } from "./seed-e2e";

assertEmulatorsOnly();
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^(127\.0\.0\.1|localhost):\d+$/);
const limit = readPublicListQuotaLimit(process.env.PUBLIC_LISTS_PER_SEVEN_DAYS);
const db = getFirestore(initializeApp({ projectId: PROJECT }, `public-quota-${randomUUID()}`));
const TIERS = [{ label: "A", caption: null, colorLight: "#000000", colorDark: "#FFFFFF" }];
const ITEMS = [{ title: "Card", imageUrl: null, tierIndex: 0 }];
const draft = (boardUid: string = randomUUID()) => ({ title: "Quota example", category: "film_tv", tiers: TIERS, items: ITEMS, boardUid });

async function account() {
  const guest = await identity("signUp", {});
  const person = await passwordAccount(guest.idToken, `quota-${randomUUID()}@e2e.test`);
  return { token: person.idToken, uid: person.localId };
}

const lock = (uid: string) => db.collection("publishLocks").doc(uid);
const events = async (uid: string): Promise<number[] | undefined> => (await lock(uid).get()).get("publicListEvents") as number[] | undefined;
const lists = (uid: string) => db.collection("publishedLists").where("authorUid", "==", uid);

async function oldLists(uid: string, count: number): Promise<string[]> {
  const batch = db.batch();
  const ids = Array.from({ length: count }, () => db.collection("publishedLists").doc().id);
  for (const id of ids) batch.set(db.collection("publishedLists").doc(id), {
    ...draft(), authorUid: uid, authorName: "Synthetic author", itemCount: 1, underReview: false,
    publishedAt: Timestamp.fromMillis(Date.now() - 2 * PUBLIC_LIST_WINDOW_MS), updatedAt: Timestamp.now(),
  });
  await batch.commit();
  return ids;
}

async function source() {
  const id = db.collection("publishedLists").doc().id;
  const version = Date.now();
  await db.collection("publishedLists").doc(id).set({
    ...draft(), authorUid: `synthetic-source-${randomUUID()}`, authorName: "Synthetic source", itemCount: 1,
    underReview: false, updatedAt: Timestamp.fromMillis(version), publishedAt: Timestamp.fromMillis(version), rankingCount: 0,
  });
  return { takenFrom: id, sourceVersion: version };
}

async function refused(token: string, body: unknown) {
  const reply = await fetch(`${FUNCTIONS}/lists`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() as Record<string, unknown>, retryAfter: reply.headers.get("Retry-After") };
}

describe(`new-public-list HTTP quota (${limit === null ? "default OFF" : `demo N=${limit}`})`, () => {
  before(() => { if (limit !== null) assert.equal(limit, 2, "The ON fixture selects 2 only in the demo emulator, never production"); });

  if (limit === null) {
    it("keeps the previous fifty-current-list rule, retries/updates/delete semantics and writes no quota events", async () => {
      const person = await account();
      const ids = await oldLists(person.uid, 49);
      const body = draft();
      const first = await call(person.token, "POST", "/lists", body);
      assert.equal(first.status, 201, JSON.stringify(first));
      assert.equal(await events(person.uid), undefined);
      const full = await refused(person.token, draft());
      assert.equal(full.status, 409); assert.equal(full.body.code, "TOO_MANY_LISTS");
      assert.equal(full.body.retryAt, undefined); assert.equal(full.retryAfter, null);
      assert.equal((await call(person.token, "POST", "/lists", body)).body.id, first.body.id);
      assert.equal((await call(person.token, "POST", `/lists/${first.body.id}`, { ...body, title: "Updated" })).status, 200);
      assert.equal((await call(person.token, "DELETE", `/lists/${ids[0]}`)).status, 204);
      assert.equal((await call(person.token, "POST", "/lists", draft())).status, 201);
      assert.equal(await events(person.uid), undefined);
      assert.equal((await lists(person.uid).get()).size, 50);
    });

    it("does not create a quota event document for private saves/preflight/Rankings, or change retained history while OFF", async () => {
      const person = await account();
      const original = await source();
      const body = { ...draft(), ...original };
      assert.equal((await call(person.token, "POST", "/lists/classify", body)).body.kind, "ranking");
      assert.equal((await call(person.token, "POST", "/lists", body)).body.ranking, true);
      assert.equal((await lock(person.uid).get()).exists, false);
      const old = [Date.now() - 1000];
      await lock(person.uid).set({ publicListEvents: old });
      assert.equal((await call(person.token, "POST", "/lists", draft())).status, 201);
      assert.deepEqual(await events(person.uid), old, "OFF must not add or erase rolling history");
    });
  } else {
    it("charges a new list once, returns a full-quota retry, updates freely and never refunds a delete/recreate", async () => {
      const person = await account();
      const body = draft();
      const first = await call(person.token, "POST", "/lists", body);
      assert.equal(first.status, 201, JSON.stringify(first));
      const second = await call(person.token, "POST", "/lists", draft());
      assert.equal(second.status, 201, JSON.stringify(second));
      const history = (await events(person.uid))!;
      assert.equal(history.length, limit);
      const full = await refused(person.token, draft());
      assert.equal(full.status, 409); assert.equal(full.body.code, "TOO_MANY_LISTS");
      assert.equal(full.body.retryAt, history[0] + PUBLIC_LIST_WINDOW_MS);
      assert.ok(Number(full.retryAfter) > 0);
      const retry = await call(person.token, "POST", "/lists", body);
      assert.deepEqual(retry, { status: 200, body: { id: first.body.id, topicId: null, existing: true, revision: 1 } });
      assert.equal((await call(person.token, "POST", `/lists/${first.body.id}`, { ...body, title: "Updated" })).status, 200);
      assert.deepEqual(await events(person.uid), history);
      assert.equal((await call(person.token, "DELETE", `/lists/${first.body.id}`)).status, 204);
      assert.equal((await call(person.token, "POST", "/lists", body)).status, 409);
      assert.deepEqual(await events(person.uid), history);
    });

    it("atomically admits only N of many different parallel boards", async () => {
      const person = await account();
      const replies = await Promise.all(Array.from({ length: 8 }, () => call(person.token, "POST", "/lists", draft())));
      assert.equal(replies.filter((answer) => answer.status === 201).length, limit, JSON.stringify(replies));
      assert.ok(replies.every((answer) => answer.status === 201 || (answer.status === 409 && answer.body.code === "TOO_MANY_LISTS")), JSON.stringify(replies));
      assert.equal((await events(person.uid))!.length, limit);
      assert.equal((await lists(person.uid).get()).size, limit);
    });

    it("parallel retries of one board share one list and one event", async () => {
      const person = await account();
      const body = draft();
      const replies = await Promise.all(Array.from({ length: 8 }, () => call(person.token, "POST", "/lists", body)));
      assert.ok(replies.every((answer) => answer.status === 200 || answer.status === 201), JSON.stringify(replies));
      assert.equal(new Set(replies.map((answer) => answer.body.id)).size, 1);
      assert.equal((await events(person.uid))!.length, 1);
      assert.equal((await lists(person.uid).get()).size, 1);
    });

    it("expires synthetic seven-day history and allows new publication while fifty older public lists remain", async () => {
      const person = await account();
      await oldLists(person.uid, 50);
      const past = Date.now() - PUBLIC_LIST_WINDOW_MS - 1000;
      await lock(person.uid).set({ publicListEvents: [past - 1000, past] });
      assert.equal((await call(person.token, "POST", "/lists", draft())).status, 201);
      assert.equal((await lists(person.uid).get()).size, 51);
      assert.equal((await events(person.uid))!.length, 1);
      assert.ok((await events(person.uid))![0] > past + PUBLIC_LIST_WINDOW_MS);
      assert.equal((await call(person.token, "POST", "/lists", draft())).status, 201);
      assert.equal((await call(person.token, "POST", "/lists", draft())).status, 409);
      assert.equal((await lists(person.uid).get()).size, 52);
    });

    it("refuses without changing retained history and reports the correct retry after a policy reduction", async () => {
      const person = await account();
      const now = Date.now();
      const history = [now - 3000, now - 2000, now - 1000];
      await lock(person.uid).set({ publicListEvents: history });
      const answer = await refused(person.token, draft());
      assert.equal(answer.status, 409);
      assert.equal(answer.body.retryAt, history[history.length - limit] + PUBLIC_LIST_WINDOW_MS);
      assert.deepEqual(await events(person.uid), history);
      assert.equal((await lists(person.uid).get()).size, 0);
    });

    it("keeps a full quota refused when committed demo events are one minute ahead of this instance", async () => {
      const person = await account();
      const future = Date.now() + 60_000;
      const history = [future, future + 1000];
      await lock(person.uid).set({ publicListEvents: history });
      const answer = await refused(person.token, draft());
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, "TOO_MANY_LISTS");
      assert.equal(answer.body.retryAt, future + PUBLIC_LIST_WINDOW_MS);
      assert.deepEqual(await events(person.uid), history, "a clock behind another writer cannot discard its committed history");
      assert.equal((await lists(person.uid).get()).size, 0);
    });

    it("private boards, preflight, both Ranking APIs and withdraw remain available at a full quota", async () => {
      const person = await account();
      const history = [Date.now() - 2000, Date.now() - 1000];
      await lock(person.uid).set({ publicListEvents: history });
      const original = await source();
      const body = { ...draft(), ...original };
      assert.equal((await call(person.token, "POST", "/lists/classify", body)).body.kind, "ranking");
      const privateBoard = { title: body.title, fingerprint: "private", takenFrom: original.takenFrom, origin: { listId: original.takenFrom, version: original.sourceVersion }, rankingChoice: "private", tiers: [{ uid: "a", position: 0, ...TIERS[0] }], items: [{ uid: "card", tierUid: "a", position: 0, title: "Card", imageUrl: null, sourceIndex: 0 }] };
      assert.equal((await call(person.token, "PUT", `/boards/${body.boardUid}`, privateBoard)).status, 200);
      assert.equal((await call(person.token, "POST", "/lists", body)).body.ranking, true);
      const ranking = await call(person.token, "PUT", `/lists/${original.takenFrom}/rankings/mine`, { arrangement: [0], rows: [[0]], tierLabels: ["A"], version: original.sourceVersion });
      assert.equal(ranking.status, 200, JSON.stringify(ranking));
      assert.equal((await call(person.token, "DELETE", `/lists/${original.takenFrom}/rankings/mine`)).status, 204);
      assert.equal((await call(person.token, "GET", `/boards/${body.boardUid}`)).body.rankingChoice, "private");
      assert.deepEqual(await events(person.uid), history);
      assert.equal((await lists(person.uid).get()).size, 0);
      // A changed source copy is the reader's ranking to show, never a list of their own (since 14.11.2026).
      const derivative = await call(person.token, "POST", "/lists", { ...body, title: "Changed title" });
      assert.equal(derivative.status, 409); assert.equal(derivative.body.code, "RANK_INSTEAD");
      assert.deepEqual(await events(person.uid), history);
    });

    it("failed validation/source-version checks and retry claims from another author cannot spend or bypass a slot", async () => {
      const person = await account();
      assert.equal((await call(person.token, "POST", "/lists", { ...draft(), tiers: [] })).status, 400);
      const original = await source();
      assert.equal((await call(person.token, "POST", "/lists", { ...draft(), ...original, sourceVersion: original.sourceVersion - 1 })).status, 409);
      assert.equal((await lock(person.uid).get()).exists, false);
      const first = await call(person.token, "POST", "/lists", draft("same-on-two-accounts"));
      assert.equal(first.status, 201);
      assert.equal((await events(person.uid))!.length, 1);
      const another = await account();
      const theirs = await call(another.token, "POST", "/lists", draft("same-on-two-accounts"));
      assert.equal(theirs.status, 201); assert.notEqual(theirs.body.id, first.body.id);
      assert.equal((await events(another.uid))!.length, 1);
    });

    it("keeps editorial publication exempt from the personal rolling quota", async () => {
      const owner = await ownerToken();
      for (let i = 0; i <= limit; i++) {
        const answer = await call(owner, "POST", "/lists/editorial", draft());
        assert.equal(answer.status, 201, JSON.stringify(answer));
      }
      assert.equal((await lock(EDITORIAL_UID).get()).exists, false);
      assert.equal((await lock(OWNER.uid).get()).exists, false);
    });
  }
});
