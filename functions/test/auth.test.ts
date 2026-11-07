import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";
import { requireUser, writes, type UserChecks } from "../src/auth";
import { erasesTheAccount } from "../src/boards";

function call(method: string) {
  const answer: { status?: number; body?: unknown } = {};
  const request = { method, header: (name: string) => (name === "Authorization" ? "Bearer token" : undefined) } as unknown as Request;
  const response = {
    status(code: number) {
      answer.status = code;
      return this;
    },
    json(body: unknown) {
      answer.body = body;
      return this;
    },
  } as unknown as Response;
  return { request, response, answer };
}

function checks(provider: string, erased: boolean): UserChecks & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    verify: async () => ({ uid: "erased-uid", firebase: { sign_in_provider: provider, identities: {} } }) as unknown as DecodedIdToken,
    erased: async (uid) => {
      asked.push(uid);
      return erased;
    },
  };
}

describe("requireUser after the account was erased", () => {
  // QA S16: another phone's token stays good for up to an hour and wrote every board back.
  for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
    it(`refuses ${method} with 401 ACCOUNT_ERASED`, async () => {
      const { request, response, answer } = call(method);
      const identity = await requireUser(request, response, {}, checks("google.com", true));
      assert.equal(identity, null);
      assert.equal(answer.status, 401);
      assert.equal((answer.body as { code: string }).code, "ACCOUNT_ERASED");
    });
  }

  it("lets a read through, which finds nothing, without looking", async () => {
    const { request, response } = call("GET");
    const looking = checks("google.com", true);
    assert.equal((await requireUser(request, response, {}, looking))?.uid, "erased-uid");
    assert.deepEqual(looking.asked, []);
  });

  it("lets the erasure itself be asked for again", async () => {
    const { request, response } = call("DELETE");
    assert.equal((await requireUser(request, response, { evenIfErased: true }, checks("google.com", true)))?.uid, "erased-uid");
  });

  // A guest that linked Google keeps its uid, and the anonymous token from before the link still passes.
  it("refuses a guest token's write too once its uid was erased", async () => {
    const { request, response, answer } = call("PUT");
    assert.equal(await requireUser(request, response, {}, checks("anonymous", true)), null);
    assert.equal((answer.body as { code: string }).code, "ACCOUNT_ERASED");
  });

  it("lets a guest read without looking", async () => {
    const { request, response } = call("GET");
    const looking = checks("anonymous", true);
    assert.equal((await requireUser(request, response, {}, looking))?.isAnonymous, true);
    assert.deepEqual(looking.asked, []);
  });

  it("lets a live account write", async () => {
    const { request, response } = call("PUT");
    const looking = checks("google.com", false);
    assert.equal((await requireUser(request, response, {}, looking))?.uid, "erased-uid");
    assert.deepEqual(looking.asked, ["erased-uid"]);
  });

  it("answers 503 UNAVAILABLE when it cannot tell, rather than letting the write through", async () => {
    const { request, response, answer } = call("PUT");
    const broken: UserChecks = { ...checks("google.com", false), erased: async () => { throw new Error("down"); } };
    assert.equal(await requireUser(request, response, {}, broken), null);
    assert.equal(answer.status, 503);
  });
});

describe("writes", () => {
  it("is every method but the reads", () => {
    assert.deepEqual(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"].map(writes), [false, false, false, true, true, true, true]);
  });
});

describe("erasesTheAccount", () => {
  it("is DELETE /boards/account and nothing else", () => {
    assert.equal(erasesTheAccount("DELETE", ["account"]), true);
    assert.equal(erasesTheAccount("PUT", ["account"]), false);
    assert.equal(erasesTheAccount("GET", ["account"]), false);
    assert.equal(erasesTheAccount("DELETE", ["board1"]), false);
    assert.equal(erasesTheAccount("DELETE", ["account", "board1"]), false);
    assert.equal(erasesTheAccount("DELETE", []), false);
  });
});
