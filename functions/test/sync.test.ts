import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_BOARDS_PER_ACCOUNT,
  MAX_ITEMS_PER_BOARD,
  MAX_TIERS_PER_BOARD,
  decideStore,
  decideWrite,
} from "../src/sync";

const TIER_UID = "tier-1";
const POOL_UID = "tier-pool";

function body(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sci-fi films",
    displayMode: "RANKED",
    tiers: [
      {
        uid: TIER_UID,
        position: 0,
        label: "S",
        caption: "Masterpiece",
        colorLight: "#B03A32",
        colorDark: "#F1948C",
      },
      {
        uid: POOL_UID,
        position: 1,
        label: "Pool",
        colorLight: "#3A3A3A",
        colorDark: "#CFCFCF",
        isPool: true,
      },
    ],
    items: [
      {
        uid: "item-1",
        tierUid: TIER_UID,
        position: 0,
        title: "Arrival",
        imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg",
        source: "TMDB",
      },
    ],
    ...overrides,
  };
}

function store(
  overrides: Record<string, unknown> = {},
  extras: Partial<{ isAnonymous: boolean; boardsAlreadyKept: number }> = {},
) {
  return decideStore({
    body: body(overrides),
    isAnonymous: false,
    boardsAlreadyKept: 0,
    ...extras,
  });
}

describe("decideStore", () => {
  it("keeps a board whole, tiers and cards and where each card sits", () => {
    const decision = store();

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.board.title, "Sci-fi films");
    assert.equal(decision.board.displayMode, "RANKED");
    assert.equal(decision.board.tiers.length, 2);
    assert.equal(decision.board.tiers[1].isPool, true);
    assert.equal(decision.board.items[0].tierUid, TIER_UID);
  });

  // The whole point of keeping a board is being able to find it again from
  // another phone, and an anonymous identity cannot be signed back into.
  it("refuses a guest", () => {
    const decision = store({}, { isAnonymous: true });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "not_signed_in");
  });

  // Someone who built the tiers and got as far as the shop is exactly the
  // person whose work should survive the phone.
  it("keeps a board that has no cards yet", () => {
    const decision = store({ items: [] });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.items.length, 0);
  });

  it("keeps cards that are in the trash, and says so", () => {
    const decision = store({
      items: [
        { uid: "item-1", tierUid: TIER_UID, position: 0, title: "Arrival", deletedAt: 1_700_000_000_000 },
      ],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.items[0].deletedAt, 1_700_000_000_000);
  });

  it("keeps a board that is itself in the trash", () => {
    const decision = store({ deletedAt: 1_700_000_000_000 });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.deletedAt, 1_700_000_000_000);
  });

  // A file on the old phone cannot be found from the new one. Coming back
  // without that card's picture beats not coming back.
  it("drops a picture that only exists on the device", () => {
    const decision = store({
      items: [
        { uid: "item-1", tierUid: TIER_UID, position: 0, title: "Arrival", imageUrl: "file:///data/a.jpg" },
      ],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.items[0].imageUrl, null);
  });

  // A card pointing at a tier that is not here would come back invisible,
  // which reads as losing it rather than as a bad write.
  it("refuses a card that names a tier the board does not have", () => {
    const decision = store({
      items: [{ uid: "item-1", tierUid: "somewhere-else", position: 0, title: "Arrival" }],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses two tiers with the same id", () => {
    const decision = store({
      tiers: [
        { uid: TIER_UID, position: 0, label: "S", colorLight: "#B03A32", colorDark: "#F1948C" },
        { uid: TIER_UID, position: 1, label: "A", colorLight: "#B0763A", colorDark: "#F1C68C" },
      ],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses two cards with the same id", () => {
    const decision = store({
      items: [
        { uid: "item-1", tierUid: TIER_UID, position: 0, title: "Arrival" },
        { uid: "item-1", tierUid: TIER_UID, position: 1, title: "Dune" },
      ],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses a tier with no id", () => {
    const decision = store({
      tiers: [{ position: 0, label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
      items: [],
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses a board with no title", () => {
    const decision = store({ title: "   " });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "invalid");
  });

  it("refuses more tiers than a board can have", () => {
    const tiers = Array.from({ length: MAX_TIERS_PER_BOARD + 1 }, (_unused, index) => ({
      uid: `tier-${index}`,
      position: index,
      label: `T${index}`,
      colorLight: "#B03A32",
      colorDark: "#F1948C",
    }));
    const decision = store({ tiers, items: [] });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "too_large");
  });

  it("refuses more cards than a board can have", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_BOARD + 1 }, (_unused, index) => ({
      uid: `item-${index}`,
      tierUid: TIER_UID,
      position: index,
      title: "Arrival",
    }));
    const decision = store({ items });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "too_large");
  });

  // A count of cards cannot express weight: two hundred with very long
  // addresses outweigh a thousand with short ones.
  it("refuses a board that is too heavy even with few cards", () => {
    const items = Array.from({ length: 400 }, (_unused, index) => ({
      uid: `item-${index}`,
      tierUid: TIER_UID,
      position: index,
      title: "A".repeat(80),
      imageUrl: `https://example.com/${"b".repeat(1900)}-${index}.jpg`,
    }));
    const decision = store({ items });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "too_large");
  });

  it("refuses an account that is already keeping its fill", () => {
    const decision = store({}, { boardsAlreadyKept: MAX_BOARDS_PER_ACCOUNT });

    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.reason, "too_many_boards");
  });

  // Opaque: a device's own digest, handed back untouched so a database that
  // came home from a system backup can tell one board from two.
  // A picture of this person's own. The path around the file means nothing on
  // a second phone, so only the name travels.
  it("keeps a card's own picture by name", () => {
    const decision = store({
      items: [{ uid: "item-1", tierUid: TIER_UID, position: 0, title: "Me at the beach", pictureId: "abc-123" }],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.items[0].pictureId, "abc-123");
  });

  // The id is concatenated into a storage path, so anything that could climb
  // out of one is not an id.
  it("refuses a picture name that could walk out of its folder", () => {
    const decision = store({
      items: [{ uid: "item-1", tierUid: TIER_UID, position: 0, title: "Arrival", pictureId: "../../secrets" }],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.items[0].pictureId, null);
  });

  it("keeps the device's fingerprint as it was given", () => {
    const decision = store({ fingerprint: "a1b2c3" });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.fingerprint, "a1b2c3");
  });

  it("keeps a board that brings no fingerprint at all", () => {
    const decision = store({ fingerprint: undefined });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.fingerprint, null);
  });

  it("falls back to a wrapping board and a manual card rather than refusing", () => {
    const decision = store({
      displayMode: "SOMETHING_ELSE",
      items: [{ uid: "item-1", tierUid: TIER_UID, position: 0, title: "Arrival", source: "???" }],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.ok && decision.board.displayMode, "WRAP");
    assert.equal(decision.ok && decision.board.items[0].source, "MANUAL");
  });
});

describe("decideWrite", () => {
  const held = (revision: number, fingerprint: string | null = "theirs") => ({ revision, fingerprint });

  // The same board arriving on a second device is the same board, not a fight.
  it("creates when the account has never seen the board", () => {
    assert.equal(decideWrite(null, null, "ours"), "create");
  });

  it("updates when the device was working from what is stored", () => {
    assert.equal(decideWrite(held(4), 4, "ours"), "update");
  });

  // The order of the cards is the content, so there is no arithmetic that
  // merges two afternoons. Both are kept instead.
  it("calls it a conflict when the account moved on", () => {
    assert.equal(decideWrite(held(5), 4, "ours"), "conflict");
  });

  it("calls it a conflict when the device says nothing about what it saw", () => {
    assert.equal(decideWrite(held(5), null, "ours"), "conflict");
    assert.equal(decideWrite(held(5), undefined, "ours"), "conflict");
    assert.equal(decideWrite(held(5), "5", "ours"), "conflict");
  });

  // The bug this was written for. A phone uploads, the account stores it and
  // answers, and the phone dies before it can write the new revision down. It
  // comes back quoting the old one, which by the numbers is a stranger's edit
  // -- and it was dutifully keeping a second copy of its own board.
  it("knows its own answer coming back, when the content is unchanged", () => {
    assert.equal(decideWrite(held(5, "same"), 4, "same"), "already");
  });

  it("still calls it a conflict when the content really did change", () => {
    assert.equal(decideWrite(held(5, "theirs"), 4, "ours"), "conflict");
  });

  // Two boards nobody has ever fingerprinted are not thereby the same board.
  it("will not call two unfingerprinted boards the same board", () => {
    assert.equal(decideWrite(held(5, null), 4, null), "conflict");
  });
});
