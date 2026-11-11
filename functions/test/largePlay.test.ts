import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideStore, MAX_BOARD_BYTES, MAX_PLAY_CARDS, MAX_PLAY_HISTORY, playAfterWrite, playFromDocument, playToDocument, preservedPlayFingerprint, readPlay, type Play } from "../src/sync";

function large(count = 91, history = 0): Play {
  return { kind: "swiss", count, seed: 123, refine: true,
    ids: Array.from({ length: count }, (_, i) => `card-${i}`),
    history: Array.from({ length: history }, (_, i) => [i % count, (i + 1) % count, i % 3 === 0 ? null : i % count]),
    round: 1, startedAt: 1_800_000_000_000 };
}

describe("large game wire and storage", () => {
  it("accepts exact odd and large cohorts without clipping or rounding", () => {
    for (const count of [65, 91, 128, 129, 256, 1024, 2000]) {
      const game = large(count, 31);
      assert.deepEqual(readPlay(game), game);
      assert.deepEqual(playFromDocument(playToDocument(game, game.startedAt))?.play, game);
    }
    assert.equal(MAX_PLAY_CARDS, 2000);
    assert.equal(MAX_PLAY_HISTORY, 14000);
    assert.equal(readPlay(large(2001)), null);
  });

  it("round-trips the longest supported history through compact storage, leaving API triples unchanged", () => {
    const game = large(2000, MAX_PLAY_HISTORY);
    const stored = playToDocument(game, game.startedAt);
    assert.equal(stored.historyEncoding, "u16le-v1");
    assert.equal(typeof stored.history, "string");
    assert.ok(Buffer.byteLength(JSON.stringify(stored), "utf8") < MAX_BOARD_BYTES);
    assert.deepEqual(playFromDocument(JSON.parse(JSON.stringify(stored)))?.play, game);
    assert.equal(readPlay({ ...game, history: [...game.history, [0, 1, 0]] }), null);
  });

  it("still reads legacy flat numeric records without migration", () => {
    const game = large(4, 2);
    const stored = playToDocument(game, game.startedAt);
    assert.ok(Array.isArray(stored.history));
    assert.deepEqual(playFromDocument(stored)?.play, game);
  });

  it("rejects damaged encodings and invalid compact indices or winners", () => {
    const stored = playToDocument(large(91, 2001), 1_800_000_000_000);
    for (const bad of ["?", "AAAA", "=".repeat(20), "A".repeat(MAX_PLAY_HISTORY * 8 + 4)]) {
      assert.equal(playFromDocument({ ...stored, history: bad }), null);
    }
    const bytes = Buffer.alloc(6);
    bytes.writeUInt16LE(0, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(2, 4);
    assert.equal(playFromDocument({ ...stored, history: bytes.toString("base64") }), null);
    bytes.writeUInt16LE(91, 2); bytes.writeUInt16LE(65535, 4);
    assert.equal(playFromDocument({ ...stored, history: bytes.toString("base64") }), null);
    assert.equal(playFromDocument({ ...stored, historyEncoding: "unknown" }), null);
  });

  it("preserves a large game omitted by an old editor, but explicit null finishes it permanently", () => {
    const game = large(91, 2001);
    assert.equal(playAfterWrite({ title: "Renamed" }, game), game);
    assert.equal(playAfterWrite({ title: "Renamed", play: null }, game), null);
    assert.equal(playAfterWrite({ title: "Renamed again" }, null), null);
    assert.equal(playAfterWrite({ play: large(128) }, game)?.count, 128);
    // Older clients can still finish their own small legacy games by omitting play.
    assert.equal(playAfterWrite({}, large(4, 2)), null);
  });

  it("fingerprints the retained combined state rather than the legacy writer's incomplete contents", () => {
    const decision = decideStore({ body: { title: "Renamed", fingerprint: "legacy-no-game",
      tiers: [{ uid: "tier-1", position: 0, label: "S", colorLight: "#112233", colorDark: "#445566" }], items: [] },
      isAnonymous: false, boardsAlreadyKept: 0, nowMs: 1_800_000_000_000 });
    assert.ok(decision.ok);
    const game = large(91, 53);
    const fingerprint = preservedPlayFingerprint({}, decision.board, game);
    assert.match(fingerprint!, /^game-v1:[a-f0-9]{64}$/);
    assert.notEqual(fingerprint, "legacy-no-game");
    assert.equal(preservedPlayFingerprint({}, { ...decision.board, fingerprint: "different-opaque" }, game), fingerprint);
    assert.notEqual(preservedPlayFingerprint({}, { ...decision.board, title: "Another" }, game), fingerprint);
    assert.notEqual(preservedPlayFingerprint({}, decision.board, { ...game, history: game.history.slice(1) }), fingerprint);
    assert.equal(preservedPlayFingerprint({ play: null }, decision.board, null), "legacy-no-game");
  });
});
