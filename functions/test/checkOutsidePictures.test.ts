import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUB_PICTURE } from "../src/emulator";
import { checkedFace, copyOutside, outsideAddressesIn, outsideName, type FetchedPicture, type OutsideTools } from "../src/outsidePictures";
import { addressOf } from "../src/publishedPictures";
import type { SafeSearchVerdict } from "../src/safety";
import { gifOf } from "./pictureFixtures";
import {
  attemptOf,
  decidePicture,
  listFieldsAfter,
  picturesOf,
  replacementOf,
  shown,
  type PictureOutcome,
} from "../scripts/check-outside-pictures";

const BUCKET = "tieryourlife.firebasestorage.app";
const LIST = "AbCdEfGhIjKlMnOpQrSt";
const FOLDER = `published/${LIST}/`;
const POSTER = "https://image.tmdb.org/t/p/w500/a.jpg";
const SAFE: SafeSearchVerdict = { adult: "VERY_UNLIKELY", racy: "VERY_UNLIKELY", violence: "VERY_UNLIKELY" };
const RACY: SafeSearchVerdict = { ...SAFE, racy: "VERY_LIKELY" };
const copyOf = (folder: string, url: string) => addressOf(BUCKET, folder + outsideName(url));

function tools(pictures: Record<string, FetchedPicture>, verdicts: Record<string, SafeSearchVerdict | null> = {}, files = new Set<string>()) {
  const byBytes = new Map<Buffer, string>();
  const seen = { fetched: false, saved: false };
  const fake: OutsideTools = {
    bucket: BUCKET,
    namesIn: async (folder) => new Set([...files].filter((path) => path.startsWith(folder)).map((path) => path.slice(folder.length))),
    save: async (path) => {
      files.add(path);
      seen.saved = true;
    },
    remove: async (path) => void files.delete(path),
    fetch: async (url) => {
      seen.fetched = true;
      const picture = pictures[url] ?? { error: "UNREACHABLE" };
      if ("bytes" in picture) byBytes.set(picture.bytes, url);
      return picture;
    },
    lookAt: async (bytes) => {
      const url = byBytes.get(bytes) as string;
      return url in verdicts ? verdicts[url] ?? null : SAFE;
    },
    reserve: async () => true,
    giveBack: async () => undefined,
  };
  return { fake, seen, files };
}

async function one(url: string, made: ReturnType<typeof tools>, dryRun = false): Promise<PictureOutcome> {
  const result = await copyOutside(FOLDER, [url], made.fake, { atOnce: 1, until: AbortSignal.timeout(60_000) });
  return decidePicture(attemptOf(url, result, made.seen, dryRun));
}

const still = (): FetchedPicture => ({ bytes: Buffer.from(STUB_PICTURE), type: "image/png" });

describe("one picture through copyOutside", () => {
  const url = "https://pictures.example/a.png";

  it("is our copy once it passes", async () => {
    const outcome = await one(url, tools({ [url]: still() }));
    assert.deepEqual(outcome, { kind: "copied", address: copyOf(FOLDER, url) });
    assert.equal(replacementOf(outcome, url), copyOf(FOLDER, url));
  });

  it("reuses a copy already in the folder without fetching", async () => {
    const made = tools({}, {}, new Set([FOLDER + outsideName(url)]));
    assert.deepEqual(await one(url, made), { kind: "reused", address: copyOf(FOLDER, url) });
    assert.equal(made.seen.fetched, false);
  });

  it("is null when SafeSearch refuses it", async () => {
    const made = tools({ [url]: still() }, { [url]: RACY });
    const outcome = await one(url, made);
    assert.deepEqual(outcome, { kind: "refused", because: "racy" });
    assert.equal(replacementOf(outcome, url), null);
    assert.equal(made.files.size, 0);
  });

  it("is null when it cannot be fetched, is animated, or Vision says nothing", async () => {
    assert.deepEqual(await one(url, tools({})), { kind: "dropped" });
    assert.deepEqual(await one(url, tools({ [url]: { bytes: gifOf(2), type: "image/gif" } })), { kind: "dropped" });
    assert.deepEqual(await one(url, tools({ [url]: still() }, { [url]: null })), { kind: "dropped" });
  });

  it("in a dry run, a fetch it would make decides nothing", async () => {
    const outcome = await one(url, tools({}), true);
    assert.deepEqual(outcome, { kind: "would_fetch" });
    assert.equal(replacementOf(outcome, url), undefined);
  });

  it("never asks for the daily allowance quietly", () => {
    assert.throws(() => attemptOf(url, { ok: false, overDailyLimit: true }, { fetched: false, saved: false }, false));
  });
});

describe("a face through checkedFace", () => {
  const until = AbortSignal.timeout(60_000);

  it("copies a Google account photo, as any other", async () => {
    const account = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
    const photos = "https://lh3.googleusercontent.com/pw/AP1Gcz=w800";
    const made = tools({ [photos]: still(), [account]: still() });
    assert.deepEqual(decidePicture({ url: account, address: await checkedFace("u1", account, made.fake, { until }), ...made.seen, dryRun: false }), { kind: "copied", address: copyOf("avatars/u1/", account) });
    const address = await checkedFace("u1", photos, made.fake, { until });
    assert.deepEqual(decidePicture({ url: photos, address, ...made.seen, dryRun: false }), { kind: "copied", address: copyOf("avatars/u1/", photos) });
  });

  it("is no face when it is not an address we would fetch", async () => {
    const made = tools({});
    const url = "http://faces.example/a.png";
    assert.deepEqual(decidePicture({ url, address: await checkedFace("u1", url, made.fake, { until }), ...made.seen, dryRun: true }), { kind: "dropped" });
  });
});

describe("listFieldsAfter", () => {
  const web = "https://pictures.example/a.png";
  const gone = "https://pictures.example/b.png";
  const data = {
    items: [{ title: "One", imageUrl: web, tier: 0 }, { title: "Two", imageUrl: POSTER, tier: 1 }, { title: "Three" }],
    coverImageUrl: gone,
    previewImages: [web, gone, POSTER],
  };

  it("touches only the addresses it was given, and drops the refused from the collage", () => {
    const copy = copyOf(FOLDER, web);
    assert.deepEqual(listFieldsAfter(data, new Map([[web, copy], [gone, null]])), {
      items: [{ title: "One", imageUrl: copy, tier: 0 }, { title: "Two", imageUrl: POSTER, tier: 1 }, { title: "Three" }],
      coverImageUrl: null,
      previewImages: [copy, POSTER],
    });
  });

  it("changes nothing a second time", () => {
    const copy = copyOf(FOLDER, web);
    const after = { ...data, ...listFieldsAfter(data, new Map([[web, copy], [gone, null]])) };
    assert.deepEqual(outsideAddressesIn(picturesOf(after), LIST, BUCKET), []);
    assert.equal(listFieldsAfter(after, new Map()), null);
  });

  it("reads what is not a string as no picture", () => {
    assert.deepEqual(picturesOf({ items: [{ imageUrl: 3 }], coverImageUrl: undefined, previewImages: [null, web] }), {
      rawItems: [{ imageUrl: 3 }],
      items: [{ imageUrl: null }],
      coverImageUrl: null,
      previewImages: [web],
    });
  });
});

describe("shown", () => {
  it("leaves out the query, and a face's path", () => {
    assert.equal(shown("https://pictures.example/a.png?viewer=1", false), "https://pictures.example/a.png");
    assert.equal(shown("https://faces.example/me.jpg?u=1", true), "a face at faces.example");
  });
});
