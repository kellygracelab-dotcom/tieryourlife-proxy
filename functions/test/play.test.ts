import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toFullBoard } from "../src/boards";
import {
  decideStore,
  livePlay,
  MAX_PLAY_CARDS,
  MAX_PLAY_HISTORY,
  PLAY_LIFETIME_MS,
  playFromDocument,
  playToDocument,
  readPlay,
  type Play,
} from "../src/sync";

const NOW = 1_800_000_000_000;

function play(some: Record<string, unknown> = {}) {
  return {
    kind: "swiss",
    count: 4,
    seed: -12345,
    refine: true,
    ids: ["item-1", "item-2", "item-3", "item-4"],
    history: [
      [0, 1, 1],
      [2, 3, null],
    ],
    round: 1,
    startedAt: NOW - 1000,
    ...some,
  };
}

function board(extra: Record<string, unknown> = {}) {
  return {
    title: "Sci-fi films",
    displayMode: "RANKED",
    tiers: [{ uid: "tier-1", position: 0, label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
    items: [{ uid: "item-1", tierUid: "tier-1", position: 0, title: "Arrival", source: "TMDB" }],
    ...extra,
  };
}

const store = (body: unknown) => decideStore({ body, isAnonymous: false, boardsAlreadyKept: 0 });

describe("readPlay", () => {
  it("reads a game whole", () => {
    assert.deepEqual(readPlay(play()), play());
  });

  it("reads each kind, two cards and sixty-four", () => {
    for (const kind of ["swiss", "hill", "bracket"]) assert.equal(readPlay(play({ kind }))?.kind, kind);
    assert.ok(readPlay(play({ count: 2, ids: ["a", "b"], history: [[0, 1, 0]] })));
    const many = Array.from({ length: MAX_PLAY_CARDS }, (_, at) => `item-${at}`);
    assert.ok(readPlay(play({ count: MAX_PLAY_CARDS, ids: many })));
  });

  it("refuses a game whose cards are not two to sixty-four distinct ids counted right", () => {
    assert.equal(readPlay(play({ count: 1, ids: ["a"], history: [] })), null);
    const many = Array.from({ length: MAX_PLAY_CARDS + 1 }, (_, at) => `item-${at}`);
    assert.equal(readPlay(play({ count: MAX_PLAY_CARDS + 1, ids: many })), null);
    assert.equal(readPlay(play({ ids: ["a", "a", "b", "c"] })), null);
    assert.equal(readPlay(play({ ids: ["a", "", "b", "c"] })), null);
    assert.equal(readPlay(play({ count: 3 })), null);
  });

  it("refuses an answer that names one card twice, a card it does not have, or a winner from outside the duel", () => {
    assert.equal(readPlay(play({ history: [[1, 1, 1]] })), null);
    assert.equal(readPlay(play({ history: [[0, 4, 0]] })), null);
    assert.equal(readPlay(play({ history: [[0, 1, 2]] })), null);
    assert.equal(readPlay(play({ history: [[0, 1]] })), null);
    assert.equal(readPlay(play({ history: [[0.5, 1, null]] })), null);
  });

  it("refuses more answers than a game can have", () => {
    const answers = Array.from({ length: MAX_PLAY_HISTORY + 1 }, () => [0, 1, 0]);
    assert.equal(readPlay(play({ history: answers })), null);
  });

  it("refuses a game with any field missing or of the wrong kind", () => {
    assert.equal(readPlay(play({ kind: "league" })), null);
    assert.equal(readPlay(play({ seed: 2 ** 31 })), null);
    assert.equal(readPlay(play({ refine: "yes" })), null);
    assert.equal(readPlay(play({ round: -1 })), null);
    assert.equal(readPlay(play({ startedAt: undefined })), null);
    assert.equal(readPlay("swiss"), null);
    assert.equal(readPlay(null), null);
  });

  it("keeps only the fields a game has", () => {
    assert.equal("extra" in (readPlay(play({ extra: "x" })) as object), false);
  });
});

describe("livePlay", () => {
  it("hands back a game started within the last month, and not one older", () => {
    const fresh = readPlay(play({ startedAt: NOW - PLAY_LIFETIME_MS })) as Play;
    const stale = readPlay(play({ startedAt: NOW - PLAY_LIFETIME_MS - 1 })) as Play;
    assert.equal(livePlay(fresh, NOW), fresh);
    assert.equal(livePlay(stale, NOW), null);
    assert.equal(livePlay(undefined, NOW), null);
  });
});

describe("a game in storage", () => {
  it("keeps its answers flat, since Firestore keeps no array inside an array", () => {
    const stored = playToDocument(readPlay(play()) as Play);
    assert.deepEqual(stored.history, [0, 1, 1, 2, 3, -1]);
    assert.ok(stored.history.every((one) => typeof one === "number"));
  });

  it("reads back as it went in", () => {
    const game = readPlay(play()) as Play;
    assert.deepEqual(playFromDocument(playToDocument(game)), game);
  });

  it("is nothing when what is stored is not a game any more", () => {
    assert.equal(playFromDocument(undefined), null);
    assert.equal(playFromDocument({ ...playToDocument(readPlay(play()) as Play), history: [0, 1] }), null);
  });
});

describe("decideStore with a game", () => {
  it("keeps a valid game with the board", () => {
    const decision = store(board({ play: play() }));
    assert.equal(decision.ok && decision.board.play?.kind, "swiss");
  });

  it("keeps the board and drops a game that is not one", () => {
    const decision = store(board({ play: play({ count: 9 }) }));
    assert.equal(decision.ok, true);
    assert.equal(decision.ok && "play" in decision.board, false);
  });

  it("stores a board without a game exactly as before, with no play field at all", () => {
    const decision = store(board());
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.deepEqual(Object.keys(decision.board), [
      "fingerprint",
      "title",
      "displayMode",
      "category",
      "coverImageUrl",
      "coverImageUrls",
      "authorName",
      "publishedId",
      "deletedAt",
      "tiers",
      "items",
    ]);
  });
});

describe("toFullBoard", () => {
  const stored = {
    revision: 3,
    deviceName: "Pixel 7",
    deleted: false,
    fingerprint: "f",
    title: "Sci-fi films",
    displayMode: "RANKED",
    category: "film_tv",
    coverImageUrl: null,
    coverImageUrls: [],
    authorName: null,
    publishedId: null,
    deletedAt: null,
    tiers: [],
    items: [],
  };

  // The answer a board without a game got before games existed, byte for byte.
  it("hands back a board without a game byte for byte as before", () => {
    assert.equal(
      JSON.stringify(toFullBoard("b1", stored, NOW)),
      JSON.stringify({
        uid: "b1",
        revision: 3,
        updatedAt: 0,
        deviceName: "Pixel 7",
        deleted: false,
        fingerprint: "f",
        title: "Sci-fi films",
        displayMode: "RANKED",
        category: "film_tv",
        coverImageUrl: null,
        coverImageUrls: [],
        authorName: null,
        publishedId: null,
        deletedAt: null,
        tiers: [],
        items: [],
      }),
    );
  });

  it("hands back a game under way with its answers as pairs and a winner again", () => {
    const game = readPlay(play()) as Play;
    assert.deepEqual(toFullBoard("b1", { ...stored, play: playToDocument(game) }, NOW).play, game);
  });

  it("leaves out a game a month old, as if there were none", () => {
    const old = readPlay(play({ startedAt: NOW - PLAY_LIFETIME_MS - 1 })) as Play;
    assert.equal("play" in toFullBoard("b1", { ...stored, play: playToDocument(old) }, NOW), false);
  });
});
