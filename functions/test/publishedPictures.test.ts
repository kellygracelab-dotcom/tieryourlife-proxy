import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressOf, discardPublished, publicFoldersOf, publishedNamesIn } from "../src/publishedPictures";

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
