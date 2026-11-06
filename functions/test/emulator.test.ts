import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";
import { APP_UNVERIFIED, requireAppCheck } from "../src/appCheck";
import { isDemoEmulator, SAFE_VERDICT, secretsOutsideDemo } from "../src/emulator";
import { realSafeSearch } from "../src/publishedPictures";
import { realModeration } from "../src/wording";
import { searchPictures } from "../src/pictureSearch";

const KEYS = ["FUNCTIONS_EMULATOR", "GCLOUD_PROJECT", "FIREBASE_CONFIG"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => setEnv(saved as Partial<Record<(typeof KEYS)[number], string>>));

const DEMO = { FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "demo-tieryourlife" };

describe("isDemoEmulator", () => {
  it("is on only in the emulator of a demo- project", () => {
    assert.equal(isDemoEmulator(DEMO), true);
    assert.equal(isDemoEmulator({ ...DEMO, FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-tieryourlife" }) }), true);
    assert.equal(isDemoEmulator({ FUNCTIONS_EMULATOR: "true", FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-x" }) }), true);
  });

  it("is off in production, and in the emulator of a real project", () => {
    assert.equal(isDemoEmulator({}), false);
    assert.equal(isDemoEmulator({ GCLOUD_PROJECT: "demo-tieryourlife" }), false);
    assert.equal(isDemoEmulator({ FUNCTIONS_EMULATOR: "1", GCLOUD_PROJECT: "demo-tieryourlife" }), false);
    assert.equal(isDemoEmulator({ FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "tieryourlife" }), false);
    assert.equal(isDemoEmulator({ FUNCTIONS_EMULATOR: "true" }), false);
  });

  it("is off when the two places that name the project disagree", () => {
    assert.equal(isDemoEmulator({ ...DEMO, FIREBASE_CONFIG: JSON.stringify({ projectId: "tieryourlife" }) }), false);
    assert.equal(isDemoEmulator({ FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "tieryourlife", FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-x" }) }), false);
    assert.equal(isDemoEmulator({ ...DEMO, FIREBASE_CONFIG: "not json" }), false);
  });
});

describe("secretsOutsideDemo", () => {
  it("keeps every secret outside the demo emulator, and none in it", () => {
    setEnv({ FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "tieryourlife" });
    assert.deepEqual(secretsOutsideDemo(["a", "b"]), ["a", "b"]);
    setEnv({});
    assert.deepEqual(secretsOutsideDemo(["a", "b"]), ["a", "b"]);
    setEnv(DEMO);
    assert.deepEqual(secretsOutsideDemo(["a", "b"]), []);
  });
});

function fakeResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, sent };
}

const noToken = { header: () => undefined } as unknown as Request;

describe("requireAppCheck", () => {
  for (const [name, env] of [
    ["in production", {}],
    ["in the emulator of a real project", { FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "tieryourlife" }],
    ["outside the emulator with a demo project id", { GCLOUD_PROJECT: "demo-tieryourlife" }],
  ] as const) {
    it(`refuses a request without a token ${name}`, async () => {
      setEnv(env);
      const { response, sent } = fakeResponse();
      assert.equal(await requireAppCheck(noToken, response), false);
      assert.equal(sent.status, 401);
      assert.deepEqual(sent.body, { error: "Missing App Check token", code: APP_UNVERIFIED });
    });
  }

  it("lets a request through without a token in the demo emulator", async () => {
    setEnv(DEMO);
    const { response, sent } = fakeResponse();
    assert.equal(await requireAppCheck(noToken, response), true);
    assert.equal(sent.status, undefined);
  });
});

describe("the outbound stubs in the demo emulator", () => {
  it("finds every picture safe without asking Vision", async () => {
    setEnv(DEMO);
    assert.deepEqual(await realSafeSearch([Buffer.from("a"), Buffer.from("b")]), [SAFE_VERDICT, SAFE_VERDICT]);
  });

  it("finds nothing in the words without asking the classifier", async () => {
    setEnv(DEMO);
    assert.deepEqual(await realModeration("Best sex scenes in cinema"), { sexual: 0, derogatory: 0, profanity: 0 });
  });

  it("finds no pictures without asking a catalogue or Firestore", async () => {
    setEnv(DEMO);
    const input = { typed: "alien", scope: "all" as const, language: "en", page: 1, forcedWeb: true, uid: "someone" };
    assert.deepEqual(await searchPictures({ ...input, quick: false }), { items: [], hasMore: false, notices: [] });
    assert.deepEqual(await searchPictures({ ...input, quick: true }), { items: [], hasMore: false, notices: [], rest: false });
  });
});
