import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressOf, discardCopiesIn, discardPublished, foreignCopyOf, publicFoldersOf, publishedNamesIn } from "../src/publishedPictures";

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
    await discardCopiesIn(["M1", "M2"], "L", {
      deleteFiles: async ({ prefix }) => {
        asked.push(prefix);
      },
    });
    assert.deepEqual(asked, ["published/M1/L-", "published/M2/L-"]);
  });
});
