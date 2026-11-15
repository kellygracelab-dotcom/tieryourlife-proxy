import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cropOf, readFocus, type CoverFocus, type Crop } from "../src/coverFocus";
import { decideStore, settleCoverFocus } from "../src/sync";
import { decidePublish, settle } from "../src/publishing";
import { coverFocusAfter, toSummary, toTopic } from "../src/community";
import { newSection, readSectionEdits, sectionView, type SectionRecord } from "../src/sections";

interface Vectors {
  tolerance: number;
  cases: { name: string; width: number; height: number; aspect: number; focus: CoverFocus | null; crop: Crop }[];
  focusValues: { accepted: unknown[]; refused: unknown[] };
}

// The file Web and Android copy into their own tests unchanged.
const vectors = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "cover-crop-vectors.json"), "utf-8")) as Vectors;

const FOCUS: CoverFocus = { x: 0.5, y: 0.2, zoom: 1.5 };

describe("the cover crop", () => {
  it("cuts every shared case the way the file says", () => {
    assert.ok(vectors.cases.length >= 15);
    for (const one of vectors.cases) {
      const crop = cropOf(one.width, one.height, one.aspect, one.focus);
      for (const key of ["x", "y", "width", "height"] as const) {
        assert.ok(Math.abs(crop[key] - one.crop[key]) <= vectors.tolerance, `${one.name}: ${key} ${crop[key]} != ${one.crop[key]}`);
      }
      // Always inside the picture and of the frame's shape.
      assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= one.width + 1e-9 && crop.y + crop.height <= one.height + 1e-9, one.name);
      assert.ok(Math.abs(crop.width / crop.height - one.aspect) < 1e-9, one.name);
    }
  });

  it("reads the focus values the file lists, and refuses the others", () => {
    for (const value of vectors.focusValues.accepted) assert.notEqual(readFocus(value), "invalid", JSON.stringify(value));
    for (const value of vectors.focusValues.refused) assert.equal(readFocus(value), "invalid", JSON.stringify(value));
  });

  it("keeps a focus as sent, without other keys, and none as null", () => {
    assert.deepEqual(readFocus({ x: 0.123456789, y: 1, zoom: 3.5, other: 1 }), { x: 0.123456789, y: 1, zoom: 3.5 });
    assert.equal(readFocus(undefined), null);
    assert.equal(readFocus(null), null);
    for (const value of [{ x: Number.NaN, y: 0.5, zoom: 1 }, { x: 0.5, y: 0.5, zoom: Number.POSITIVE_INFINITY }]) {
      assert.equal(readFocus(value), "invalid");
    }
  });
});

describe("a board's cover focus", () => {
  const board = (overrides: Record<string, unknown> = {}) => ({
    title: "Films",
    tiers: [{ uid: "t", position: 0, label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
    items: [{ uid: "i", tierUid: "t", position: 0, title: "Arrival" }],
    coverImageUrl: "https://image.tmdb.org/t/p/w500/a.jpg",
    ...overrides,
  });
  const store = (overrides: Record<string, unknown> = {}, storedCoverFocus: CoverFocus | null = null) =>
    decideStore({ body: board(overrides), nowMs: 1_800_000_000_000, isAnonymous: false, boardsAlreadyKept: 0, storedCoverFocus });

  it("is kept as sent", () => {
    const decision = store({ coverFocus: FOCUS });
    assert.equal(decision.ok, true);
    assert.deepEqual(decision.ok && decision.board.coverFocus, FOCUS);
  });

  it("is refused out of range", () => {
    const decision = store({ coverFocus: { x: 0.5, y: 0.5, zoom: 5 } });
    assert.equal(decision.ok, false);
    assert.equal(!decision.ok && decision.reason, "invalid");
    assert.match(!decision.ok && decision.reason === "invalid" ? decision.detail : "", /^coverFocus: /);
  });

  it("goes when null is sent", () => {
    const decision = store({ coverFocus: null }, FOCUS);
    assert.equal(decision.ok && "coverFocus" in decision.board, false);
  });

  // A client from before the field sends a board without it.
  it("stays when a writer leaves it out and the board still has one cover", () => {
    const decision = store({}, FOCUS);
    assert.deepEqual(decision.ok && decision.board.coverFocus, FOCUS);
    assert.deepEqual(settleCoverFocus({}, { coverImageUrl: null, coverPictureId: "own" }, FOCUS), FOCUS);
  });

  it("goes when a writer leaves it out and the board has no single cover", () => {
    const decision = store({ coverImageUrl: null }, FOCUS);
    assert.equal(decision.ok && "coverFocus" in decision.board, false);
  });
});

describe("a publication's cover focus", () => {
  const publish = (overrides: Record<string, unknown>) => decidePublish({
    body: {
      title: "Films",
      category: "film_tv",
      tiers: [{ label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
      items: [{ title: "Arrival", imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg" }],
      coverImageUrl: "https://image.tmdb.org/t/p/w500/a.jpg",
      ...overrides,
    },
    isAnonymous: false,
    listsAlreadyPublished: 0,
    uploaderUid: "u1",
  });

  it("goes into the list as sent, and is none when not sent", () => {
    const sent = publish({ coverFocus: FOCUS });
    assert.equal(sent.ok, true);
    assert.deepEqual(sent.ok && settle(sent.draft, new Map()).coverFocus, FOCUS);
    const cleared = publish({ coverFocus: null });
    assert.equal(cleared.ok && settle(cleared.draft, new Map()).coverFocus, null);
    const none = publish({});
    assert.equal(none.ok && settle(none.draft, new Map()).coverFocus, undefined);
  });

  // A client from before the field republishes without it.
  it("stays on a republish that leaves it out while the cover is the same", () => {
    const before = { coverImageUrl: "https://pic", coverFocus: FOCUS };
    assert.deepEqual(coverFocusAfter(undefined, "https://pic", before), FOCUS);
    assert.equal(coverFocusAfter(undefined, "https://other", before), null);
    assert.equal(coverFocusAfter(null, "https://pic", before), null);
    assert.equal(coverFocusAfter(FOCUS, null, before), null);
    assert.equal(coverFocusAfter(undefined, "https://pic", null), null);
  });

  it("is refused out of range", () => {
    const decision = publish({ coverFocus: { x: 2, y: 0.5, zoom: 1 } });
    assert.equal(!decision.ok && decision.reason, "invalid");
  });

  it("is told with the cover and only with it", () => {
    const stored = {
      title: "Films", titleLower: "films", authorUid: "a", authorName: "A", authorPhotoUrl: null, category: "film_tv",
      itemCount: 1, tiers: [{ label: "S" }], items: [], previewImages: [], tierColors: [],
    };
    assert.deepEqual(toSummary("l", { ...stored, coverImageUrl: "https://pic", coverFocus: FOCUS } as never).coverFocus, FOCUS);
    assert.equal("coverFocus" in toSummary("l", { ...stored, coverImageUrl: "https://pic" } as never), false);
    assert.equal("coverFocus" in toSummary("l", { ...stored, coverImageUrl: "https://pic", coverFocus: null } as never), false);
    assert.equal("coverFocus" in toSummary("l", { ...stored, coverImageUrl: null, coverFocus: FOCUS } as never), false);
  });
});

describe("a topic's picture focus", () => {
  const reader = { uid: "r", moderator: false };
  const topic = (data: Record<string, unknown>) => toTopic("t", { name: "Cats", ...data } as never, false, reader as never);

  it("is told with the picture and only with it", () => {
    const picture = { url: "https://pic", width: 1000, height: 800 };
    assert.deepEqual(topic({ picture, pictureFocus: FOCUS }).pictureFocus, FOCUS);
    assert.equal("pictureFocus" in topic({ picture }), false);
    assert.equal("pictureFocus" in topic({ picture: null, pictureFocus: FOCUS }), false);
  });
});

describe("a section's picture focus", () => {
  const approved: SectionRecord = {
    ...newSection("cats", "Cats", 1000),
    status: "approved",
    approvedAtMs: 1000,
    picture: { url: "https://pic", width: 1600, height: 1000 },
    pictureFocus: FOCUS,
  };
  const stats = { listCount: 0, lists30d: 0, newThisWeek: 0, followerCount: 0, collage: [] };

  it("is read when sent, null for the centre, and refused out of range", () => {
    const read = readSectionEdits({ pictureFocus: FOCUS }, ["pictureFocus"]);
    assert.deepEqual(read.ok && read.edits.pictureFocus, FOCUS);
    const cleared = readSectionEdits({ pictureFocus: null }, ["pictureFocus"]);
    assert.equal(cleared.ok && cleared.edits.pictureFocus, null);
    assert.deepEqual(readSectionEdits({ pictureFocus: { x: 0.5, y: 0.5, zoom: 0 } }, ["pictureFocus"]), {
      ok: false, code: "INVALID", detail: "pictureFocus",
    });
  });

  it("is told with a picture the viewer sees and only then", () => {
    const stranger = { uid: "somebody", moderator: false };
    assert.deepEqual(sectionView(approved, stranger, { id: "cats", ...stats } as never, false).pictureFocus, FOCUS);
    assert.equal("pictureFocus" in sectionView({ ...approved, picture: null }, stranger, { id: "cats", ...stats } as never, false), false);
    const pending: SectionRecord = {
      ...approved, status: "pending", picture: null, proposerUid: "me",
      proposalPicture: "proposals/cats/p", proposalPictureUrl: "https://private",
    };
    assert.equal("pictureFocus" in sectionView(pending, stranger, { id: "cats", ...stats } as never, false), false);
    assert.deepEqual(sectionView(pending, { uid: "me", moderator: false }, { id: "cats", ...stats } as never, false).pictureFocus, FOCUS);
  });
});
