import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyMetaFor } from "../src/outsidePictures";
import { DEFAULT_COPY_SWITCHES } from "../src/pictureCopies";
import {
  afterFailedRefresh,
  copiesToUndo,
  copyAgeDue,
  copyIdIn,
  foundAgain,
  pictureFields,
  readCopyMeta,
  shownPictures,
  stillToCopy,
  storedPathOf,
  withMovedCopy,
  withoutCopies,
  type ShownPictures,
} from "../src/pictureCopyUpkeep";
import { addressOf } from "../src/publishedPictures";
import { outsideName } from "../src/outsidePictures";
import { readSources } from "../scripts/remove-picture-copies";
import { BOARD_COPY_MARGIN_BYTES, SHARED_COPIES, copiesOnBoard, copiesShown, fitsWithCopies, withBoardCopies } from "../src/boardPictures";
import { MAX_BOARD_BYTES } from "../src/sync";

const BUCKET = "tieryourlife.firebasestorage.app";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const POSTER = "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg";
const COVER = "https://image.tmdb.org/t/p/w500/cover.jpg";
const COMMONS = "https://commons.wikimedia.org/wiki/Special:FilePath/Felis_catus-cat_on_snow.jpg?width=600";
const path = (url: string) => `published/L1/${outsideName(url)}`;
const copy = (url: string) => addressOf(BUCKET, path(url));

describe("a catalogue picture's copy after it is made", () => {
  it("says what it was copied from and when, and an older file its upload time", () => {
    assert.deepEqual(copyMetaFor(POSTER, NOW), { originalUrl: POSTER, source: "tmdb", copiedAt: String(NOW) });
    assert.deepEqual(readCopyMeta({ originalUrl: POSTER, source: "tmdb", copiedAt: String(NOW) }, "2026-01-01T00:00:00Z"), { originalUrl: POSTER, source: "tmdb", copiedAt: NOW });
    assert.deepEqual(readCopyMeta(undefined, "2026-01-01T00:00:00Z"), { copiedAt: Date.parse("2026-01-01T00:00:00Z") });
  });

  it("is fetched again after 90 days when it is TMDB's, and found again or kept if that fails after 150; others are kept", () => {
    const tmdb = (days: number) => ({ originalUrl: POSTER, source: "tmdb", copiedAt: NOW - days * DAY });
    assert.equal(copyAgeDue(tmdb(89), NOW), "keep");
    assert.equal(copyAgeDue(tmdb(90), NOW), "refresh");
    assert.equal(copyAgeDue(tmdb(150), NOW), "refresh-or-rescue");
    assert.equal(copyAgeDue({ originalUrl: COMMONS, source: "wikimedia", copiedAt: NOW - 400 * DAY }, NOW), "keep");
    assert.equal(copyAgeDue({ source: "tmdb", copiedAt: NOW - 400 * DAY }, NOW), "keep");
  });

  it("is found by its path in our bucket", () => {
    assert.equal(storedPathOf(copy(POSTER)), path(POSTER));
    assert.equal(storedPathOf(POSTER), null);
    assert.equal(storedPathOf(null), null);
  });
});

describe("a TMDB copy past 150 days that could not be fetched again", () => {
  const MOVED = "https://image.tmdb.org/t/p/w500/newPoster.jpg";
  const credit = { source: "tmdb" as const, link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603", originalUrl: POSTER };

  it("is kept with the reason unless its address answers 404 or 410; a busy catalogue is not even looked at", () => {
    assert.deepEqual(afterFailedRefresh("SOURCE_BUSY", undefined, "tmdb:movie:603"), { keep: "refresh failed: the catalogue is busy" });
    assert.deepEqual(afterFailedRefresh("UNREACHABLE", null, "tmdb:movie:603"), { keep: "refresh failed (UNREACHABLE); the address answers nothing" });
    assert.deepEqual(afterFailedRefresh("UNREACHABLE", 403, "tmdb:movie:603"), { keep: "refresh failed (UNREACHABLE); the address answers 403" });
    assert.deepEqual(afterFailedRefresh("NOT_A_PICTURE", 200, "tmdb:movie:603"), { keep: "refresh failed (NOT_A_PICTURE); the address answers 200" });
  });

  it("is looked for by its card's catalogue id when its address is dead, and kept when no card has one", () => {
    assert.deepEqual(afterFailedRefresh("UNREACHABLE", 404, "tmdb:movie:603"), { find: "tmdb:movie:603" });
    assert.deepEqual(afterFailedRefresh("UNREACHABLE", 410, "tmdb:movie:603"), { find: "tmdb:movie:603" });
    assert.deepEqual(afterFailedRefresh("UNREACHABLE", 404, null), { keep: "the address answers 404 and no card showing the copy has a catalogue id" });
  });

  it("moves only to a picture the catalogue names now that is not the dead one", () => {
    assert.deepEqual(foundAgain("tmdb:movie:603", MOVED, POSTER), { move: MOVED });
    assert.deepEqual(foundAgain("tmdb:movie:603", undefined, POSTER), { keep: "the address is dead and the catalogue could not be asked for tmdb:movie:603" });
    assert.deepEqual(foundAgain("tmdb:movie:603", null, POSTER), { keep: "the address is dead and the catalogue has no picture for tmdb:movie:603 any more" });
    assert.deepEqual(foundAgain("tmdb:movie:603", POSTER, POSTER), { keep: "the address is dead and the catalogue still names it for tmdb:movie:603" });
    // The same poster at its original size is the same dead picture.
    assert.ok("keep" in foundAgain("tmdb:movie:603", POSTER.replace("/w500/", "/original/"), POSTER));
  });

  it("takes its id from a card showing it: the page's own word first, the kept id otherwise", () => {
    const shown = (attribution: ShownPictures["items"][number]["attribution"]): ShownPictures => ({
      items: [{ imageUrl: copy(COVER) }, { imageUrl: copy(POSTER), attribution }],
      coverImageUrl: null,
      previewImages: [],
    });
    assert.equal(copyIdIn(shown(credit), path(POSTER), POSTER), "tmdb:movie:603");
    assert.equal(copyIdIn(shown({ source: "tmdb", id: "tmdb:tv:1399", originalUrl: POSTER }), path(POSTER), POSTER), "tmdb:tv:1399");
    assert.equal(copyIdIn(shown({ source: "tmdb", id: "nonsense", originalUrl: POSTER }), path(POSTER), POSTER), null);
    assert.equal(copyIdIn(shown(undefined), path(POSTER), POSTER), null);
    assert.equal(copyIdIn(shown(credit), path(COVER), COVER), null);
  });

  it("is replaced on cards, cover and collage by a copy of the new picture, the old address kept in formerUrls", () => {
    const newCopy = copy(MOVED);
    const shown: ShownPictures = {
      items: [
        { title: "Matrix", imageUrl: copy(POSTER), attribution: { ...credit, formerUrls: ["https://image.tmdb.org/t/p/w500/older.jpg"] } },
        { title: "Other", imageUrl: copy(COVER), attribution: { source: "tmdb", originalUrl: COVER } },
      ],
      coverImageUrl: copy(POSTER),
      previewImages: [copy(COVER), copy(POSTER)],
    };
    const after = withMovedCopy(shown, path(POSTER), newCopy, MOVED, POSTER)!;
    assert.deepEqual(after.items[0], {
      title: "Matrix",
      imageUrl: newCopy,
      attribution: { ...credit, originalUrl: MOVED, formerUrls: ["https://image.tmdb.org/t/p/w500/older.jpg", POSTER] },
    });
    assert.deepEqual(after.items[1], shown.items[1]);
    assert.equal(after.coverImageUrl, newCopy);
    assert.deepEqual(after.previewImages, [copy(COVER), newCopy]);
    assert.equal(withMovedCopy(shown, path(MOVED), newCopy, MOVED, POSTER), null);
  });

  it("keeps at most five former addresses, the newest", () => {
    const former = [1, 2, 3, 4, 5].map((at) => `https://image.tmdb.org/t/p/w500/f${at}.jpg`);
    const shown: ShownPictures = { items: [{ imageUrl: copy(POSTER), attribution: { ...credit, formerUrls: former } }], coverImageUrl: null, previewImages: [] };
    const after = withMovedCopy(shown, path(POSTER), copy(MOVED), MOVED, POSTER)!;
    assert.deepEqual(after.items[0]!.attribution!.formerUrls, [...former.slice(1), POSTER]);
  });
});

describe("undoing a catalogue's copies", () => {
  const credit = { source: "tmdb" as const, link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603", originalUrl: POSTER };
  const shown: ShownPictures = {
    items: [
      { title: "Matrix", imageUrl: copy(POSTER), attribution: credit },
      { title: "Cat", imageUrl: copy(COMMONS), attribution: { source: "wikimedia", license: "CC BY-SA 4.0", originalUrl: COMMONS } },
      { title: "No picture", imageUrl: null },
    ],
    coverImageUrl: copy(COVER),
    previewImages: [copy(POSTER), copy(COMMONS)],
  };
  const files = new Map([[path(COVER), { originalUrl: COVER, source: "tmdb", copiedAt: NOW }]]);

  it("finds them by the card's credit and by the file's own word, and leaves other catalogues' copies", () => {
    assert.deepEqual(copiesToUndo(shown, files, new Set(["tmdb"])), new Map([[path(POSTER), POSTER], [path(COVER), COVER]]));
    assert.deepEqual(copiesToUndo(shown, files, new Set(["igdb"])), new Map());
  });

  it("shows the catalogue's own address again with the same credit, cover and collage too, and saves what it was", () => {
    const after = withoutCopies(shown, copiesToUndo(shown, files, new Set(["tmdb"])))!;
    assert.deepEqual(after.items[0], { title: "Matrix", imageUrl: POSTER, attribution: { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" } });
    assert.deepEqual(after.items[1], shown.items[1]);
    assert.equal(after.coverImageUrl, COVER);
    assert.deepEqual(after.previewImages, [POSTER, copy(COMMONS)]);
    assert.deepEqual(Object.keys(pictureFields(shown, after, "list")), ["items", "coverImageUrl", "previewImages"]);
    assert.deepEqual(pictureFields(after, shown, "list").coverImageUrl, copy(COVER));
    assert.deepEqual(Object.keys(pictureFields(shown, after, "ranking")), ["snapshot.items"]);
    assert.equal(withoutCopies(shown, new Map()), null);
  });

  it("is asked for one catalogue, several, or all of them", () => {
    assert.deepEqual(readSources("tmdb"), new Set(["tmdb"]));
    assert.deepEqual(readSources("tmdb, igdb"), new Set(["tmdb", "igdb"]));
    assert.equal(readSources("all")?.size, 7);
    assert.equal(readSources("web"), null);
    assert.equal(readSources(""), null);
    assert.equal(readSources(null), null);
  });
});

describe("what the daily upkeep still copies", () => {
  it("is what a list shows from a catalogue switched on, the cover and collage too", () => {
    const shown: ShownPictures = { items: [{ imageUrl: POSTER }, { imageUrl: copy(COVER) }], coverImageUrl: COVER, previewImages: [POSTER] };
    assert.deepEqual(stillToCopy(shown, DEFAULT_COPY_SWITCHES), []);
    assert.deepEqual(stillToCopy(shown, { ...DEFAULT_COPY_SWITCHES, tmdb: true }), [POSTER, COVER]);
  });
});

describe("a board's catalogue pictures", () => {
  const shared = (url: string) => addressOf(BUCKET, SHARED_COPIES + outsideName(url));
  const credit = { source: "tmdb" as const, id: "tmdb:movie:603" };
  const board = {
    title: "Mine",
    items: [
      { uid: "a", imageUrl: POSTER, attribution: credit },
      { uid: "b", imageUrl: COMMONS, attribution: { source: "wikimedia" as const, license: "CC BY-SA 4.0" } },
      { uid: "c", imageUrl: null },
    ],
    coverImageUrl: POSTER,
    coverImageUrls: [POSTER, COMMONS],
  };
  const copies = new Map([[POSTER, shared(POSTER)]]);

  it("show one shared copy per catalogue address, credit kept with the address, cover and collage too", () => {
    const after = withBoardCopies(board, copies);
    assert.deepEqual(after.items[0], { uid: "a", imageUrl: shared(POSTER), attribution: { ...credit, originalUrl: POSTER } });
    assert.deepEqual(after.items.slice(1), board.items.slice(1));
    assert.equal(after.coverImageUrl, shared(POSTER));
    assert.deepEqual(after.coverImageUrls, [shared(POSTER), COMMONS]);
    assert.equal(after.title, "Mine");
    assert.deepEqual(copiesShown(board, after, copies), copies);
    assert.equal(withBoardCopies(board, new Map()), board);
    assert.match(shared(POSTER), /published%2Fcatalogue%2Fw-[0-9a-f]{32}/);
  });

  it("are found again on the stored board by the address each was copied from; a list's own copies are not shared", () => {
    const stored = withBoardCopies(board, copies).items;
    assert.deepEqual(copiesOnBoard(stored), copies);
    assert.deepEqual(copiesOnBoard([{ imageUrl: copy(POSTER), attribution: { ...credit, originalUrl: POSTER } }]), new Map());
    assert.deepEqual(copiesOnBoard(undefined), new Map());
  });

  it("move only while the board leaves room under its limit", () => {
    assert.equal(fitsWithCopies(board), true);
    assert.equal(fitsWithCopies({ items: "x".repeat(MAX_BOARD_BYTES - BOARD_COPY_MARGIN_BYTES) }), false);
  });

  it("are read from a board's collage, written back to it, and undone by catalogue", () => {
    const after = withBoardCopies(board, copies);
    const shown = shownPictures(after as unknown as Record<string, unknown>, "board");
    assert.deepEqual(shown.previewImages, [shared(POSTER), COMMONS]);
    const files = new Map([[SHARED_COPIES + outsideName(POSTER), { originalUrl: POSTER, source: "tmdb", copiedAt: NOW }]]);
    const back = withoutCopies(shown, copiesToUndo(shown, files, new Set(["tmdb"])))!;
    assert.deepEqual(pictureFields(shown, back, "board"), { items: board.items, coverImageUrl: POSTER, coverImageUrls: [POSTER, COMMONS] });
  });
});
