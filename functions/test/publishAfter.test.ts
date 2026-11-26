import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { Timestamp } from "firebase-admin/firestore";
import { handlePublishAfter, PUBLISH_AFTER_JOBS, PUBLISH_AFTER_LEFT_MS, PUBLISH_AFTER_TRIES, publishAfterJobId, publishAfterLeftovers, queuePublishAfter, readPublishAfterJob, type PublishAfterJob, type PublishAfterWork } from "../src/publishAfter";

const JOB: PublishAfterJob = {
  listId: "L1",
  revision: 4,
  keep: ["a_p_1", "b_p_1"],
  previous: ["a_p_1", "old_p_1"],
  credits: { anonymous: false, authorUid: "author", authorName: "Ann" },
};
const PATH = `${PUBLISH_AFTER_JOBS}/${publishAfterJobId("L1", 4)}`;

let fakes: Fakes;
let done: string[];
let failing: number;
let list: { revision: number; names: string[] } | null;

const work: PublishAfterWork = {
  async readList() {
    return list;
  },
  async syncCredits(listId, anonymous, authorUid, authorName) {
    if (failing-- > 0) throw new Error("Firestore said no");
    done.push(`credits ${listId} ${anonymous} ${authorUid} ${authorName}`);
  },
  async retire(listId, keeping, candidates) {
    done.push(`retire ${listId} keep ${[...keeping].sort().join(",")} from ${candidates.join(",")}`);
  },
};
const job = () => fakes.db.collection(PUBLISH_AFTER_JOBS).doc(publishAfterJobId("L1", 4));
/** No pauses between tries in tests. */
const NO_PAUSES = [0, 0, 0];

beforeEach(() => {
  fakes = install();
  done = [];
  failing = 0;
  list = { revision: 4, names: ["a_p_1", "b_p_1"] };
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

describe("an Update's credits and retiring after its answer (26.11.2026)", () => {
  it("queues one job per list and revision, however often it is queued", async () => {
    assert.equal(await queuePublishAfter(JOB), true);
    await fakes.db.doc(PATH).update({ attempts: 1 });
    assert.equal(await queuePublishAfter(JOB), true);
    assert.equal(fakes.db.docs.get(PATH)?.attempts, 1, "the job already there is left as it is");
    assert.deepEqual(readPublishAfterJob(fakes.db.docs.get(PATH)), JOB);
  });

  it("credits and retires, keeping what the list names now as well, then removes the job", async () => {
    await queuePublishAfter(JOB);
    list = { revision: 4, names: ["b_p_1", "cover_p_1"] };
    assert.equal(await handlePublishAfter(job() as never, work), "done");
    assert.deepEqual(done.sort(), ["credits L1 false author Ann", "retire L1 keep a_p_1,b_p_1,cover_p_1 from a_p_1,old_p_1"]);
    assert.equal(fakes.db.docs.has(PATH), false);
    assert.equal(await handlePublishAfter(job() as never, work), "missing", "delivered twice, done once");
    assert.equal(done.length, 2);
  });

  it("leaves the credits to a later revision's job, and does nothing for a list taken down", async () => {
    await queuePublishAfter(JOB);
    list = { revision: 5, names: ["c_p_1"] };
    assert.equal(await handlePublishAfter(job() as never, work), "done");
    assert.deepEqual(done, ["retire L1 keep a_p_1,b_p_1,c_p_1 from a_p_1,old_p_1"]);
    done = [];
    await queuePublishAfter(JOB);
    list = null;
    assert.equal(await handlePublishAfter(job() as never, work), "gone");
    assert.deepEqual(done, []);
    assert.equal(fakes.db.docs.has(PATH), false);
  });

  it("tries three times, then writes one ERROR line and stops, without throwing", async () => {
    const errors: unknown[][] = [];
    const warnings: unknown[][] = [];
    mock.method(console, "error", (...line: unknown[]) => void errors.push(line));
    mock.method(console, "warn", (...line: unknown[]) => void warnings.push(line));
    await queuePublishAfter(JOB);
    failing = 99;
    assert.equal(await handlePublishAfter(job() as never, work, NO_PAUSES), "gave up");
    assert.equal(warnings.length, PUBLISH_AFTER_TRIES, "one warning per failed try");
    assert.equal(fakes.db.docs.get(PATH)?.attempts, PUBLISH_AFTER_TRIES + 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]![0], "Publish after failed");
    assert.match(String(errors[0]![1]), /"tries":3/);
    assert.notEqual(fakes.db.docs.get(PATH)?.gaveUpAt, undefined);
    assert.equal(await handlePublishAfter(job() as never, work, NO_PAUSES), "missing", "no tries after giving up");
    assert.equal(errors.length, 1);
  });

  it("succeeds on the next try after a failure, in the same run", async () => {
    mock.method(console, "warn", () => undefined);
    await queuePublishAfter(JOB);
    failing = 1;
    assert.equal(await handlePublishAfter(job() as never, work, NO_PAUSES), "done");
    assert.ok(done.includes("credits L1 false author Ann"));
    assert.equal(fakes.db.docs.has(PATH), false);
  });

  it("takes up a job left by a run that stopped, but not a fresh one or one given up", async () => {
    const now = Date.now();
    const old = Timestamp.fromMillis(now - PUBLISH_AFTER_LEFT_MS - 1000);
    await fakes.db.doc(PATH).set({ ...JOB, attempts: 1, queuedAt: old });
    await fakes.db.doc(`${PUBLISH_AFTER_JOBS}/${publishAfterJobId("L1", 5)}`).set({ ...JOB, revision: 5, attempts: 0, queuedAt: Timestamp.fromMillis(now) });
    await fakes.db.doc(`${PUBLISH_AFTER_JOBS}/${publishAfterJobId("L1", 3)}`).set({ ...JOB, revision: 3, attempts: 4, queuedAt: old, gaveUpAt: old });
    assert.equal(await publishAfterLeftovers(work, now), 1);
    assert.equal(fakes.db.docs.has(PATH), false);
    assert.equal(fakes.db.docs.has(`${PUBLISH_AFTER_JOBS}/${publishAfterJobId("L1", 5)}`), true, "the fresh one is its trigger's");
    assert.equal(fakes.db.docs.has(`${PUBLISH_AFTER_JOBS}/${publishAfterJobId("L1", 3)}`), true);
    assert.ok(done.includes("credits L1 false author Ann"));
  });

  it("gives up at once on a job it cannot read", async () => {
    mock.method(console, "error", () => undefined);
    await fakes.db.doc(PATH).set({ listId: "L1", revision: "four" });
    assert.equal(await handlePublishAfter(job() as never, work), "gave up");
    assert.deepEqual(done, []);
  });
});
