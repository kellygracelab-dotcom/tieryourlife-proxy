import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogueCopyTools,
  copyCataloguePictures,
  copySourcesOf,
  keepCopiesForLater,
  oneAtATime,
  WIKIMEDIA_AT_ONCE,
  type Download,
  type SharedCopies,
} from "../src/cataloguePictures";
import { STUB_PICTURE } from "../src/emulator";
import { outsideName, type OutsideTools } from "../src/outsidePictures";
import { commonsDirectThumb } from "../src/pictureAttribution";

const ACADIA = "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e9/Acadia_National_Park_02.JPG/500px-Acadia_National_Park_02.JPG";
const ACADIA_DIRECT = "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e9/Acadia_National_Park_02.JPG/500px-Acadia_National_Park_02.JPG";
const ACADIA_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath/Acadia_National_Park_02.JPG?width=500";
const POSTER = "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg";
const PICTURE = { bytes: STUB_PICTURE, type: "image/png" };
const commons = (n: number) => `https://commons.wikimedia.org/wiki/Special:FilePath/Park_${n}.jpg?width=600`;

function memoryBucket(): OutsideTools & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    bucket: "b",
    namesIn: async (folder) => new Set([...files.keys()].filter((path) => path.startsWith(folder)).map((path) => path.slice(folder.length))),
    save: async (path, bytes) => void files.set(path, bytes),
    remove: async (path) => void files.delete(path),
    fetch: async () => ({ error: "UNREACHABLE" }),
    lookAt: async () => null,
    reserve: async () => true,
    giveBack: async () => undefined,
  };
}

/** The shared folder as files of [bucket] under `published/catalogue/`. */
function memoryShared(bucket: { files: Map<string, Buffer> }): SharedCopies & { kept: string[] } {
  const kept: string[] = [];
  return {
    kept,
    read: async (name) => {
      const bytes = bucket.files.get(`published/catalogue/${name}`);
      return bytes ? { bytes, type: "image/png" } : null;
    },
    keep: async (path, name) => {
      const bytes = bucket.files.get(path);
      if (!bytes) throw new Error("no such file");
      bucket.files.delete(path);
      if (!bucket.files.has(`published/catalogue/${name}`)) bucket.files.set(`published/catalogue/${name}`, bytes);
      kept.push(name);
    },
  };
}

describe("a Commons picture copied", () => {
  it("is asked for at its 500 px thumbnail where Wikimedia keeps it, then through Special:FilePath", () => {
    assert.equal(commonsDirectThumb("Acadia National Park 02.JPG", 500), ACADIA_DIRECT);
    assert.equal(commonsDirectThumb("Example.svg", 500), "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/84/Example.svg/500px-Example.svg.png");
    // MediaWiki's own addresses keep parentheses as they are, and so does encodeURIComponent.
    assert.match(commonsDirectThumb("Café (1).jpg", 500)!, /\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/Caf%C3%A9_\(1\)\.jpg\/500px-Caf%C3%A9_\(1\)\.jpg$/);
    assert.equal(commonsDirectThumb("Scan.tif", 500), null);
    assert.equal(commonsDirectThumb("Talk.pdf", 500), null);
    assert.deepEqual(copySourcesOf(ACADIA), [ACADIA_DIRECT, ACADIA_FILEPATH]);
    assert.deepEqual(copySourcesOf(POSTER), [POSTER]);
    assert.deepEqual(copySourcesOf("https://example.com/a.jpg"), []);
  });

  it("is looked for the second way only when the first does not have it", async () => {
    const asked: string[] = [];
    const download: Download = async (url) => (asked.push(url.href), url.hostname === "thumb.wikimedia.org" ? { error: "UNREACHABLE" } : PICTURE);
    const tools = catalogueCopyTools(memoryBucket(), { shared: memoryShared(memoryBucket()), download });
    assert.deepEqual(await tools.fetch(ACADIA, AbortSignal.timeout(5000)), PICTURE);
    assert.deepEqual(asked, [ACADIA_DIRECT, ACADIA_FILEPATH]);
  });

  it("asks Wikimedia a few at a time, and other catalogues as before", async () => {
    let now = 0;
    let most = 0;
    const download: Download = async () => {
      most = Math.max(most, ++now);
      await new Promise((resolve) => setTimeout(resolve, 20));
      now--;
      return PICTURE;
    };
    const tools = catalogueCopyTools(memoryBucket(), { shared: memoryShared(memoryBucket()), download });
    await Promise.all(Array.from({ length: 12 }, (_, n) => tools.fetch(commons(n), AbortSignal.timeout(5000))));
    assert.equal(most, WIKIMEDIA_AT_ONCE);
    most = 0;
    await Promise.all(Array.from({ length: 12 }, (_, n) => tools.fetch(`https://image.tmdb.org/t/p/w500/${n}.jpg`, AbortSignal.timeout(5000))));
    assert.equal(most, 12);
  });

  it("waits out a 429 while the window lasts, and gives up when it is over", async () => {
    let calls = 0;
    const busyOnce: Download = async () => (++calls === 1 ? { error: "SOURCE_BUSY", retryAtMs: Date.now() + 50 } : PICTURE);
    const started = Date.now();
    const tools = catalogueCopyTools(memoryBucket(), { shared: memoryShared(memoryBucket()), download: busyOnce });
    assert.deepEqual(await tools.fetch(ACADIA, AbortSignal.timeout(5000)), PICTURE);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 900, "waited at least the first second");

    const alwaysBusy: Download = async () => ({ error: "SOURCE_BUSY", retryAtMs: Date.now() + 60_000 });
    const quick = Date.now();
    const busy = catalogueCopyTools(memoryBucket(), { shared: memoryShared(memoryBucket()), download: alwaysBusy });
    assert.equal(((await busy.fetch(ACADIA, AbortSignal.timeout(200))) as { error: string }).error, "SOURCE_BUSY");
    assert.ok(Date.now() - quick < 2000, "no wait past the window");
  });

  it("is taken from the shared folder when a copy is there, without asking Wikimedia", async () => {
    const bucket = memoryBucket();
    bucket.files.set(`published/catalogue/${outsideName(ACADIA)}`, Buffer.from("kept"));
    const download: Download = async () => assert.fail("Wikimedia asked");
    const tools = catalogueCopyTools(bucket, { shared: memoryShared(bucket), download });
    assert.deepEqual(await tools.fetch(ACADIA, AbortSignal.timeout(1000)), { bytes: Buffer.from("kept"), type: "image/png" });
  });

  it("is the only kind taken from the shared folder: a TMDB poster is fetched for its own days", async () => {
    const bucket = memoryBucket();
    bucket.files.set(`published/catalogue/${outsideName(POSTER)}`, Buffer.from("old"));
    const asked: string[] = [];
    const download: Download = async (url) => (asked.push(url.href), PICTURE);
    const tools = catalogueCopyTools(bucket, { shared: memoryShared(bucket), download });
    assert.deepEqual(await tools.fetch(POSTER, AbortSignal.timeout(1000)), PICTURE);
    assert.deepEqual(asked, [POSTER]);
  });
});

describe("a house publication sent again after PICTURES_NOT_COPIED", () => {
  it("fetches only the pictures the first attempt did not get, and leaves no attempt's files behind", async () => {
    const urls = Array.from({ length: 10 }, (_, n) => commons(n));
    const bucket = memoryBucket();
    const shared = memoryShared(bucket);
    const asked: string[] = [];
    // The first attempt: Wikimedia busy for the last three, past the window.
    let attempt = 1;
    const download: Download = async (url) => {
      asked.push(url.href);
      return attempt === 1 && /Park_[789]/.test(url.href) ? { error: "SOURCE_BUSY", retryAtMs: Date.now() + 60_000 } : PICTURE;
    };
    const first = await copyCataloguePictures("published/try1/", urls, catalogueCopyTools(bucket, { shared, download }), { nameSuffix: "_p_11111111-1111-1111-1111-111111111111", withinMs: 300 });
    assert.equal(first.copies.size, 7);
    await keepCopiesForLater(first.saved, shared, bucket.remove);
    assert.deepEqual([...bucket.files.keys()].filter((path) => path.startsWith("published/try1/")), []);
    assert.equal(shared.kept.length, 7);

    attempt = 2;
    asked.length = 0;
    const second = await copyCataloguePictures("published/try2/", urls, catalogueCopyTools(bucket, { shared, download }), { nameSuffix: "_p_22222222-2222-2222-2222-222222222222" });
    assert.equal(second.copies.size, 10);
    assert.deepEqual(asked.map((url) => /Park_(\d)/.exec(url)![1]), ["7", "8", "9"]);
  });

  it("removes what it cannot keep", async () => {
    const bucket = memoryBucket();
    bucket.files.set("published/l/w-0123456789abcdef0123456789abcdef_p_33333333-3333-3333-3333-333333333333", Buffer.from("a"));
    bucket.files.set("published/l/odd-name", Buffer.from("b"));
    bucket.files.set("published/l/w-fedcba9876543210fedcba9876543210", Buffer.from("c"));
    const broken: SharedCopies = { read: async () => null, keep: async (path) => (path.endsWith("3210") ? undefined : Promise.reject(new Error("down"))) };
    await keepCopiesForLater([...bucket.files.keys()], broken, bucket.remove);
    // Kept (the fake moves nothing), or removed when the move failed or the name is not a copy's.
    assert.deepEqual([...bucket.files.keys()], ["published/l/w-fedcba9876543210fedcba9876543210"]);
  });
});

describe("one job at a time", () => {
  it("runs at most so many, in order", async () => {
    const gate = oneAtATime(2);
    const order: number[] = [];
    let now = 0;
    let most = 0;
    await Promise.all([1, 2, 3, 4, 5].map((n) => gate(async () => {
      most = Math.max(most, ++now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      now--;
    })));
    assert.equal(most, 2);
    assert.deepEqual(order.sort(), [1, 2, 3, 4, 5]);
  });
});
