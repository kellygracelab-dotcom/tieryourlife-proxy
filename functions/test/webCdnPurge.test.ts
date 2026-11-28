import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeDownPictures, WEB_CDN_PURGES, type TakedownPictureTools, type WebCdnPurge } from "../src/webCdnPurge";

function tools(over: Partial<TakedownPictureTools> = {}) {
  const steps: string[] = [];
  const asked: WebCdnPurge[] = [];
  const all: TakedownPictureTools = {
    ownFiles: async (listId) => (steps.push("list"), [`published/${listId}/p1`, `published/${listId}/w200/p1`]),
    discardOwn: async () => void steps.push("discard own"),
    discardCopies: async () => (steps.push("discard copies"), ["published/M/L-p1", "published/L/p1"]),
    askPurge: async (purge) => void (steps.push("ask"), asked.push(purge)),
    ...over,
  };
  return { all, steps, asked };
}

describe("a takedown asks the site to clear its CDN (Web, 28.11.2026)", () => {
  it("writes to the collection Web's trigger reads", () => {
    assert.equal(WEB_CDN_PURGES, "webCdnPurges");
  });

  it("asks only after every file is deleted, naming each once by its full path", async () => {
    const { all, steps, asked } = tools();
    await takeDownPictures("L", all);
    assert.deepEqual(steps, ["list", "discard own", "discard copies", "ask"]);
    assert.deepEqual(asked, [{ listId: "L", reason: "takedown", paths: ["published/L/p1", "published/L/w200/p1", "published/M/L-p1"] }]);
  });

  it("leaves the takedown done when the note cannot be written", async () => {
    const { all, steps } = tools({ askPurge: async () => { throw new Error("firestore said no"); } });
    const errors = console.error;
    console.error = () => undefined;
    try {
      await takeDownPictures("L", all);
    } finally {
      console.error = errors;
    }
    assert.deepEqual(steps, ["list", "discard own", "discard copies"]);
  });

  it("asks nothing when the pictures could not be deleted, so the takedown fails as before", async () => {
    const { all, asked } = tools({ discardOwn: async () => { throw new Error("storage said no"); } });
    await assert.rejects(takeDownPictures("L", all), /storage said no/);
    assert.deepEqual(asked, []);
  });
});
