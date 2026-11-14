import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressOf, discardCopiesIn, isPhotoCopiedFrom, withoutPhotosFrom, sourcesInNames, discardPublished, foreignCopyOf, isCopiedFrom, publicFoldersOf, publishedNamesIn, realSafeSearch, safeSearchOrNothing, visionBatches } from "../src/publishedPictures";
import type { SafeSearchVerdict } from "../src/safety";

describe("taking a list down", () => {
  it("clears the feed's copies and the site's share cards for it", () => {
    assert.deepEqual(publicFoldersOf("abc"), ["published/abc/", "share/l/abc/"]);
  });

  it("leaves a ranking's share cards to the site", () => {
    assert.ok(publicFoldersOf("abc").every((prefix) => !prefix.startsWith("share/r/")));
  });

  it("deletes every one of those folders, and nothing beside them", async () => {
    const asked: { prefix: string; force: boolean }[] = [];
    await discardPublished("abc", {
      deleteFiles: async (options) => {
        asked.push(options);
      },
    });
    assert.deepEqual(
      asked.map((one) => one.prefix).sort(),
      ["published/abc/", "share/l/abc/"],
    );
    assert.ok(asked.every((one) => one.force));
  });
});

describe("replacing a list", () => {
  it("keeps the copies the new snapshot still names by address, and only this list's", () => {
    const own = addressOf("b", "published/L1/p1");
    const cover = addressOf("b", "published/L1/cover-2");
    const another = addressOf("b", "published/L2/p9");
    assert.deepEqual(
      publishedNamesIn("L1", [own, null, "https://image.tmdb.org/t/p/w342/a.jpg", cover, another, undefined]),
      ["p1", "cover-2"],
    );
  });
});

describe("a list made from another", () => {
  it("takes its own copy of a picture in another list's folder", () => {
    assert.deepEqual(foreignCopyOf("M", addressOf("b", "published/L/p1")), {
      from: "published/L/p1",
      to: "published/M/L-p1",
      list: "L",
    });
  });

  it("leaves its own folder, other hosts and other folders alone", () => {
    assert.equal(foreignCopyOf("M", addressOf("b", "published/M/p1")), null);
    assert.equal(foreignCopyOf("M", "https://image.tmdb.org/t/p/w342/a.jpg"), null);
    assert.equal(foreignCopyOf("M", addressOf("b", "users/u1/pictures/p1")), null);
    assert.equal(foreignCopyOf("M", null), null);
  });
});

describe("taking down a list others made copies of", () => {
  it("clears only the copies of its pictures from each list that holds them", async () => {
    const asked: string[] = [];
    const folder = (id: string, names: string[]) =>
      names.map((name) => ({ name: `published/${id}/${name}`, delete: async () => asked.push(`${id}/${name}`) }));
    await discardCopiesIn(["M", "N"], "L", {
      getFiles: async ({ prefix }) =>
        [prefix === "published/M/" ? folder("M", ["L-p1", "own", "K-p2"]) : folder("N", ["M-L-p1", "M-own", "x-L"])],
    });
    assert.deepEqual(asked.sort(), ["M/L-p1", "N/M-L-p1"]);
  });

  it("reads where a copy's own files came from off their names", () => {
    const L = "AbCdEfGhIjKlMnOpQrSt";
    const K = "ZyXwVuTsRqPoNmLkJiHg";
    assert.deepEqual(sourcesInNames([`${L}-p1`, `${K}-${L}-p2`, "own-photo-1", `${L}`, "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"]).sort(), [K, L].sort());
  });

  it("knows a copy of a copy by the original in its name", () => {
    assert.equal(isCopiedFrom("L-p1", "L"), true);
    assert.equal(isCopiedFrom("M-L-p1", "L"), true);
    assert.equal(isCopiedFrom("M-p1", "L"), false);
    assert.equal(isCopiedFrom("LL-p1", "L"), false);
  });
});

describe("asking Vision about many photographs", () => {
  const SAFE: SafeSearchVerdict = { adult: "VERY_UNLIKELY", racy: "VERY_UNLIKELY", violence: "VERY_UNLIKELY" };

  it("asks at most sixteen at a time", () => {
    const images = Array.from({ length: 40 }, () => Buffer.alloc(10));
    assert.deepEqual(visionBatches(images).map((batch) => batch.length), [16, 16, 8]);
  });

  it("keeps each call to about eight megabytes of base64, a photograph bigger than that alone", () => {
    const three = Buffer.alloc(3_000_000);
    assert.deepEqual(visionBatches([three, three, three]).map((batch) => batch.length), [2, 1]);
    const big = Buffer.alloc(7_000_000);
    assert.deepEqual(visionBatches([Buffer.alloc(1), big, Buffer.alloc(1)]).map((batch) => batch.length), [1, 1, 1]);
    assert.deepEqual(visionBatches([]), []);
  });

  it("answers in the order asked, one call per batch, and a missing answer as unknown", async () => {
    const images = Array.from({ length: 20 }, (_, at) => Buffer.from([at]));
    const calls: number[] = [];
    const annotate = async (batch: Buffer[]) => {
      calls.push(batch.length);
      return batch.map((one) => (one[0] === 3 ? null : { ...SAFE, racy: one[0] === 17 ? "LIKELY" as const : "VERY_UNLIKELY" as const }));
    };
    const verdicts = await safeSearchOrNothing(images, annotate);
    assert.deepEqual(calls, [16, 4]);
    assert.equal(verdicts.length, 20);
    assert.equal(verdicts[3], null);
    assert.equal(verdicts[17]?.racy, "LIKELY");
    assert.equal((await realSafeSearch(images, annotate))[3]?.adult, "UNKNOWN");
  });
});

describe("an erased author's photographs in other people's copies", () => {
  const ORIGINAL = "AAAAAAAAAAAAAAAAAAAA";
  const at = (folder: string, name: string) => addressOf("b", `published/${folder}/${name}`);

  it("are the copies of their own pictures, not of catalogue pictures or pictures from other sites", () => {
    assert.equal(isPhotoCopiedFrom(`${ORIGINAL}-pic123_p_x`, ORIGINAL), true);
    assert.equal(isPhotoCopiedFrom(`BBBBBBBBBBBBBBBBBBBB-${ORIGINAL}-pic123`, ORIGINAL), true);
    assert.equal(isPhotoCopiedFrom(`${ORIGINAL}-w-0123456789abcdef0123456789abcdef`, ORIGINAL), false);
    assert.equal(isPhotoCopiedFrom("pic123", ORIGINAL), false);
    assert.equal(isPhotoCopiedFrom("CCCCCCCCCCCCCCCCCCCC-pic123", ORIGINAL), false);
  });

  it("go from the cards, the cover and the collage, which show no picture there", () => {
    const photo = at("COPY", `${ORIGINAL}-pic123`);
    const catalogue = at("COPY", `${ORIGINAL}-w-0123456789abcdef0123456789abcdef`);
    const list = { items: [{ title: "a", imageUrl: photo }, { title: "b", imageUrl: catalogue }, { title: "c", imageUrl: null }], coverImageUrl: photo, previewImages: [photo, catalogue] };
    assert.deepEqual(withoutPhotosFrom(list, "COPY", ORIGINAL), {
      items: [{ title: "a", imageUrl: null }, { title: "b", imageUrl: catalogue }, { title: "c", imageUrl: null }],
      coverImageUrl: null,
      previewImages: [catalogue],
    });
    assert.equal(withoutPhotosFrom({ items: [{ imageUrl: catalogue }], coverImageUrl: null, previewImages: [] }, "COPY", ORIGINAL), null);
  });
});
