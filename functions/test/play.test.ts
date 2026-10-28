import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toFullBoard } from "../src/boards";
import {
  decideStore,
  livePlay,
  MAX_BOARD_BYTES,
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

const store = (body: unknown) => decideStore({ body, isAnonymous: false, boardsAlreadyKept: 0, nowMs: NOW });

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
  // Counted from the last time this service stored it, not from when it started: a month-long game that is still being played lives.
  it("hands back a game written within the last month, and not one written longer ago", () => {
    const game = readPlay(play({ startedAt: NOW - 3 * PLAY_LIFETIME_MS })) as Play;
    assert.equal(livePlay({ play: game, touchedAt: NOW - PLAY_LIFETIME_MS }, NOW), game);
    assert.equal(livePlay({ play: game, touchedAt: NOW - PLAY_LIFETIME_MS - 1 }, NOW), null);
    assert.equal(livePlay(null, NOW), null);
  });
});

describe("a game in storage", () => {
  it("keeps its answers flat, since Firestore keeps no array inside an array, with the time it was stored", () => {
    const stored = playToDocument(readPlay(play()) as Play, NOW);
    assert.deepEqual(stored.history, [0, 1, 1, 2, 3, -1]);
    assert.ok(stored.history.every((one) => typeof one === "number"));
    assert.equal(stored.touchedAt, NOW);
  });

  it("reads back as it went in, with when it was stored", () => {
    const game = readPlay(play()) as Play;
    assert.deepEqual(playFromDocument(playToDocument(game, NOW)), { play: game, touchedAt: NOW });
  });

  it("counts a game stored before the stamp existed from when it started", () => {
    const game = readPlay(play()) as Play;
    const { touchedAt: _none, ...older } = playToDocument(game, NOW);
    assert.deepEqual(playFromDocument(older), { play: game, touchedAt: game.startedAt });
  });

  it("is nothing when what is stored is not a game any more", () => {
    assert.equal(playFromDocument(undefined), null);
    assert.equal(playFromDocument({ ...playToDocument(readPlay(play()) as Play, NOW), history: [0, 1] }), null);
  });
});

describe("decideStore and the clock", () => {
  it("never keeps a game started after now", () => {
    const decision = store(board({ play: play({ startedAt: NOW + 60_000 }) }));
    assert.equal(decision.ok && decision.board.play?.startedAt, NOW);
  });

  it("keeps a game started before now as it is", () => {
    const decision = store(board({ play: play({ startedAt: NOW - 1000 }) }));
    assert.equal(decision.ok && decision.board.play?.startedAt, NOW - 1000);
  });
});

describe("decideStore and the weight of a game", () => {
  // A board just under the ceiling, so its game is what would tip it over.
  function heavyBoard(spare: number) {
    const base = board({ items: [] });
    const items: unknown[] = [];
    // Weighed as stored, which is what the ceiling is about; long addresses fill it quickly.
    const weight = () => {
      const decision = store({ ...base, items });
      return decision.ok ? JSON.stringify(decision.board).length : Infinity;
    };
    for (let at = 0; weight() < MAX_BOARD_BYTES - spare - 2500; at++) {
      items.push({ uid: `item-${at}`, tierUid: "tier-1", position: at, title: "Card", imageUrl: `https://img.test/${"x".repeat(1800)}/${at}` });
    }
    return { ...base, items };
  }

  it("leaves a game behind rather than the board when the two are too heavy together", () => {
    const answers = Array.from({ length: MAX_PLAY_HISTORY }, () => [0, 1, 0]);
    const decision = store({ ...heavyBoard(500), play: play({ history: answers }) });
    assert.equal(decision.ok, true);
    assert.equal(decision.ok && "play" in decision.board, false);
  });

  it("keeps a game that fits", () => {
    const decision = store({ ...heavyBoard(20_000), play: play() });
    assert.equal(decision.ok && decision.board.play?.kind, "swiss");
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
    assert.deepEqual(toFullBoard("b1", { ...stored, play: playToDocument(game, NOW - 1000) }, NOW).play, game);
  });

  it("leaves out a game nobody stored for a month, as if there were none", () => {
    const game = readPlay(play()) as Play;
    assert.equal("play" in toFullBoard("b1", { ...stored, play: playToDocument(game, NOW - PLAY_LIFETIME_MS - 1) }, NOW), false);
  });

  it("never hands the stamp back to the device", () => {
    const game = readPlay(play()) as Play;
    assert.equal("touchedAt" in (toFullBoard("b1", { ...stored, play: playToDocument(game, NOW) }, NOW).play as object), false);
  });
});

describe("a board published without its author's name", () => {
  it("keeps anonymous only when it is true", () => {
    const decision = store(board({ anonymous: true }));
    assert.equal(decision.ok && decision.board.anonymous, true);
  });

  it("stores nothing for false, or for anything that is not a boolean", () => {
    for (const anonymous of [false, "true", 1, null]) {
      const decision = store(board({ anonymous }));
      assert.equal(decision.ok && "anonymous" in decision.board, false, String(anonymous));
    }
  });

  it("is handed back as true, and a board without it is handed back without it", () => {
    const stored = {
      revision: 1,
      deviceName: null,
      deleted: false,
      title: "Sci-fi films",
      tiers: [],
      items: [],
    };
    assert.equal(toFullBoard("b1", { ...stored, anonymous: true }, NOW).anonymous, true);
    assert.equal("anonymous" in toFullBoard("b1", stored, NOW), false);
  });

  it("does not change the answer for a board stored before it existed, byte for byte", () => {
    const decision = store(board());
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    const { play: _none, ...kept } = decision.board;
    const stored = { ...kept, revision: 2, deviceName: null, deleted: false };
    assert.equal(
      JSON.stringify(toFullBoard("b1", stored, NOW)),
      JSON.stringify({
        uid: "b1",
        revision: 2,
        updatedAt: 0,
        deviceName: null,
        deleted: false,
        fingerprint: null,
        title: "Sci-fi films",
        displayMode: "RANKED",
        category: null,
        coverImageUrl: null,
        coverImageUrls: [],
        authorName: null,
        publishedId: null,
        deletedAt: null,
        tiers: decision.board.tiers,
        items: decision.board.items,
      }),
    );
  });
});

describe("a game's scope", () => {
  const tiers = (n: number) => Array.from({ length: n }, (_, at) => `tier-${at}`);

  it("keeps the tiers a game was drawn from, one to sixty-four of them", () => {
    assert.deepEqual(readPlay(play({ scope: ["tier-1"] }))?.scope, ["tier-1"]);
    assert.deepEqual(readPlay(play({ scope: tiers(MAX_PLAY_CARDS) }))?.scope, tiers(MAX_PLAY_CARDS));
  });

  it("is the whole board when there is none", () => {
    const game = readPlay(play()) as Play;
    assert.equal("scope" in game, false);
    assert.equal("keepTier" in game, false);
    assert.equal("scope" in (readPlay(play({ scope: null })) as Play), false);
  });

  it("drops the whole game for a scope that is not one", () => {
    for (const scope of [[], tiers(MAX_PLAY_CARDS + 1), ["tier-1", "tier-1"], ["tier-1", ""], "tier-1", [7]]) {
      assert.equal(readPlay(play({ scope })), null, JSON.stringify(scope));
    }
  });

  it("keeps the result in its tier only for a game drawn from exactly one tier, and only as true", () => {
    assert.equal(readPlay(play({ scope: ["tier-1"], keepTier: true }))?.keepTier, true);
    assert.equal("keepTier" in (readPlay(play({ scope: ["tier-1", "tier-2"], keepTier: true })) as Play), false);
    assert.equal("keepTier" in (readPlay(play({ keepTier: true })) as Play), false);
    assert.equal("keepTier" in (readPlay(play({ scope: ["tier-1"], keepTier: false })) as Play), false);
    assert.equal("keepTier" in (readPlay(play({ scope: ["tier-1"], keepTier: "true" })) as Play), false);
  });

  it("is stored with the game and read back", () => {
    const game = readPlay(play({ scope: ["tier-1"], keepTier: true })) as Play;
    assert.deepEqual(playFromDocument(playToDocument(game, NOW)), { play: game, touchedAt: NOW });
  });

  it("leaves a game without one stored exactly as before", () => {
    const stored = playToDocument(readPlay(play()) as Play, NOW);
    assert.deepEqual(Object.keys(stored), ["kind", "count", "seed", "refine", "ids", "history", "round", "startedAt", "touchedAt"]);
  });
});

describe("the shared example game", () => {
  // The same game the app and the website keep in their own suites, in the shared format.
  const example = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "shared-play-example.json"), "utf-8"));

  it("is read whole", () => {
    assert.deepEqual(readPlay(example), example);
  });

  it("is stored and read back equal, all but the stamp", () => {
    const stored = playToDocument(readPlay(example) as Play, example.startedAt + 1000);
    assert.ok(stored.history.every((one) => typeof one === "number"));
    const kept = playFromDocument(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(kept?.play, example);
  });

  it("comes back to a device unchanged, through a stored board", () => {
    const decision = store(board({ play: example }));
    assert.equal(decision.ok, true);
    if (!decision.ok || !decision.board.play) return;
    const { play: game, ...rest } = decision.board;
    const document = { ...rest, revision: 1, deviceName: null, deleted: false, play: playToDocument(game, example.startedAt) };
    assert.deepEqual(toFullBoard("b1", document, example.startedAt + 1000).play, example);
  });
});
