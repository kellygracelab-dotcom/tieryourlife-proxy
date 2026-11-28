import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callWebCdnPurge, takeDownPictures, WEB_CDN_PURGE_URL, WEB_CDN_PURGES, type TakedownPictureTools, type WebCdnPurge } from "../src/webCdnPurge";

function tools(over: Partial<TakedownPictureTools> = {}) {
  const steps: string[] = [];
  const asked: WebCdnPurge[] = [];
  const all: TakedownPictureTools = {
    ownFiles: async (listId) => (steps.push("list"), [`published/${listId}/p1`, `published/${listId}/w200/p1`]),
    discardOwn: async () => void steps.push("discard own"),
    discardCopies: async () => (steps.push("discard copies"), ["published/M/L-p1", "published/L/p1"]),
    askPurge: async (purge) => void (steps.push("ask"), asked.push(purge)),
    callPurge: async () => void steps.push("call"),
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
    assert.deepEqual(steps, ["list", "discard own", "discard copies", "ask", "call"]);
    assert.deepEqual(asked, [{ listId: "L", reason: "takedown", paths: ["published/L/p1", "published/L/w200/p1", "published/M/L-p1"] }]);
  });

  it("leaves the takedown done when the note cannot be written, and still calls for notes waiting", async () => {
    const { all, steps } = tools({ askPurge: async () => { throw new Error("firestore said no"); } });
    const errors = console.error;
    console.error = () => undefined;
    try {
      await takeDownPictures("L", all);
    } finally {
      console.error = errors;
    }
    assert.deepEqual(steps, ["list", "discard own", "discard copies", "call"]);
  });

  it("leaves the takedown done when the site's call fails, the note waiting", async () => {
    const { all, asked } = tools({ callPurge: async () => { throw new Error("timeout"); } });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (line: string) => void warned.push(line);
    try {
      await takeDownPictures("L", all);
    } finally {
      console.warn = warn;
    }
    assert.equal(asked.length, 1);
    assert.deepEqual(warned, ["Web CDN purge call failed for L: timeout"]);
  });

  it("calls the site's route by POST with no body, and takes only a 2xx as done", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const answering = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response("{}", { status });
    }) as typeof fetch;
    await callWebCdnPurge(answering(200));
    assert.equal(calls[0][0], WEB_CDN_PURGE_URL);
    assert.equal(calls[0][1]?.method, "POST");
    assert.equal(calls[0][1]?.body, undefined);
    assert.ok(calls[0][1]?.signal instanceof AbortSignal);
    await assert.rejects(callWebCdnPurge(answering(504)), /HTTP 504/);
  });

  it("gives up waiting after the time it is given", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    // AbortSignal.timeout does not hold the event loop open by itself; a real call's socket does.
    const open = setTimeout(() => undefined, 5_000);
    try {
      await assert.rejects(callWebCdnPurge(hanging, 20));
    } finally {
      clearTimeout(open);
    }
  });

  it("asks nothing when the pictures could not be deleted, so the takedown fails as before", async () => {
    const { all, asked } = tools({ discardOwn: async () => { throw new Error("storage said no"); } });
    await assert.rejects(takeDownPictures("L", all), /storage said no/);
    assert.deepEqual(asked, []);
  });
});
