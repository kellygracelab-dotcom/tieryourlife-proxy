import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { outsideAddressesIn } from "../src/outsidePictures";
import { searchPictures } from "../src/pictureSearch";
import { DISABLED_SOURCES, quickSourcesFor, sourcesFor, PICTURE_SCOPES, type PictureHit } from "../src/pictureSources";
import { fold } from "../src/search";
import { cacheHoldsDeezer, deezerOnList } from "../scripts/count-deezer-covers";

const DEEZER_HIT: PictureHit = {
  id: "deezer:302127",
  title: "Discovery",
  subtitle: "Daft Punk",
  imageUrl: "https://cdn-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/1000x1000-000000-80-0-0.jpg",
  thumbUrl: "https://e-cdns-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/500x500-000000-80-0-0.jpg",
  source: "deezer",
  kind: "album",
};

const claim = (value: unknown) => [{ mainsnak: { datavalue: { value } } }];

/**
 * What the web answers: Wikidata knows the album, the band (by a wide photo)
 * and a TV channel; Deezer would know the album too; every other catalogue knows nothing.
 */
function answer(url: string): unknown {
  const parsed = new URL(url);
  if (parsed.host.endsWith("deezer.com")) {
    return { data: [{ id: 302127, title: "Discovery", cover_xl: DEEZER_HIT.imageUrl, artist: { name: "Daft Punk" } }] };
  }
  if (parsed.host === "www.wikidata.org" && parsed.searchParams.get("action") === "wbsearchentities") {
    return { search: [{ id: "Q209538" }, { id: "Q1" }, { id: "Q3" }] };
  }
  if (parsed.host === "www.wikidata.org") {
    return {
      entities: {
        Q209538: {
          labels: { en: { value: "Discovery" } },
          descriptions: { en: { value: "2001 studio album by Daft Punk" } },
          claims: { P31: claim({ id: "Q482994" }), P18: claim("Discovery cover.jpg") },
        },
        Q1: { labels: { en: { value: "Discovery Channel" } }, claims: { P31: claim({ id: "Q1616075" }), P154: claim("Discovery logo.png") } },
        Q3: { labels: { en: { value: "Daft Punk" } }, claims: { P31: claim({ id: "Q9212979" }), P136: claim({ id: "Q11286" }), P18: claim("Daft Punk on stage.jpg") } },
      },
    };
  }
  if (parsed.host === "commons.wikimedia.org") {
    return {
      query: {
        pages: {
          "1": { title: "File:Discovery cover.jpg", imageinfo: [{ width: 600, height: 600 }] },
          "2": { title: "File:Discovery logo.png", imageinfo: [{ width: 600, height: 600 }] },
          "3": { title: "File:Daft Punk on stage.jpg", imageinfo: [{ width: 1200, height: 800 }] },
        },
      },
    };
  }
  return {};
}

let fakes: Fakes;
let asked: string[];
beforeEach(() => {
  fakes = install();
  asked = [];
  delete process.env.SERPER_API_KEY;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

const search = (scope: "music" | "all", quick = false) =>
  searchPictures({ typed: "Discovery", scope, language: "en", page: 1, forcedWeb: false, quick, uid: "someone" });

const fromDeezer = (hit: PictureHit) => hit.source === "deezer" || /(^|\.)dzcdn\.net$/.test(new URL(hit.imageUrl).host);
const askedDeezer = () => asked.filter((url) => new URL(url).host.endsWith("deezer.com"));

describe("Deezer is off", () => {
  it("is asked in no scope, quick or whole", () => {
    assert.deepEqual(DISABLED_SOURCES, ["deezer"]);
    for (const scope of PICTURE_SCOPES) {
      assert.ok(!sourcesFor(scope).includes("deezer"), scope);
      assert.ok(!quickSourcesFor(scope).includes("deezer"), scope);
    }
    assert.deepEqual(sourcesFor("music"), ["wikidata"]);
  });

  it("music finds Wikidata's pictures and asks Deezer nothing", async () => {
    for (const quick of [true, false]) {
      const found = await search("music", quick);
      assert.ok(found);
      assert.deepEqual(found.items.map((hit) => hit.id), ["wikidata:Q209538", "wikidata:Q3"], `quick ${quick}`);
    }
    assert.deepEqual(askedDeezer(), []);
  });

  it("all brings nothing from Deezer and asks it nothing", async () => {
    for (const quick of [true, false]) {
      const found = await search("all", quick);
      assert.ok(found);
      assert.ok(found.items.length > 0);
      assert.equal(found.items.filter(fromDeezer).length, 0);
    }
    assert.deepEqual(askedDeezer(), []);
  });

  it("an answer cached with Deezer's hits before is not served", async () => {
    // The key as the proxy wrote it before Deezer was turned off (CACHE_SHAPE 6).
    const oldKey = (scope: string, web: boolean, quick: boolean) =>
      createHash("sha256").update([6, fold("Discovery"), scope, "en", 1, web ? "web" : "", quick ? "quick" : ""].join("|")).digest("hex");
    const cached = { items: [DEEZER_HIT], hasMore: true, at: { toMillis: () => Date.now() } };
    for (const scope of ["music", "all"]) {
      for (const [web, quick] of [[false, false], [true, false], [false, true]] as const) {
        fakes.db.seed(`pictureCache/${oldKey(scope, web, quick)}`, cached);
      }
    }
    for (const scope of ["music", "all"] as const) {
      for (const quick of [true, false]) {
        const found = await search(scope, quick);
        assert.ok(found);
        assert.equal(found.items.filter(fromDeezer).length, 0, `${scope} quick ${quick}`);
      }
    }
    const music = await search("music");
    assert.deepEqual(music?.items.map((hit) => hit.id), ["wikidata:Q209538", "wikidata:Q3"]);
    assert.deepEqual(askedDeezer(), []);
  });

  it("Deezer's covers on a list are never copied into our storage", () => {
    const list = { items: [{ imageUrl: DEEZER_HIT.imageUrl }, { imageUrl: DEEZER_HIT.thumbUrl }], coverImageUrl: DEEZER_HIT.imageUrl, previewImages: [DEEZER_HIT.thumbUrl as string] };
    assert.deepEqual(outsideAddressesIn(list, "list1", "fake-bucket"), []);
  });
});

describe("music from Wikidata", () => {
  it("takes a band's wide photo and leaves out what is not music; all keeps both", async () => {
    const music = await search("music");
    assert.deepEqual(music?.items.map((hit) => hit.title), ["Discovery", "Daft Punk"]);
    const all = await search("all");
    assert.deepEqual(all?.items.map((hit) => hit.id).sort(), ["wikidata:Q1", "wikidata:Q209538", "wikidata:Q3"]);
  });
});

describe("counting Deezer's covers", () => {
  it("finds them on cards, cover and collage, and in a cached answer", () => {
    const found = deezerOnList({
      items: [{ imageUrl: DEEZER_HIT.imageUrl }, { imageUrl: "https://image.tmdb.org/t/p/w500/a.jpg" }, { imageUrl: DEEZER_HIT.thumbUrl }],
      coverImageUrl: DEEZER_HIT.imageUrl,
      previewImages: ["https://upload.wikimedia.org/a.jpg", DEEZER_HIT.thumbUrl],
    });
    assert.equal(found.items, 2);
    assert.deepEqual([...found.fields].sort(), ["coverImageUrl", "items[].imageUrl", "previewImages[]"]);
    assert.equal(deezerOnList({ items: [{ imageUrl: "https://dzcdn.net.example/a.jpg" }] }).urls.size, 0);
    assert.equal(cacheHoldsDeezer({ items: [DEEZER_HIT] }), true);
    assert.equal(cacheHoldsDeezer({ items: [{ ...DEEZER_HIT, source: "wikidata", imageUrl: "https://upload.wikimedia.org/a.jpg", thumbUrl: null }] }), false);
  });
});
