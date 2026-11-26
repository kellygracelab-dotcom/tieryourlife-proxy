import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { handlePublishAfter, PUBLISH_AFTER_JOBS, PUBLISH_AFTER_TRIES, publishAfterJobId, queuePublishAfter, readPublishAfterJob, type PublishAfterJob, type PublishAfterWork } from "../src/publishAfter";

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

  it("throws a failure for the retry, and after three writes one ERROR line and stops", async () => {
    const errors: unknown[][] = [];
    mock.method(console, "error", (...line: unknown[]) => void errors.push(line));
    await queuePublishAfter(JOB);
    failing = 99;
    for (let attempt = 1; attempt <= PUBLISH_AFTER_TRIES; attempt++) {
      await assert.rejects(handlePublishAfter(job() as never, work), /Firestore said no/);
      assert.equal(fakes.db.docs.get(PATH)?.attempts, attempt);
    }
    assert.equal(await handlePublishAfter(job() as never, work), "gave up");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]![0], "Publish after failed");
    assert.match(String(errors[0]![1]), /"tries":3/);
    assert.notEqual(fakes.db.docs.get(PATH)?.gaveUpAt, undefined);
    assert.equal(await handlePublishAfter(job() as never, work), "missing", "no retries after giving up");
    assert.equal(errors.length, 1);
  });

  it("succeeds on a retry after a failure", async () => {
    await queuePublishAfter(JOB);
    failing = 1;
    await assert.rejects(handlePublishAfter(job() as never, work));
    assert.equal(await handlePublishAfter(job() as never, work), "done");
    assert.ok(done.includes("credits L1 false author Ann"));
  });

  it("gives up at once on a job it cannot read", async () => {
    mock.method(console, "error", () => undefined);
    await fakes.db.doc(PATH).set({ listId: "L1", revision: "four" });
    assert.equal(await handlePublishAfter(job() as never, work), "gave up");
    assert.deepEqual(done, []);
  });
});
