import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUB_PICTURE } from "../src/emulator";
import {
  checkedFace,
  copyOutside,
  isCatalogueAddress,
  isOurCopy,
  MAX_OUTSIDE_PICTURES_PER_LIST,
  outsideAddressesIn,
  outsideName,
  withCopies,
  type FetchedPicture,
  type OutsideTools,
} from "../src/outsidePictures";
import { pictureTypeOf } from "../src/pictureBytes";
import { gifOf, webpOf } from "./pictureFixtures";
import { downloadPicture } from "../src/pictureSearch";
import { addressOf, foreignCopyOf, isCopiedFrom, sourcesInNames } from "../src/publishedPictures";
import { decidePublish, settle } from "../src/publishing";
import { MAX_OWN_PICTURES_PER_LIST, type SafeSearchVerdict } from "../src/safety";

const BUCKET = "tieryourlife.firebasestorage.app";
const LIST = "AbCdEfGhIjKlMnOpQrSt";
const OTHER = "ZyXwVuTsRqPoNmLkJiHg";
const POSTER = "https://image.tmdb.org/t/p/w500/a.jpg";
const TRACKER = "https://attacker.example/track.gif?viewer=1";
const INSIDE = "https://10.0.0.1/internal.png";
const FACE = "https://attacker.example/face.jpg";
const SAFE: SafeSearchVerdict = { adult: "VERY_UNLIKELY", racy: "VERY_UNLIKELY", violence: "VERY_UNLIKELY" };
const ADULT: SafeSearchVerdict = { ...SAFE, adult: "VERY_LIKELY" };

interface Fake extends OutsideTools {
  files: Map<string, Buffer>;
  fetched: string[];
  looked: number;
  used: number;
  maxInFlight: number;
}

function fakeTools({
  pictures = {},
  verdicts = {},
  left = 1000,
  slow = new Set<string>(),
  onFetch = () => undefined,
}: {
  pictures?: Record<string, FetchedPicture>;
  verdicts?: Record<string, SafeSearchVerdict | null>;
  left?: number;
  slow?: Set<string>;
  onFetch?: (count: number) => unknown;
} = {}): Fake {
  const byBytes = new Map<Buffer, string>();
  let inFlight = 0;
  const fake: Fake = {
    bucket: BUCKET,
    files: new Map(),
    fetched: [],
    looked: 0,
    used: 0,
    maxInFlight: 0,
    namesIn: async (folder) =>
      new Set([...fake.files.keys()].filter((path) => path.startsWith(folder)).map((path) => path.slice(folder.length))),
    save: async (path, bytes) => {
      fake.files.set(path, bytes);
    },
    remove: async (path) => {
      fake.files.delete(path);
    },
    fetch: async (url, stop) => {
      fake.fetched.push(url);
      inFlight++;
      fake.maxInFlight = Math.max(fake.maxInFlight, inFlight);
      onFetch(fake.fetched.length);
      try {
        if (slow.has(url)) {
          await new Promise((resolve, reject) => {
            if (stop.aborted) reject(new Error("aborted"));
            stop.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        const answer = pictures[url] ?? { bytes: Buffer.concat([STUB_PICTURE, Buffer.from(url)]), type: "image/png" };
        if ("bytes" in answer) byBytes.set(answer.bytes, url);
        return answer;
      } finally {
        inFlight--;
      }
    },
    lookAt: async (bytes) => {
      fake.looked++;
      const url = byBytes.get(bytes) ?? "";
      return url in verdicts ? verdicts[url] ?? null : SAFE;
    },
    reserve: async (count) => {
      if (fake.used + count > left) return false;
      fake.used += count;
      return true;
    },
    giveBack: async (count) => {
      fake.used -= count;
    },
  };
  return fake;
}

const copyAddress = (folder: string, url: string) => addressOf(BUCKET, `${folder}${outsideName(url)}`);

describe("which pictures are catalogue art", () => {
  it("knows the catalogues the app and the site search", () => {
    for (const url of [
      POSTER,
      "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png",
      "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg",
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/library_600x900_2x.jpg",
      "https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg",
      "https://covers.openlibrary.org/b/id/1-L.jpg",
      "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpg",
      "https://commons.wikimedia.org/wiki/Special:FilePath/Cat.jpg?width=600",
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg",
    ]) assert.ok(isCatalogueAddress(url), url);
  });

  it("does not take a lookalike, another scheme, a port or a name before the host for one", () => {
    for (const url of [
      TRACKER,
      INSIDE,
      "https://image.tmdb.org.attacker.example/a.jpg",
      "https://attacker.example/image.tmdb.org/a.jpg",
      "http://image.tmdb.org/t/p/w500/a.jpg",
      "https://image.tmdb.org:8443/t/p/w500/a.jpg",
      "https://user@image.tmdb.org/t/p/w500/a.jpg",
      "https://sub.image.tmdb.org/a.jpg",
      "not a url",
    ]) assert.equal(isCatalogueAddress(url), false, url);
  });
});

describe("the pictures of a list that have to be copied", () => {
  it("are every address not a catalogue's, not this list's copy, and not another list's copy", () => {
    const own = addressOf(BUCKET, `published/${LIST}/p1`);
    const theirs = addressOf(BUCKET, `published/${OTHER}/p2`);
    const posing = `https://attacker.example/v0/b/${BUCKET}/o/published%2F${LIST}%2Fx.jpg`;
    const elsewhere = addressOf("another-bucket", `published/${LIST}/p1`);
    const list = {
      items: [{ imageUrl: POSTER }, { imageUrl: TRACKER }, { imageUrl: own }, { imageUrl: theirs }, { imageUrl: posing }, { imageUrl: elsewhere }, { imageUrl: null }],
      coverImageUrl: TRACKER,
      previewImages: [INSIDE, POSTER],
    };
    assert.deepEqual(outsideAddressesIn(list, LIST, BUCKET), [TRACKER, posing, elsewhere, INSIDE]);
  });

  it("are found in what a publication brings, cover and collage included", () => {
    const decision = decidePublish({
      body: {
        title: "Films",
        category: "movies",
        tiers: [{ label: "S", colorLight: "#ff0000", colorDark: "#aa0000" }],
        items: [{ title: "A", imageUrl: POSTER }, { title: "B", imageUrl: "https://pictures.example/b.jpg" }],
        coverImageUrl: TRACKER,
        coverImageUrls: [INSIDE, POSTER],
      },
      isAnonymous: false,
      listsAlreadyPublished: 0,
      uploaderUid: "u1",
    });
    assert.ok(decision.ok);
    assert.deepEqual(
      outsideAddressesIn(settle(decision.draft, new Map()), LIST, BUCKET).sort(),
      ["https://pictures.example/b.jpg", INSIDE, TRACKER].sort(),
    );
  });

  it("know an own copy only by our bucket's own address", () => {
    assert.ok(isOurCopy(addressOf(BUCKET, `published/${LIST}/w-1`), BUCKET, `published/${LIST}/`));
    assert.equal(isOurCopy(addressOf(BUCKET, `published/${LIST}/a/b`), BUCKET, `published/${LIST}/`), false);
    assert.equal(isOurCopy(addressOf(BUCKET, `published/${OTHER}/w-1`), BUCKET, `published/${LIST}/`), false);
  });

  it("are capped like one's own photographs", () => {
    assert.equal(MAX_OUTSIDE_PICTURES_PER_LIST, MAX_OWN_PICTURES_PER_LIST);
  });
});

describe("copying pictures from other sites", () => {
  const folder = `published/${LIST}/`;

  it("looks at each, keeps a copy, and the list points at the copy", async () => {
    const tools = fakeTools();
    const done = await copyOutside(folder, [TRACKER, "https://pictures.example/b.jpg"], tools);
    assert.ok(done.ok);
    assert.equal(done.copies.get(TRACKER), copyAddress(folder, TRACKER));
    assert.equal(tools.looked, 2);
    assert.deepEqual([...tools.files.keys()].sort(), [folder + outsideName(TRACKER), folder + outsideName("https://pictures.example/b.jpg")].sort());
    const list = withCopies({ items: [{ imageUrl: TRACKER }, { imageUrl: POSTER }], coverImageUrl: TRACKER, previewImages: [TRACKER, POSTER] }, done.copies);
    assert.deepEqual(list.items.map((item) => item.imageUrl), [copyAddress(folder, TRACKER), POSTER]);
    assert.equal(list.coverImageUrl, copyAddress(folder, TRACKER));
    assert.deepEqual(list.previewImages, [copyAddress(folder, TRACKER), POSTER]);
  });

  it("does not fetch again a picture this list already holds a copy of", async () => {
    const tools = fakeTools();
    tools.files.set(folder + outsideName(TRACKER), STUB_PICTURE);
    const done = await copyOutside(folder, [TRACKER], tools);
    assert.ok(done.ok);
    assert.equal(done.copies.get(TRACKER), copyAddress(folder, TRACKER));
    assert.deepEqual(tools.fetched, []);
    assert.equal(tools.used, 0);
  });

  it("drops what cannot be fetched, is not a picture, or Vision says nothing about", async () => {
    const tools = fakeTools({
      pictures: {
        [INSIDE]: { error: "NOT_ALLOWED" },
        "https://pictures.example/page.jpg": { bytes: Buffer.from("<html>"), type: "image/jpeg" },
        "https://pictures.example/avif.jpg": { bytes: Buffer.from("....ftypavif"), type: "image/jpeg" },
      },
      verdicts: { "https://pictures.example/blank.png": null },
    });
    const urls = [INSIDE, "https://pictures.example/page.jpg", "https://pictures.example/avif.jpg", "https://pictures.example/blank.png", TRACKER];
    const done = await copyOutside(folder, urls, tools);
    assert.ok(done.ok);
    assert.deepEqual(urls.map((url) => done.copies.get(url) ?? null), [null, null, null, null, copyAddress(folder, TRACKER)]);
    assert.deepEqual([...tools.files.keys()], [folder + outsideName(TRACKER)]);
    const list = withCopies({ items: [{ imageUrl: INSIDE }], coverImageUrl: INSIDE, previewImages: [INSIDE, TRACKER] }, done.copies);
    assert.deepEqual(list, { items: [{ imageUrl: null }], coverImageUrl: null, previewImages: [copyAddress(folder, TRACKER)] });
  });

  it("drops an animated GIF or WebP, which Vision only sees the first frame of", async () => {
    const animatedGif = "https://pictures.example/moving.gif";
    const animatedWebp = "https://pictures.example/moving.webp";
    const stillGif = "https://pictures.example/still.gif";
    const tools = fakeTools({
      pictures: {
        [animatedGif]: { bytes: gifOf(2), type: "image/gif" },
        [animatedWebp]: { bytes: webpOf(["VP8X", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ["ANIM", [0, 0, 0, 0, 0, 0]]), type: "image/webp" },
        [stillGif]: { bytes: gifOf(1), type: "image/gif" },
      },
    });
    const done = await copyOutside(folder, [animatedGif, animatedWebp, stillGif], tools);
    assert.ok(done.ok);
    assert.deepEqual([animatedGif, animatedWebp, stillGif].map((url) => done.copies.get(url) ?? null), [null, null, copyAddress(folder, stillGif)]);
    assert.equal(tools.looked, 1);
  });

  it("refuses the lot over one Vision refuses, and leaves nothing behind", async () => {
    const tools = fakeTools({ verdicts: { "https://pictures.example/adult.jpg": ADULT } });
    const done = await copyOutside(folder, [TRACKER, "https://pictures.example/adult.jpg", "https://pictures.example/c.jpg"], tools, { atOnce: 1 });
    assert.deepEqual(done, { ok: false, refused: { url: "https://pictures.example/adult.jpg", because: "adult" } });
    assert.equal(tools.files.size, 0);
    assert.equal(tools.used, 2, "the one never fetched goes back to the day");
  });

  it("fetches nothing past the account's day", async () => {
    const tools = fakeTools({ left: 1 });
    const done = await copyOutside(folder, [TRACKER, INSIDE], tools);
    assert.deepEqual(done, { ok: false, overDailyLimit: true });
    assert.deepEqual(tools.fetched, []);
  });

  it("fetches a few at a time", async () => {
    const tools = fakeTools();
    const urls = Array.from({ length: 30 }, (_, at) => `https://pictures.example/${at}.jpg`);
    const done = await copyOutside(folder, urls, tools, { atOnce: 4 });
    assert.ok(done.ok);
    assert.equal(tools.maxInFlight, 4);
    assert.equal(tools.files.size, 30);
  });

  it("gives up on what is still loading when its time is up, and gives back what it never began", async () => {
    const urls = Array.from({ length: 5 }, (_, at) => `https://slow.example/${at}.jpg`);
    const timeUp = new AbortController();
    const tools = fakeTools({ slow: new Set(urls), onFetch: (count) => count === 2 && setImmediate(() => timeUp.abort()) });
    const done = await copyOutside(folder, urls, tools, { atOnce: 2, until: timeUp.signal });
    assert.ok(done.ok);
    assert.deepEqual(urls.map((url) => done.copies.get(url) ?? null), urls.map(() => null));
    assert.equal(tools.fetched.length, 2);
    assert.equal(tools.used, 2);
  });
});

describe("an author's face", () => {
  it("keeps a Google account photo and their own checked copy as they are", async () => {
    const tools = fakeTools();
    const google = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
    const own = addressOf(BUCKET, "avatars/u1/p1");
    assert.equal(await checkedFace("u1", google, tools), google);
    assert.equal(await checkedFace("u1", own, tools), own);
    assert.equal(await checkedFace("u1", null, tools), null);
    assert.deepEqual(tools.fetched, []);
  });

  it("takes only an account photo's path on Google's host as one", async () => {
    const tools = fakeTools();
    const dashed = "https://lh3.googleusercontent.com/a-/AOh14Gj=s96-c";
    assert.equal(await checkedFace("u1", dashed, tools), dashed);
    for (const url of [
      "https://lh3.googleusercontent.com/d/1AbCdEf",
      "https://lh3.googleusercontent.com/pw/AP1GczN",
      "https://lh3.googleusercontent.com/blogger_img_proxy/AEn0k_s",
      "https://lh3.googleusercontent.com/ab/x",
      "https://lh3.googleusercontent.com/a",
    ]) assert.equal(await checkedFace("u1", url, tools), copyAddress("avatars/u1/", url), url);
    assert.equal(tools.fetched.length, 5);
  });

  it("copies any other picture into their avatars after a look, once", async () => {
    const tools = fakeTools();
    const copy = copyAddress("avatars/u1/", FACE);
    assert.equal(await checkedFace("u1", FACE, tools), copy);
    assert.equal(await checkedFace("u1", FACE, tools), copy);
    assert.equal(tools.fetched.length, 1);
    assert.equal(await checkedFace("u1", POSTER, tools), copyAddress("avatars/u1/", POSTER));
    assert.equal(await checkedFace("u1", addressOf(BUCKET, "avatars/u2/p1"), tools), copyAddress("avatars/u1/", addressOf(BUCKET, "avatars/u2/p1")));
  });

  it("is no face when the picture is refused, unreachable, past the day, or no https address", async () => {
    assert.equal(await checkedFace("u1", FACE, fakeTools({ verdicts: { [FACE]: ADULT } })), null);
    assert.equal(await checkedFace("u1", FACE, fakeTools({ pictures: { [FACE]: { error: "UNREACHABLE" } } })), null);
    assert.equal(await checkedFace("u1", FACE, fakeTools({ left: 0 })), null);
    assert.equal(await checkedFace("u1", "http://attacker.example/face.jpg", fakeTools()), null);
    assert.equal(await checkedFace("u1", "https://lh3.googleusercontent.com.attacker.example/a", fakeTools({ left: 0 })), null);
  });
});

describe("a copy of a list with pictures from other sites", () => {
  it("takes its own copy of each and still knows where it came from", () => {
    const name = outsideName(TRACKER);
    const copy = foreignCopyOf(OTHER, addressOf(BUCKET, `published/${LIST}/${name}`));
    assert.deepEqual(copy, { from: `published/${LIST}/${name}`, to: `published/${OTHER}/${LIST}-${name}`, list: LIST });
    assert.deepEqual(sourcesInNames([name, `${LIST}-${name}`]), [LIST]);
    assert.equal(isCopiedFrom(`${LIST}-${name}`, LIST), true);
    assert.equal(isCopiedFrom(name, LIST), false);
  });
});

describe("fetching a picture from another site", () => {
  it("refuses a private address, plain http and a name before the host before asking anybody", async () => {
    assert.deepEqual(await downloadPicture(new URL(INSIDE)), { error: "NOT_ALLOWED" });
    assert.deepEqual(await downloadPicture(new URL("https://127.0.0.1/a.png")), { error: "NOT_ALLOWED" });
    assert.deepEqual(await downloadPicture(new URL("http://pictures.example/a.png")), { error: "NOT_ALLOWED" });
    assert.deepEqual(await downloadPicture(new URL("https://user:pw@pictures.example/a.png")), { error: "NOT_ALLOWED" });
  });

  it("reads the type off the bytes", () => {
    assert.equal(pictureTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(pictureTypeOf(STUB_PICTURE), "image/png");
    assert.equal(pictureTypeOf(Buffer.from("GIF89a\x01\x00", "latin1")), "image/gif");
    assert.equal(pictureTypeOf(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
    assert.equal(pictureTypeOf(Buffer.from("<svg xmlns=")), null);
  });
});
