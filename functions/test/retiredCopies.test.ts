import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as storageModule from "firebase-admin/storage";
import { namedPaths, RETIRED_AT, RETIRED_KEEP_MS, retiredAtOf, retiredToRemove, retireUnusedPublished } from "../src/publishedPictures";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const LIST = "RNKEXN5CSbaltvtNNXSb";
const fileUrl = (path: string) => `https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/${encodeURIComponent(path)}?alt=media`;

describe("a copy its list no longer names (20.11.2026)", () => {
  it("is kept a month, and longer while anything names it", () => {
    assert.equal(RETIRED_KEEP_MS, 30 * DAY);
    const files = [
      { name: "published/L/young", retiredAt: NOW - 29 * DAY },
      { name: "published/L/old", retiredAt: NOW - 31 * DAY },
      { name: "published/L/old-but-shown", retiredAt: NOW - 90 * DAY },
      { name: "published/L/never-retired", retiredAt: null },
    ];
    assert.deepEqual(retiredToRemove(files, new Set(["published/L/old-but-shown"]), NOW), ["published/L/old"]);
  });

  it("reads its mark from custom metadata, and no mark as none", () => {
    assert.equal(retiredAtOf({ [RETIRED_AT]: String(NOW) }), NOW);
    assert.equal(retiredAtOf({ [RETIRED_AT]: "soon" }), null);
    assert.equal(retiredAtOf(undefined), null);
    assert.equal(retiredAtOf(null), null);
  });

  it("is named by any address anywhere in a document, our own and the site's", () => {
    const board = {
      items: [{ imageUrl: fileUrl(`published/${LIST}/a_p_1`) }, { imageUrl: null }],
      ranking: { snapshot: { cards: [{ picture: `https://tieryourlife.com/img/original/published/${LIST}/b_p_1` }] } },
      coverImageUrls: [`https://tieryourlife.web.app/img/original/published/${LIST}/c_p_1?v=2`],
      other: ["https://image.tmdb.org/t/p/w500/x.jpg", "a /o/ that is no address", 7, true],
      updatedAt: { toDate: () => new Date(NOW), seconds: 1 },
    };
    assert.deepEqual([...namedPaths(board)].sort(), [`published/${LIST}/a_p_1`, `published/${LIST}/b_p_1`, `published/${LIST}/c_p_1`]);
  });
});

describe("retiring a republished list's copies", () => {
  afterEach(() => mock.restoreAll());

  function bucketWith(files: { name: string; metadata?: { metadata?: Record<string, unknown> } }[], failing = new Set<string>()) {
    const marks: [string, unknown][] = [];
    const listed = files.map((file) => ({
      ...file,
      delete: async () => assert.fail(`${file.name} removed`),
      setMetadata: async (meta: { metadata: Record<string, unknown> }) => {
        if (failing.has(file.name)) throw new Error("storage said no");
        marks.push([file.name, meta.metadata[RETIRED_AT]]);
      },
    }));
    mock.method(storageModule, "getStorage", () => ({ bucket: () => ({ getFiles: async ({ prefix }: { prefix: string }) => [listed.filter((one) => one.name.startsWith(prefix))] }) }));
    return marks;
  }

  it("marks what the list stopped naming and removes nothing; a copy named again loses its mark", async () => {
    const marks = bucketWith([
      { name: `published/${LIST}/kept_p_1` },
      { name: `published/${LIST}/dropped_p_1` },
      { name: `published/${LIST}/already_p_1`, metadata: { metadata: { [RETIRED_AT]: String(NOW - DAY) } } },
      { name: `published/${LIST}/back_p_1`, metadata: { metadata: { [RETIRED_AT]: String(NOW - DAY) } } },
      { name: `published/${LIST}/another-attempt_p_2` },
    ]);
    await retireUnusedPublished(LIST, ["kept_p_1", "back_p_1"], ["kept_p_1", "dropped_p_1", "already_p_1", "back_p_1"], NOW);
    assert.deepEqual(marks.sort(), [
      [`published/${LIST}/back_p_1`, null],
      [`published/${LIST}/dropped_p_1`, String(NOW)],
    ]);
  });

  it("retires the site's smaller copies of a picture with it, and keeps them while it is kept (Web, 28.11.2026)", async () => {
    const marks = bucketWith([
      { name: `published/${LIST}/kept_p_1` },
      { name: `published/${LIST}/w200/kept_p_1`, metadata: { metadata: { [RETIRED_AT]: String(NOW - DAY) } } },
      { name: `published/${LIST}/dropped_p_1` },
      { name: `published/${LIST}/w200/dropped_p_1` },
      { name: `published/${LIST}/w400/dropped_p_1` },
      { name: `published/${LIST}/w200/another-attempt_p_2` },
    ]);
    await retireUnusedPublished(LIST, ["kept_p_1"], ["kept_p_1", "dropped_p_1"], NOW);
    assert.deepEqual(marks.sort(), [
      [`published/${LIST}/dropped_p_1`, String(NOW)],
      [`published/${LIST}/w200/dropped_p_1`, String(NOW)],
      [`published/${LIST}/w200/kept_p_1`, null],
      [`published/${LIST}/w400/dropped_p_1`, String(NOW)],
    ]);
  });

  it("leaves a copy it could not mark as it is, kept", async () => {
    const marks = bucketWith([{ name: `published/${LIST}/dropped_p_1` }, { name: `published/${LIST}/other_p_1` }], new Set([`published/${LIST}/dropped_p_1`]));
    await retireUnusedPublished(LIST, [], undefined, NOW);
    assert.deepEqual(marks, [[`published/${LIST}/other_p_1`, String(NOW)]]);
  });
});
