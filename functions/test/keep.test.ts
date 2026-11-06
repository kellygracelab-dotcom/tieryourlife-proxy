import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAtMost } from "../src/pictureSearch";

function streamed(chunks: number[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((size) => controller.enqueue(new Uint8Array(size)));
      controller.close();
    },
  }));
}

describe("readAtMost", () => {
  it("reads a body up to the limit", async () => {
    assert.equal((await readAtMost(streamed([4, 4, 2]), 10))?.length, 10);
  });

  it("stops at the first chunk past the limit, whatever content-length said", async () => {
    assert.equal(await readAtMost(streamed([4, 4, 4, 4]), 10), null);
  });

  it("answers an empty body with no bytes", async () => {
    assert.equal((await readAtMost(new Response(null), 10))?.length, 0);
  });
});
