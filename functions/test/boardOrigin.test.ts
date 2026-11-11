import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { originAfterWrite, originState, sourceIndexAfterWrite } from "../src/boardOrigin";
import { decideStore, preservedPlayFingerprint } from "../src/sync";

describe("private origin and the one-time choice", () => {
  const previous = { origin: { listId: "original", version: 123 }, takenFrom: "original", rankingChoice: "private" as const };
  it("keeps provenance and the decision through legacy writes and explicit nulls", () => {
    assert.deepEqual(originAfterWrite({}, previous), previous);
    assert.deepEqual(originAfterWrite({ origin: null, takenFrom: null, rankingChoice: null }, previous), previous);
    assert.deepEqual(originAfterWrite({ rankingChoice: "offered" }, previous), previous);
    assert.equal(originAfterWrite({ rankingChoice: "ranking" }, previous)?.rankingChoice, "ranking");
  });
  it("validates metadata rather than accepting an ambiguous origin", () => {
    for (const source of [{ origin: { listId: "a/b", version: 1 } }, { origin: { listId: "a", version: -1 } }, { origin: { listId: "a", version: 1 }, takenFrom: "b" }, { rankingChoice: "unasked" }, { rankingChoice: ["private"] }]) assert.equal(originAfterWrite(source, previous), null);
  });
  it("compares only metadata, independently of ordinary card IDs or array order", () => {
    assert.equal(originState({ items: [{ uid: "a" }, { uid: "b" }] }), originState({ items: [{ uid: "other" }] }));
    assert.equal(originState({ items: [{ uid: "a", sourceIndex: 1 }, { uid: "b", sourceIndex: 0 }] }), originState({ items: [{ uid: "b", sourceIndex: 0 }, { uid: "a", sourceIndex: 1 }] }));
  });
  it("keeps item positions for a legacy writer and explicitly clears a replaced card", () => {
    assert.equal(sourceIndexAfterWrite({}, 13), 13);
    assert.equal(sourceIndexAfterWrite({ sourceIndex: null }, 13), null);
    assert.equal(sourceIndexAfterWrite({ sourceIndex: 2 }, 13), 2);
    assert.equal(sourceIndexAfterWrite({ sourceIndex: 2000 }), "invalid");
  });
  it("never rebinds an already known original, including a legacy alias, but lets its version advance", () => {
    assert.equal(originAfterWrite({ origin: { listId: "other", version: 999 }, takenFrom: "other" }, previous), null);
    assert.equal(originAfterWrite({ takenFrom: "other" }, { takenFrom: "original" }), null);
    assert.equal(originAfterWrite({ origin: { listId: "other", version: 999 } }, { takenFrom: "original" }), null);
    assert.equal(originAfterWrite({ origin: { listId: "original", version: 124 } }, previous)?.origin?.version, 124);
    assert.deepEqual(originAfterWrite({ origin: { listId: "original", version: 123 } }), { origin: { listId: "original", version: 123 }, takenFrom: "original" });
  });
  it("cannot hide retained metadata behind an old client's incomplete fingerprint", () => {
    const source = { title: "Board", fingerprint: "legacy", tiers: [{ uid: "t", position: 0, label: "S", colorLight: "#000000", colorDark: "#000000" }], items: [{ uid: "i", tierUid: "t", position: 0, title: "Card" }] };
    const stored = decideStore({ body: source, isAnonymous: false, boardsAlreadyKept: 0, nowMs: 1000, storedOrigin: previous, storedSourceIndexes: new Map([["i", 13]]) });
    assert.ok(stored.ok);
    assert.equal(stored.board.items[0].sourceIndex, 13);
    const hash = preservedPlayFingerprint(source, stored.board, null);
    assert.match(hash!, /^state-v1:[a-f0-9]{64}$/);
    assert.notEqual(hash, preservedPlayFingerprint({ ...source, title: "Renamed" }, { ...stored.board, title: "Renamed" }, null));
    assert.equal(preservedPlayFingerprint({ ...source, ...previous, items: [{ ...source.items[0], sourceIndex: 13 }] }, stored.board, null), "legacy");
    const ordinary = { ...stored.board, origin: undefined, takenFrom: undefined, rankingChoice: undefined, items: stored.board.items.map(({ sourceIndex: _index, ...item }) => item) };
    assert.equal(preservedPlayFingerprint(source, ordinary, null), "legacy");
  });
});
