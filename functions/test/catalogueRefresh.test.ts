import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributionsOf } from "../src/cataloguePictures";
import {
  anilistPictures,
  anilistQuery,
  igdbCovers,
  movedFields,
  movedItems,
  openLibraryCover,
  picturesIn,
  planRun,
  probeVerdict,
  PROBE_EVERY_MS,
  TMDB_PER_RUN,
  TMDB_REFRESH_MS,
  tmdbPictureOf,
  type PictureCheck,
} from "../src/catalogueRefresh";
import { attributionOf, catalogueIdOf, cleanAttribution, idFromAddress, MAX_FORMER_URLS, readAttribution } from "../src/pictureAttribution";
import { steamHits, tmdbHits } from "../src/pictureSources";
import { decidePublish } from "../src/publishing";
import { currentAddresses } from "../src/rankings";
import { cardsOf, changedFields, idsFromJobs, sameJson, switchesFor, withAttributions, type ListPictures } from "../scripts/catalogue-pictures";
import { DEFAULT_COPY_SWITCHES } from "../src/pictureCopies";

const POSTER = "https://image.tmdb.org/t/p/w500/abc.jpg";
const NEW_POSTER = "https://image.tmdb.org/t/p/w500/xyz.jpg";
const STEAM = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/70/library_600x900_2x.jpg";
const CHARACTER = "https://s4.anilist.co/file/anilistcdn/character/large/b17-IazKGogQwJ1p.png";
const COVER = "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1abc.jpg";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-13T04:00:00Z");

describe("a catalogue id", () => {
  it("is kept only in each catalogue's one shape", () => {
    assert.equal(catalogueIdOf("tmdb", "tmdb:movie:603"), "tmdb:movie:603");
    assert.equal(catalogueIdOf("tmdb", "tmdb:603"), null);
    assert.equal(catalogueIdOf("anilist", "anilist:c17"), "anilist:c17");
    assert.equal(catalogueIdOf("igdb", "igdb:1942"), "igdb:1942");
    assert.equal(catalogueIdOf("steam", "steam:70"), "steam:70");
    assert.equal(catalogueIdOf("openlibrary", "openlibrary:OL45804W"), "openlibrary:OL45804W");
    assert.equal(catalogueIdOf("steam", "igdb:1942"), null);
    assert.equal(catalogueIdOf("inaturalist", "inaturalist:1"), null);
    assert.equal(catalogueIdOf("tmdb", 603), null);
  });

  it("is read off an address or a catalogue page where they say it", () => {
    assert.equal(idFromAddress(STEAM, null), "steam:70");
    assert.equal(idFromAddress(CHARACTER, null), "anilist:c17");
    assert.equal(idFromAddress(POSTER, "https://www.themoviedb.org/tv/1399"), "tmdb:tv:1399");
    assert.equal(idFromAddress("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg", "https://anilist.co/anime/21"), "anilist:21");
    assert.equal(idFromAddress("https://covers.openlibrary.org/b/id/1-L.jpg", "https://openlibrary.org/works/OL45804W"), "openlibrary:OL45804W");
    assert.equal(idFromAddress(POSTER, "https://anilist.co/anime/21"), null);
    assert.equal(idFromAddress(COVER, "https://www.igdb.com/games/doom"), null);
    assert.equal(idFromAddress("https://example.com/a.jpg", "https://www.themoviedb.org/movie/603"), null);
  });

  it("from a client is kept where the address and page say none, and loses to them where they do", () => {
    assert.equal(attributionOf(COVER, { sentId: "igdb:1942" })?.id, "igdb:1942");
    assert.equal(attributionOf(COVER, { sentId: "steam:70" })?.id, undefined);
    assert.equal(attributionOf(STEAM, { sentId: "steam:99" })?.id, "steam:70");
    assert.equal(attributionOf(POSTER, { sentLink: "https://www.themoviedb.org/movie/603", sentId: "tmdb:movie:1" })?.id, "tmdb:movie:603");
  });

  it("is carried by each catalogue's search hits", () => {
    const [movie] = tmdbHits({ results: [{ media_type: "movie", id: 603, title: "The Matrix", poster_path: "/abc.jpg" }] });
    assert.equal(movie.attribution?.id, "tmdb:movie:603");
    const [game] = steamHits([70], { response: { store_items: [{ appid: 70, name: "Half-Life", assets: { asset_url_format: "steam/apps/70/${FILENAME}", library_capsule: "library_600x900.jpg" } }] } });
    assert.equal(game.attribution?.id, "steam:70");
  });

  it("is read back at publication, and earlier addresses only from the server's own snapshot", () => {
    const decision = decidePublish({ isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "someone", body: {
      title: "Games", category: "games", tiers: [{ label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" }],
      items: [{ title: "Doom", imageUrl: COVER, attribution: { source: "igdb", id: "igdb:1942", formerUrls: [POSTER] } }],
    } });
    assert.ok(decision.ok);
    if (!decision.ok) return;
    assert.deepEqual(decision.draft.items[0].sent, { id: "igdb:1942" });
    const [sent] = attributionsOf([{ imageUrl: COVER, sent: decision.draft.items[0].sent }], new Map());
    assert.deepEqual(sent, { source: "igdb", id: "igdb:1942" });
    const [kept] = attributionsOf([{ imageUrl: COVER, previous: { source: "igdb", id: "igdb:1942", formerUrls: ["https://images.igdb.com/igdb/image/upload/t_cover_big_2x/old.jpg"] } }], new Map());
    assert.deepEqual(kept?.formerUrls, ["https://images.igdb.com/igdb/image/upload/t_cover_big_2x/old.jpg"]);
  });

  it("and earlier addresses are cleaned: catalogue addresses only, the newest five", () => {
    const many = Array.from({ length: 8 }, (_, at) => `https://image.tmdb.org/t/p/w500/${at}.jpg`);
    const clean = cleanAttribution({ source: "tmdb", id: "tmdb:movie:603", formerUrls: [...many, "https://example.com/x.jpg"] });
    assert.deepEqual(clean.formerUrls, many.slice(-MAX_FORMER_URLS));
    assert.equal(cleanAttribution({ source: "tmdb", id: "steam:70" }).id, undefined);
    assert.deepEqual(readAttribution({ source: "steam", id: "steam:70", formerUrls: [STEAM] }), { source: "steam", id: "steam:70", formerUrls: [STEAM] });
  });
});

describe("the house fill's answers", () => {
  it("name an address's id only when every hit that showed it agrees", () => {
    const ids = idsFromJobs([
      { answers: [{ ok: true, hits: [{ id: "tmdb:603", kind: "movie", imageUrl: POSTER }, { id: "igdb:7", kind: "game", imageUrl: COVER }] }] },
      { answers: [{ ok: true, hits: [{ id: "tmdb:603", kind: "movie", imageUrl: POSTER }, { id: "igdb:8", kind: "game", imageUrl: COVER }] }] },
      { answers: [{ ok: true, hits: [{ id: "web:1", kind: "web", imageUrl: "https://example.com/a.jpg" }, { id: "steam:70", imageUrl: STEAM }] }] },
      { answers: "nothing" },
    ]);
    assert.deepEqual([...ids], [[POSTER, "tmdb:movie:603"], [STEAM, "steam:70"]]);
  });
});

describe("a refresh run", () => {
  const lists = [
    { items: [
      { imageUrl: POSTER, attribution: { source: "tmdb", id: "tmdb:movie:603" } },
      { imageUrl: COVER, attribution: { source: "igdb", id: "igdb:1942" } },
      { imageUrl: STEAM },
      { imageUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/published%2Fl%2Fw-0123456789abcdef0123456789abcdef?alt=media" },
      { imageUrl: null },
    ] },
    { snapshot: { items: [{ imageUrl: POSTER }, { imageUrl: "https://image.tmdb.org/t/p/w500/other.jpg" }] } },
  ];

  it("finds each catalogue address of lists and ranking snapshots once, with its id where known", () => {
    const pictures = picturesIn(lists);
    assert.deepEqual(pictures, [
      { url: POSTER, source: "tmdb", id: "tmdb:movie:603" },
      { url: COVER, source: "igdb", id: "igdb:1942" },
      { url: STEAM, source: "steam", id: "steam:70" },
      { url: "https://image.tmdb.org/t/p/w500/other.jpg", source: "tmdb", id: null },
    ]);
  });

  it("asks IGDB every day, TMDB every 90 days, and looks at the rest once a week", () => {
    const pictures = picturesIn(lists);
    const fresh = new Map<string, PictureCheck>(pictures.map((one) => [one.url, { url: one.url, checkedAt: NOW - DAY, refreshedAt: NOW - DAY }]));
    const today = planRun(pictures, fresh, NOW);
    assert.deepEqual(today.igdb.map((one) => one.url), [COVER]);
    assert.deepEqual(today.tmdb, []);
    assert.deepEqual(today.probe, []);
    const stale = new Map<string, PictureCheck>(pictures.map((one) => [one.url, { url: one.url, checkedAt: NOW - PROBE_EVERY_MS, refreshedAt: NOW - TMDB_REFRESH_MS }]));
    const later = planRun(pictures, stale, NOW);
    assert.deepEqual(later.tmdb.map((one) => one.url), [POSTER]);
    assert.deepEqual(later.probe.map((one) => one.url), [STEAM, "https://image.tmdb.org/t/p/w500/other.jpg"]);
  });

  it("asks TMDB for its oldest first, and no more than a run's worth", () => {
    const many = Array.from({ length: TMDB_PER_RUN + 10 }, (_, at) => ({ url: `https://image.tmdb.org/t/p/w500/${at}.jpg`, source: "tmdb" as const, id: `tmdb:movie:${at}` }));
    const checks = new Map<string, PictureCheck>(many.map((one, at) => [one.url, { url: one.url, refreshedAt: NOW - TMDB_REFRESH_MS - at }]));
    const plan = planRun(many, checks, NOW);
    assert.equal(plan.tmdb.length, TMDB_PER_RUN);
    assert.equal(plan.tmdb[0].url, many.at(-1)!.url);
  });

  it("takes 404 and 410 for dead, and nothing else", () => {
    assert.deepEqual([200, 206, 304, 404, 410, 403, 429, 500, null].map(probeVerdict), ["ok", "ok", "ok", "dead", "dead", "unsure", "unsure", "unsure", "unsure"]);
  });

  it("reads each catalogue's answer about its ids", () => {
    assert.equal(tmdbPictureOf("tmdb:movie:603", { poster_path: "/xyz.jpg" }), NEW_POSTER);
    assert.equal(tmdbPictureOf("tmdb:person:287", { profile_path: "/p.jpg", poster_path: "/x.jpg" }), "https://image.tmdb.org/t/p/w500/p.jpg");
    assert.equal(tmdbPictureOf("tmdb:movie:603", { poster_path: null }), null);
    assert.deepEqual([...igdbCovers([{ id: 1942, cover: { image_id: "co2" } }, { id: 7 }])], [["igdb:1942", "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co2.jpg"], ["igdb:7", null]]);
    assert.equal(anilistQuery(["anilist:21", "anilist:c17"]), "query { a0: Media(id: 21) { isAdult coverImage { extraLarge large } } a1: Character(id: 17) { image { large } } }");
    const answer = { data: { a0: { isAdult: false, coverImage: { extraLarge: "https://s4.anilist.co/file/new.jpg" } }, a1: null, a2: { image: { large: "https://example.com/x.jpg" } } } };
    assert.deepEqual([...anilistPictures(["anilist:21", "anilist:c17", "anilist:c3"], answer)], [["anilist:21", "https://s4.anilist.co/file/new.jpg"], ["anilist:c17", null], ["anilist:c3", null]]);
    assert.equal(openLibraryCover({ covers: [-1, 8231856] }), "https://covers.openlibrary.org/b/id/8231856-L.jpg");
    assert.equal(openLibraryCover({}), null);
  });

  it("moves a list to the new address, cover and collage too, remembering where each card was", () => {
    const moves = new Map([[POSTER, NEW_POSTER]]);
    const list = {
      items: [{ title: "Matrix", imageUrl: POSTER, attribution: { source: "tmdb", id: "tmdb:movie:603", formerUrls: [NEW_POSTER, "https://image.tmdb.org/t/p/w500/older.jpg"] } }, { title: "Other", imageUrl: STEAM }, { title: "Bare", imageUrl: POSTER }],
      coverImageUrl: POSTER,
      previewImages: [STEAM, POSTER],
      updatedAt: 1,
    };
    const fields = movedFields(list, moves);
    assert.deepEqual(Object.keys(fields), ["items", "coverImageUrl", "previewImages"]);
    const items = fields.items as { imageUrl: string; attribution: { formerUrls: string[]; source: string } }[];
    assert.equal(items[0].imageUrl, NEW_POSTER);
    assert.deepEqual(items[0].attribution.formerUrls, ["https://image.tmdb.org/t/p/w500/older.jpg", POSTER]);
    assert.deepEqual(items[1], list.items[1]);
    assert.deepEqual(items[2].attribution, { source: "tmdb", formerUrls: [POSTER] });
    assert.equal(fields.coverImageUrl, NEW_POSTER);
    assert.deepEqual(fields.previewImages, [STEAM, NEW_POSTER]);
    assert.deepEqual(Object.keys(movedFields({ snapshot: list }.snapshot, moves, "snapshot.")), ["snapshot.items", "snapshot.coverImageUrl", "snapshot.previewImages"]);
    assert.deepEqual(movedFields({ items: [{ imageUrl: STEAM }] }, moves), {});
    assert.equal(movedItems("not cards", moves), null);
  });

  it("leaves a board showing an old address the same card as the list's moved one", () => {
    const moved = currentAddresses([{ imageUrl: NEW_POSTER, attribution: { formerUrls: [POSTER] } }, { imageUrl: STEAM }, null]);
    assert.deepEqual([...moved], [[POSTER, NEW_POSTER]]);
  });
});

/** [value] with every object's keys the other way round, as Firestore may hand a map back. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]));
}

describe("the backfill run again after a picture moved", () => {
  it("finds nothing to change, whatever order the stored card's keys come back in", () => {
    const card = { title: "Matrix", imageUrl: POSTER, attribution: { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" } };
    const items = movedItems([card], new Map([[POSTER, NEW_POSTER]])) as ListPictures["items"];
    assert.deepEqual(items[0].attribution?.formerUrls, [POSTER]);
    const stored = reversed({ items, coverImageUrl: NEW_POSTER, previewImages: [NEW_POSTER] }) as ListPictures;
    const again = withAttributions(stored, attributionsOf(cardsOf(stored.items, new Map([[NEW_POSTER, "tmdb:movie:603"]])), new Map()));
    assert.notEqual(JSON.stringify(stored.items), JSON.stringify(again.items));
    assert.deepEqual(changedFields(stored, again).fields, {});
  });

  it("still sees a real change", () => {
    const before = { items: [{ title: "A", imageUrl: POSTER }], coverImageUrl: POSTER, previewImages: [POSTER] };
    const after = { ...before, items: [{ title: "A", imageUrl: POSTER, attribution: { source: "tmdb" as const } }] };
    assert.deepEqual(Object.keys(changedFields(before, after).fields), ["items"]);
    assert.equal(sameJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), sameJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }));
    assert.notEqual(sameJson([1, 2]), sameJson([2, 1]));
  });
});

describe("the catalogues the backfill copies", () => {
  const on = (switches: Record<string, boolean>) => Object.keys(switches).filter((source) => switches[source]).sort();

  it("are those switched on, of the ones named; a dry run counts the named as if switched on", () => {
    assert.deepEqual(on(switchesFor(DEFAULT_COPY_SWITCHES, null, false)), ["inaturalist", "wikimedia"]);
    assert.deepEqual(on(switchesFor(DEFAULT_COPY_SWITCHES, new Set(["tmdb", "wikimedia"]), false)), ["wikimedia"]);
    assert.deepEqual(on(switchesFor(DEFAULT_COPY_SWITCHES, new Set(["tmdb", "igdb"]), true)), ["igdb", "tmdb"]);
    assert.deepEqual(on(switchesFor(DEFAULT_COPY_SWITCHES, null, true)), ["inaturalist", "wikimedia"]);
  });
});
