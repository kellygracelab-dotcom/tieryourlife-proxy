import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyMetaFor } from "../src/outsidePictures";
import { DEFAULT_COPY_SWITCHES } from "../src/pictureCopies";
import { copiesToUndo, copyAgeDue, pictureFields, readCopyMeta, shownPictures, stillToCopy, storedPathOf, withoutCopies, type ShownPictures } from "../src/pictureCopyUpkeep";
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

  it("is fetched again after 90 days when it is TMDB's, and undone if that fails after 150; others are kept", () => {
    const tmdb = (days: number) => ({ originalUrl: POSTER, source: "tmdb", copiedAt: NOW - days * DAY });
    assert.equal(copyAgeDue(tmdb(89), NOW), "keep");
    assert.equal(copyAgeDue(tmdb(90), NOW), "refresh");
    assert.equal(copyAgeDue(tmdb(150), NOW), "refresh-or-drop");
    assert.equal(copyAgeDue({ originalUrl: COMMONS, source: "wikimedia", copiedAt: NOW - 400 * DAY }, NOW), "keep");
    assert.equal(copyAgeDue({ source: "tmdb", copiedAt: NOW - 400 * DAY }, NOW), "keep");
  });

  it("is found by its path in our bucket", () => {
    assert.equal(storedPathOf(copy(POSTER)), path(POSTER));
    assert.equal(storedPathOf(POSTER), null);
    assert.equal(storedPathOf(null), null);
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

describe("the cards a reader added to their ranking", () => {
  const POSTER = "https://image.tmdb.org/t/p/w500/added.jpg";
  const ranking = { listId: "L1", uid: "u1", rows: [{ items: [0] }], addedCards: [{ title: "Added", imageUrl: POSTER, attribution: { source: "tmdb" } }] };

  it("are what an owned ranking shows, and are written back where they are, never as a snapshot", () => {
    const shown = shownPictures(ranking, "ranking");
    assert.deepEqual(shown, { items: ranking.addedCards, coverImageUrl: null, previewImages: [], itemsField: "addedCards" });
    assert.deepEqual(stillToCopy(shown, { ...DEFAULT_COPY_SWITCHES, tmdb: true }), [POSTER]);
    const after = { ...shown, items: [{ ...shown.items[0], imageUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/published%2Franking-L1_u1%2Fw-1?alt=media" }] };
    assert.deepEqual(Object.keys(pictureFields(shown, after, "ranking")), ["addedCards"]);
  });

  it("leave a website ranking's snapshot and a ranking without added cards as they were", () => {
    assert.deepEqual(shownPictures({ snapshot: { items: [{ imageUrl: POSTER }] } }, "ranking").itemsField, undefined);
    assert.deepEqual(shownPictures({ listId: "L1", uid: "u1" }, "ranking"), { items: [], coverImageUrl: null, previewImages: [] });
  });
});
