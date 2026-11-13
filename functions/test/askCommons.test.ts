import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { askCommonsFully } from "../src/cataloguePictures";

const realFetch = globalThis.fetch;

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("asking Commons about the files of a publication", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("counts the files it could not ask about while Commons is busy, with the wait it asked for", async () => {
    globalThis.fetch = (async () => answer(429, {}, { "retry-after": "30" })) as typeof fetch;
    const asked = await askCommonsFully(["A.jpg", "B.jpg"]);
    assert.equal(asked.found.size, 0);
    assert.equal(asked.unasked, 2);
    assert.equal(asked.retryAfterMs, 30_000);
  });

  it("counts nothing unasked when Commons answered, even about a file it does not know", async () => {
    globalThis.fetch = (async () => answer(200, { query: { pages: { "-1": { title: "File:Gone.jpg", missing: "" } } } })) as typeof fetch;
    const asked = await askCommonsFully(["Gone.jpg"]);
    assert.deepEqual([asked.found.size, asked.unasked, asked.retryAfterMs], [0, 0, null]);
  });

  it("asks about nothing when there is nothing to ask", async () => {
    globalThis.fetch = (async () => assert.fail("asked")) as typeof fetch;
    assert.deepEqual(await askCommonsFully([]), { found: new Map(), unasked: 0, retryAfterMs: null });
  });
});
