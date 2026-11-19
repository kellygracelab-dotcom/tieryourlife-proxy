import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Response } from "express";
import type { Identity } from "../src/auth";
import { CLOCK_AHEAD_MS } from "../src/started";
import { COLOUR_NAMES, PRESET_NAMES, colourLands, readColourBody, settingsRoute, settingsWire } from "../src/settings";
import { install, type Fakes } from "./fakeFirebase";

interface Vectors {
  tolerance: number;
  names: Record<string, string>;
  presets: Record<string, { palettes: Record<string, { hue: number; chroma: number }>; mainButtonNearestTier: Record<"light" | "dark", { deltaE2000: number }>; light: Record<string, string>; dark: Record<string, string> }>;
  ownHues: { hue: number; light: Record<string, string>; dark: Record<string, string> }[];
  settingValues: { accepted: unknown[]; refused: { body: unknown; detail: string }[] };
}

// The file Web and Android copy into their own tests unchanged.
const functionsDir = join(__dirname, "..", "..");
const vectors = JSON.parse(readFileSync(join(functionsDir, "test", "theme-vectors.json"), "utf-8")) as Vectors;
const NOW = 1_800_000_000_000;

describe("the colour vectors", () => {
  it("are what Material Color Utilities makes today", () => {
    const run = spawnSync(process.execPath, [join(functionsDir, "scripts", "theme-vectors.mjs"), "--check"], { encoding: "utf-8" });
    assert.equal(run.status, 0, run.stderr);
  });

  it("name every colour the server takes, with a table for each ready one", () => {
    assert.deepEqual(Object.keys(vectors.names).sort(), [...COLOUR_NAMES].sort());
    assert.deepEqual(Object.keys(vectors.presets).sort(), [...PRESET_NAMES].sort());
  });

  // The Designer's picks of 19.11.2026: matcha dark 9.2 and sky dark 9.5 were taken knowingly.
  it("keep each ready colour's main button clear of the nearest tier colour", () => {
    for (const [name, one] of Object.entries(vectors.presets)) {
      assert.ok(one.mainButtonNearestTier.light.deltaE2000 >= 9, `${name} light`);
      assert.ok(one.mainButtonNearestTier.dark.deltaE2000 >= 9, `${name} dark`);
    }
  });

  it("give every ready colour and every hue all the roles, light and dark", () => {
    for (const one of [...Object.values(vectors.presets), ...vectors.ownHues]) {
      assert.equal(Object.keys(one.light).length, 36);
      assert.deepEqual(Object.keys(one.dark), Object.keys(one.light));
      for (const colour of [...Object.values(one.light), ...Object.values(one.dark)]) assert.match(colour, /^#[0-9A-F]{6}$/);
    }
  });
});

describe("a colour as a device sends it", () => {
  it("takes the values the file lists, and refuses the others naming the field", () => {
    for (const body of vectors.settingValues.accepted) assert.equal(readColourBody(body, NOW).ok, true, JSON.stringify(body));
    for (const { body, detail } of vectors.settingValues.refused) assert.deepEqual(readColourBody(body, NOW), { ok: false, detail }, JSON.stringify(body));
  });

  it("keeps the own hue with a ready colour, and takes a clock far ahead as the server's", () => {
    assert.deepEqual(readColourBody({ name: "sky", hue: 40, changedAt: NOW - 5 }, NOW), { ok: true, choice: { name: "sky", hue: 40 }, changedAt: NOW - 5 });
    const ahead = readColourBody({ name: "sky", changedAt: NOW + CLOCK_AHEAD_MS + 1 }, NOW);
    assert.deepEqual(ahead, { ok: true, choice: { name: "sky", hue: null }, changedAt: NOW });
  });

  it("lets the later change win, an equal one too", () => {
    const stored = { name: "matcha" as const, hue: null, changedAt: 100, updatedAt: 5 };
    assert.equal(colourLands(null, 1), true);
    assert.equal(colourLands(stored, 101), true);
    assert.equal(colourLands(stored, 100), true);
    assert.equal(colourLands(stored, 99), false);
    assert.deepEqual(settingsWire(null), { colour: null, photo: null });
  });
});

function fakeResponse() {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return response;
    },
    setHeader() {
      return response;
    },
  };
  return { response: response as unknown as Response, sent };
}

const person = (uid: string, isAnonymous = false) => ({ uid, isAnonymous, name: null, picture: null }) as unknown as Identity;

async function call(method: string, segments: string[], identity: Identity, body: unknown = undefined) {
  const { response, sent } = fakeResponse();
  await settingsRoute({ method, body }, response, identity, segments);
  return sent;
}

describe("GET and PUT /boards/settings", () => {
  let fakes: Fakes;
  beforeEach(() => {
    fakes = install();
  });
  afterEach(() => fakes.restore());

  it("keeps a guest's choice on the device", async () => {
    assert.equal((await call("GET", ["settings"], person("guest1", true))).status, 403);
    assert.equal((await call("PUT", ["settings", "colour"], person("guest1", true), { name: "sky", changedAt: Date.now() })).body?.code, "NOT_SIGNED_IN");
  });

  it("answers nothing chosen, then the choice, and a lost write with what is kept", async () => {
    const me = person("me");
    assert.deepEqual((await call("GET", ["settings"], me)).body, { colour: null, photo: null });
    const now = Date.now();
    const first = await call("PUT", ["settings", "colour"], me, { name: "custom", hue: 300, changedAt: now - 1000 });
    assert.equal(first.status, 200);
    assert.equal(first.body?.landed, true);
    assert.equal(first.body?.name, "custom");
    const older = await call("PUT", ["settings", "colour"], me, { name: "peach", hue: null, changedAt: now - 2000 });
    assert.deepEqual({ ...older.body }, { ...first.body, landed: false });
    const later = await call("PUT", ["settings", "colour"], me, { name: "matcha", hue: 300, changedAt: now - 500 });
    assert.equal(later.body?.landed, true);
    assert.ok((later.body?.updatedAt as number) > (first.body?.updatedAt as number));
    const read = await call("GET", ["settings"], me);
    assert.deepEqual(read.body, { colour: { name: "matcha", hue: 300, changedAt: now - 500, updatedAt: later.body?.updatedAt }, photo: null });
    assert.deepEqual(fakes.db.get("accounts/me/settings/appearance"), { colour: { name: "matcha", hue: 300, changedAt: now - 500, updatedAt: later.body?.updatedAt } });
  });

  it("refuses a bad colour, an erased account, other addresses and other verbs", async () => {
    const me = person("me");
    assert.deepEqual((await call("PUT", ["settings", "colour"], me, { name: "rose", changedAt: Date.now() })).body?.detail, "name");
    fakes.db.seed("erasedAccounts/gone", { erasedAt: 1 });
    assert.equal((await call("PUT", ["settings", "colour"], person("gone"), { name: "sky", changedAt: Date.now() })).body?.code, "ACCOUNT_ERASED");
    assert.equal((await call("GET", ["settings", "theme"], me)).status, 404);
    assert.equal((await call("GET", ["settings", "colour", "x"], me)).status, 404);
    assert.equal((await call("PUT", ["settings"], me, {})).status, 405);
    assert.equal((await call("GET", ["settings", "colour"], me)).status, 405);
  });
});
