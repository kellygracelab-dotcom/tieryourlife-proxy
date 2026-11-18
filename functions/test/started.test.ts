import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOCK_AHEAD_MS,
  changedAtOf,
  decideRemoval,
  decideStartedWrite,
  evicted,
  MAX_STARTED_PER_ACCOUNT,
  nextVersion,
  readListId,
  readRemovalReason,
  readStartedBody,
  removalDocument,
  toStartedDocument,
  toStartedWire,
} from "../src/started";
import { PLAY_LIFETIME_MS } from "../src/sync";

const NOW = 1_800_000_000_000;

function body(some: Record<string, unknown> = {}) {
  return {
    basedOn: null,
    changedAt: NOW - 10,
    listVersion: NOW - 100_000,
    itemCount: 45,
    tierCount: 5,
    title: "Game of Thrones characters",
    picture: "https://example.test/cover.jpg",
    pictures: ["https://example.test/1.jpg"],
    category: "film_tv",
    rows: [[3, 7], [1], [], [12], []],
    poolOrder: [0, 2, 4, 5],
    play: null,
    ...some,
  };
}

const listPlay = (some: Record<string, unknown> = {}) => ({
  kind: "swiss",
  count: 3,
  seed: 9,
  refine: false,
  ids: ["0", "17", "44"],
  history: [[0, 1, 1]],
  round: 1,
  startedAt: NOW - 1000,
  scope: ["pool", "2"],
  ...some,
});

function refused(some: Record<string, unknown>): string | undefined {
  const read = readStartedBody(body(some), NOW);
  return read.ok ? undefined : read.detail;
}

describe("a begun list as a device sends it", () => {
  it("reads the contract's example, with a game over the list's own places", () => {
    const read = readStartedBody(body({ play: listPlay(), labels: ["Best", null, "", null, "Worst"] }), NOW);
    assert.ok(read.ok);
    assert.deepEqual(read.content.rows, [[3, 7], [1], [], [12], []]);
    assert.deepEqual(read.content.labels, ["Best", null, null, null, "Worst"]);
    assert.equal(read.content.play?.ids.join(","), "0,17,44");
    assert.equal(read.basedOn, null);
  });

  it("names the field it refuses", () => {
    assert.equal(refused({ rows: [[1], [1], [], [], []] }), "rows");
    assert.equal(refused({ rows: [[45], [], [], [], []] }), "rows");
    assert.equal(refused({ rows: [[1], [], [], []] }), "rows");
    assert.equal(refused({ rows: [[1.5], [], [], [], []] }), "rows");
    assert.equal(refused({ labels: ["a", "b"] }), "labels");
    assert.equal(refused({ labels: ["x".repeat(61), null, null, null, null] }), "labels");
    assert.equal(refused({ poolOrder: [0, 0] }), "poolOrder");
    assert.equal(refused({ itemCount: 0 }), "itemCount");
    assert.equal(refused({ itemCount: 2001 }), "itemCount");
    assert.equal(refused({ tierCount: 21 }), "tierCount");
    assert.equal(refused({ title: "  " }), "title");
    assert.equal(refused({ title: "x".repeat(201) }), "title");
    assert.equal(refused({ picture: "http://example.test/a.jpg" }), "picture");
    assert.equal(refused({ pictures: ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4"] }), "pictures");
    assert.equal(refused({ category: "x".repeat(65) }), "category");
    assert.equal(refused({ listVersion: -1 }), "listVersion");
    assert.equal(refused({ basedOn: "1" }), "basedOn");
    assert.equal(refused({ changedAt: 0 }), "changedAt");
    assert.equal(refused({ play: { kind: "swiss" } }), "play");
    assert.equal(readStartedBody([], NOW).ok, false);
  });

  it("refuses a game naming a card or a tier the list does not have", () => {
    assert.equal(refused({ play: listPlay({ ids: ["0", "17", "45"] }) }), "play");
    assert.equal(refused({ play: listPlay({ ids: ["0", "17", "card-3"] }) }), "play");
    assert.equal(refused({ play: listPlay({ ids: ["0", "017", "3"] }) }), "play");
    assert.equal(refused({ play: listPlay({ scope: ["5"] }) }), "play");
    assert.equal(refused({ play: listPlay({ scope: ["tier-1"] }) }), "play");
  });

  it("takes a device clock running ahead as the server's", () => {
    assert.equal(changedAtOf(NOW + CLOCK_AHEAD_MS, NOW), NOW + CLOCK_AHEAD_MS);
    assert.equal(changedAtOf(NOW + CLOCK_AHEAD_MS + 1, NOW), NOW);
    const read = readStartedBody(body({ changedAt: NOW + 3_600_000 }), NOW);
    assert.ok(read.ok);
    assert.equal(read.changedAt, NOW);
  });

  it("reads list ids and reasons strictly", () => {
    assert.equal(readListId("AbCdEfGhIjKlMnOpQrSt"), "AbCdEfGhIjKlMnOpQrSt");
    assert.equal(readListId("a/b"), null);
    assert.equal(readListId(""), null);
    assert.equal(readRemovalReason("discard"), "discard");
    assert.equal(readRemovalReason("evicted"), null);
    assert.equal(readRemovalReason(undefined), null);
  });
});

describe("which write lands", () => {
  const stored = { updatedAt: 500, changedAt: 400 };

  it("lands on nothing, on the version the device had, or when changed later", () => {
    assert.equal(decideStartedWrite(null, null, 1), "write");
    assert.equal(decideStartedWrite(stored, 500, 1), "write");
    assert.equal(decideStartedWrite(stored, null, 401), "write");
    assert.equal(decideStartedWrite(stored, 499, 401), "write");
  });

  it("answers an older change on another version with a conflict", () => {
    assert.equal(decideStartedWrite(stored, 499, 400), "conflict");
    assert.equal(decideStartedWrite(stored, null, 300), "conflict");
  });

  it("lets Undo bring back a discarded list from its mark, but not a stale device's write over it", () => {
    const mark = { updatedAt: 600, changedAt: 550, removed: "discard" as const };
    assert.equal(decideStartedWrite(mark, 600, 300), "write");
    assert.equal(decideStartedWrite(mark, 500, 450), "conflict");
  });

  it("removes on the version or a later change, and answers a repeat with the mark", () => {
    assert.equal(decideRemoval(null, null, 1), "write");
    assert.equal(decideRemoval(stored, 500, 1), "write");
    assert.equal(decideRemoval(stored, 499, 400), "write");
    assert.equal(decideRemoval(stored, 499, 399), "conflict");
    assert.equal(decideRemoval({ ...stored, removed: "saved" }, null, 1), "already");
  });

  it("only ever moves the version forward", () => {
    assert.equal(nextVersion(null, NOW), NOW);
    assert.equal(nextVersion(NOW - 5, NOW), NOW);
    assert.equal(nextVersion(NOW, NOW), NOW + 1);
    assert.equal(nextVersion(NOW + 10, NOW), NOW + 11);
  });
});

describe("the fifty", () => {
  const live = (count: number) => Array.from({ length: count }, (_, i) => ({ listId: `list-${i}`, changedAt: 1000 + i }));

  it("pushes out the oldest by the device's time, never the one coming in", () => {
    assert.deepEqual(evicted(live(MAX_STARTED_PER_ACCOUNT - 1), "new"), []);
    assert.deepEqual(evicted(live(MAX_STARTED_PER_ACCOUNT), "new"), ["list-0"]);
    assert.deepEqual(evicted(live(MAX_STARTED_PER_ACCOUNT + 2), "new"), ["list-0", "list-1", "list-2"]);
    assert.deepEqual(evicted(live(MAX_STARTED_PER_ACCOUNT), "list-0"), []);
    assert.deepEqual(evicted([...live(MAX_STARTED_PER_ACCOUNT - 1), { listId: "older", changedAt: 1 }], "new"), ["older"]);
  });
});

describe("a begun list as kept and as told", () => {
  it("keeps rows as Firestore can and gives them back as they came", () => {
    const read = readStartedBody(body({ play: listPlay(), labels: ["S", null, null, null, null] }), NOW);
    assert.ok(read.ok);
    const document = toStartedDocument(read.content, NOW + 1, read.changedAt, NOW);
    assert.deepEqual(document.rows, [{ c: [3, 7] }, { c: [1] }, { c: [] }, { c: [12] }, { c: [] }]);
    assert.equal(document.removed, null);
    assert.equal(JSON.stringify(document).includes("undefined"), false);
    const wire = toStartedWire("list-1", document, NOW);
    assert.ok(!("removed" in wire));
    assert.deepEqual(wire.rows, read.content.rows);
    assert.equal(wire.placed, 4);
    assert.deepEqual(wire.play, read.content.play);
    assert.equal(wire.updatedAt, NOW + 1);
    assert.deepEqual(wire.labels, ["S", null, null, null, null]);
  });

  it("leaves out labels and pool order nobody sent", () => {
    const read = readStartedBody(body({ poolOrder: undefined }), NOW);
    assert.ok(read.ok);
    const document = toStartedDocument(read.content, NOW, NOW, NOW);
    assert.ok(!("labels" in document));
    assert.ok(!("poolOrder" in document));
  });

  it("no longer tells a game a month untouched", () => {
    const read = readStartedBody(body({ play: listPlay() }), NOW);
    assert.ok(read.ok);
    const document = toStartedDocument(read.content, NOW, NOW, NOW);
    const later = toStartedWire("list-1", document, NOW + PLAY_LIFETIME_MS + 1);
    assert.ok(!("removed" in later));
    assert.equal(later.play, null);
  });

  it("tells a removed list as its mark alone", () => {
    assert.deepEqual(toStartedWire("list-1", removalDocument("discard", 9, 8), NOW), { listId: "list-1", updatedAt: 9, changedAt: 8, removed: "discard" });
  });
});
