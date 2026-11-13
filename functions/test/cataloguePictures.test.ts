import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUB_PICTURE } from "../src/emulator";
import {
  attributionsByPicture,
  attributionsOf,
  catalogueCopyTools,
  commonsFilesOf,
  copiesWanted,
  copyCataloguePictures,
  originalOf,
  withCatalogueCopies,
  type CardPicture,
} from "../src/cataloguePictures";
import { extendList, cardOf } from "../src/houseFill";
import { CATALOGUE_HOSTS, outsideName, type FetchedPicture, type OutsideTools } from "../src/outsidePictures";
import {
  attributionOf,
  catalogueSourceOf,
  cleanAttribution,
  commonsFileOf,
  copyNameOf,
  copySourceOf,
  HOST_SOURCES,
  inaturalistLicence,
  isCopyOf,
  linkFromAddress,
  mayCopy,
  pictureKey,
  readAttribution,
  sourceLink,
  type CommonsDetails,
} from "../src/pictureAttribution";
import { commonsDetails } from "../src/pictureCredit";
import { anilistHits, commonsPictures, igdbHits, inaturalistHits, openLibraryHits, steamHits, tmdbHits } from "../src/pictureSources";
import { addressOf } from "../src/publishedPictures";
import { decidePublish, settle } from "../src/publishing";
import { sameCards } from "../src/rankings";

const BUCKET = "tieryourlife.firebasestorage.app";
const LIST = "AbCdEfGhIjKlMnOpQrSt";
const OTHER = "ZyXwVuTsRqPoNmLkJiHg";
const POSTER = "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg";
const CHARACTER = "https://s4.anilist.co/file/anilistcdn/character/large/b17-phjcWCkRuIhu.png";
const COVER = "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co3p2d.jpg";
const CAPSULE = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/library_600x900_2x.jpg?t=1790290043";
const PHOTO = "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/large.jpeg";
const CLOSED_PHOTO = "https://static.inaturalist.org/photos/2568822/large.jpg";
const PHOTO_CREDIT = "(c) Douglas Goldman, some rights reserved (CC BY-SA)";
const COMMONS = "https://commons.wikimedia.org/wiki/Special:FilePath/Felis_catus-cat_on_snow.jpg?width=600";
const LOCAL_WIKI = "https://upload.wikimedia.org/wikipedia/en/a/ab/Logo.png";
const CAT: CommonsDetails = { author: "Von.grzanka", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", link: "https://commons.wikimedia.org/?curid=4466700" };
const COMMONS_MAP = new Map([["Felis catus-cat on snow.jpg", CAT]]);

const copyOf = (list: string, url: string, suffix = "") => addressOf(BUCKET, `published/${list}/${outsideName(url)}${suffix}`);

describe("a picture's source", () => {
  it("is named for exactly the hosts a list may show as they are", () => {
    assert.deepEqual([...CATALOGUE_HOSTS].sort(), Object.keys(HOST_SOURCES).sort());
    assert.equal(catalogueSourceOf(POSTER), "tmdb");
    assert.equal(catalogueSourceOf(PHOTO), "inaturalist");
    assert.equal(catalogueSourceOf(COMMONS), "wikimedia");
    assert.equal(catalogueSourceOf("https://image.tmdb.org.evil.example/a.jpg"), null);
    assert.equal(catalogueSourceOf("http://image.tmdb.org/t/p/w500/a.jpg"), null);
    assert.equal(catalogueSourceOf(null), null);
  });

  it("keeps a page link a client sends back only on that catalogue's own site, in its one shape", () => {
    assert.equal(sourceLink("tmdb", "https://www.themoviedb.org/movie/603"), "https://www.themoviedb.org/movie/603");
    assert.equal(sourceLink("anilist", "https://anilist.co/character/17/"), "https://anilist.co/character/17");
    assert.equal(sourceLink("igdb", "https://www.igdb.com/games/elden-ring"), "https://www.igdb.com/games/elden-ring");
    assert.equal(sourceLink("openlibrary", "https://openlibrary.org/works/OL45804W"), "https://openlibrary.org/works/OL45804W");
    for (const [source, link] of [
      ["tmdb", "https://evil.example/movie/603"],
      ["tmdb", "https://www.themoviedb.org/movie/603?utm=x"],
      ["tmdb", "https://www.themoviedb.org/login"],
      ["tmdb", "http://www.themoviedb.org/movie/603"],
      ["anilist", "https://www.themoviedb.org/movie/603"],
      ["web", "https://example.com/"],
      ["tmdb", 42],
    ] as const) {
      assert.equal(sourceLink(source, link), null, String(link));
    }
  });

  it("reads a page off the addresses that say one", () => {
    assert.equal(linkFromAddress(CAPSULE), "https://store.steampowered.com/app/1245620");
    assert.equal(linkFromAddress(PHOTO), "https://www.inaturalist.org/photos/82354387");
    assert.equal(linkFromAddress(CHARACTER), "https://anilist.co/character/17");
    assert.equal(linkFromAddress("https://covers.openlibrary.org/b/olid/OL7353617M-L.jpg"), "https://openlibrary.org/books/OL7353617M");
    assert.equal(linkFromAddress(POSTER), null);
    assert.equal(linkFromAddress(COVER), null);
  });
});

describe("an iNaturalist photo's licence", () => {
  it("is read back out of the attribution its search hit carried", () => {
    assert.deepEqual(inaturalistLicence(PHOTO_CREDIT), { author: "Douglas Goldman", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" });
    assert.deepEqual(inaturalistLicence("(c) Paul Prior, some rights reserved (CC BY)"), { author: "Paul Prior", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" });
    assert.deepEqual(inaturalistLicence("no rights reserved"), { license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    assert.deepEqual(inaturalistLicence("(c) Ann, no rights reserved (CC0)"), { author: "Ann", license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    assert.deepEqual(inaturalistLicence("Robb Hannawacker, no known copyright restrictions (public domain)"), { author: "Robb Hannawacker", license: "Public domain", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/" });
  });

  it("reads a taxon photo uploaded from elsewhere, naming its author or else its uploader, entities decoded", () => {
    assert.deepEqual(inaturalistLicence("(c) Jan Ebr &amp; Ivana Ebrová, some rights reserved (CC BY), uploaded by Annika Lindqvist"), { author: "Jan Ebr & Ivana Ebrová", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" });
    assert.deepEqual(inaturalistLicence("no rights reserved, uploaded by Vijay Barve"), { author: "Vijay Barve", license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    assert.equal(inaturalistLicence("(c) Someone, some rights reserved (CC BY-NC), uploaded by Other"), null);
  });

  it("is none for a licence search never lets through, or no credit", () => {
    assert.equal(inaturalistLicence("(c) Someone, some rights reserved (CC BY-NC)"), null);
    assert.equal(inaturalistLicence("(c) Someone, all rights reserved"), null);
    assert.equal(inaturalistLicence(undefined), null);
  });
});

describe("a Commons file", () => {
  it("is named from Special:FilePath, its own page or Commons' own upload folder, never a local wiki's", () => {
    assert.equal(commonsFileOf(COMMONS), "Felis catus-cat on snow.jpg");
    assert.equal(commonsFileOf("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Some_file.jpg/500px-Some_file.jpg"), "Some file.jpg");
    assert.equal(commonsFileOf("https://upload.wikimedia.org/wikipedia/commons/a/ab/some_file.png"), "Some file.png");
    assert.equal(commonsFileOf(LOCAL_WIKI), null);
    assert.equal(commonsFileOf("https://commons.wikimedia.org/wiki/File:Some.jpg"), "Some.jpg");
  });

  it("is described by Commons' own metadata, licence first", () => {
    const page = { pageid: 4466700, title: "File:Felis catus-cat on snow.jpg" };
    const info = { extmetadata: {
      Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:Von.grzanka\">Von.grzanka</a>" },
      LicenseShortName: { value: "CC BY-SA 3.0" },
      LicenseUrl: { value: "http://creativecommons.org/licenses/by-sa/3.0" },
    } };
    assert.deepEqual(commonsDetails(page, info), {
      author: "Von.grzanka (https://commons.wikimedia.org/wiki/User:Von.grzanka)",
      license: "CC BY-SA 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
      link: "https://commons.wikimedia.org/?curid=4466700",
    });
    assert.equal(commonsDetails(page, { extmetadata: { Artist: { value: "Somebody" } } }), undefined);
  });
});

describe("what may be copied", () => {
  const of = (url: string, credit?: string) => attributionOf(url, { credit, commons: COMMONS_MAP });

  it("is an openly licensed iNaturalist photo from its open-data bucket, and a Commons file whose licence is known", () => {
    assert.equal(mayCopy(PHOTO, of(PHOTO, PHOTO_CREDIT)), true);
    assert.equal(mayCopy(COMMONS, of(COMMONS)), true);
  });

  it("is nothing from TMDB, AniList, IGDB, Steam or Open Library, nor a photo without open licence or known licence", () => {
    assert.equal(mayCopy(POSTER, of(POSTER)), false);
    assert.equal(mayCopy(CHARACTER, of(CHARACTER)), false);
    assert.equal(mayCopy(COVER, of(COVER)), false);
    assert.equal(mayCopy(CAPSULE, of(CAPSULE)), false);
    assert.equal(mayCopy("https://covers.openlibrary.org/b/id/1-L.jpg", of("https://covers.openlibrary.org/b/id/1-L.jpg")), false);
    assert.equal(mayCopy(CLOSED_PHOTO, of(CLOSED_PHOTO, PHOTO_CREDIT)), false);
    assert.equal(mayCopy(PHOTO, of(PHOTO)), false);
    assert.equal(mayCopy(PHOTO, of(PHOTO, "(c) Someone, some rights reserved (CC BY-NC)")), false);
    const unknownFile = "https://commons.wikimedia.org/wiki/Special:FilePath/Unknown.jpg?width=600";
    assert.equal(mayCopy(unknownFile, of(unknownFile)), false);
  });

  it("is copied from the catalogue's own picture of about 500 px", () => {
    assert.equal(copySourceOf(PHOTO), "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/medium.jpeg");
    assert.equal(copySourceOf(COMMONS), "https://commons.wikimedia.org/wiki/Special:FilePath/Felis_catus-cat_on_snow.jpg?width=500");
    assert.equal(copySourceOf(POSTER), null);
  });
});

describe("each catalogue's attribution", () => {
  it("names TMDB, AniList and IGDB with the page the client brought back, and nobody", () => {
    assert.deepEqual(attributionOf(POSTER, { sentLink: "https://www.themoviedb.org/movie/603" }), { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" });
    assert.deepEqual(attributionOf(POSTER, { sentLink: "https://evil.example/" }), { source: "tmdb" });
    assert.deepEqual(attributionOf(CHARACTER, {}), { source: "anilist", link: "https://anilist.co/character/17", id: "anilist:c17" });
    assert.deepEqual(attributionOf(CAPSULE, { sentLink: "https://store.steampowered.com/app/1" }), { source: "steam", link: "https://store.steampowered.com/app/1245620", id: "steam:1245620" });
  });

  it("names an iNaturalist observer and licence, and a Commons author, licence and page", () => {
    assert.deepEqual(attributionOf(PHOTO, { credit: PHOTO_CREDIT }), {
      source: "inaturalist",
      author: "Douglas Goldman",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      link: "https://www.inaturalist.org/photos/82354387",
    });
    assert.deepEqual(attributionOf(COMMONS, { commons: COMMONS_MAP }), { source: "wikimedia", ...CAT });
    assert.deepEqual(attributionOf("https://commons.wikimedia.org/wiki/Special:FilePath/Unknown.jpg?width=600", {}), { source: "wikimedia", link: "https://commons.wikimedia.org/wiki/File:Unknown.jpg" });
    assert.equal(attributionOf("https://example.com/a.jpg", {}), null);
  });

  it("keeps each field within its limit", () => {
    const long = cleanAttribution({ source: "inaturalist", author: "a".repeat(400), license: "b".repeat(200), link: "javascript:alert(1)" });
    assert.equal(long.author?.length, 300);
    assert.equal(long.license?.length, 100);
    assert.equal(long.link, undefined);
  });
});

describe("a copy and the picture it was made from", () => {
  it("are one picture, in any list and whichever attempt made the copy", () => {
    const copy = copyOf(LIST, PHOTO);
    const foreign = addressOf(BUCKET, `published/${OTHER}/${LIST}-${outsideName(PHOTO)}`);
    const pending = copyOf(LIST, PHOTO, "_p_0f8fad5b-d9cb-469f-a165-70867728950e");
    const shown = `https://tieryourlife.web.app/img/original/published/${LIST}/${outsideName(PHOTO)}`;
    for (const one of [copy, foreign, pending, shown]) {
      assert.equal(copyNameOf(one), outsideName(PHOTO), one);
      assert.equal(pictureKey(one), pictureKey(PHOTO), one);
      assert.equal(isCopyOf(one, PHOTO), true);
    }
    assert.equal(isCopyOf(copy, POSTER), false);
    assert.equal(isCopyOf(copy, "https://example.com/a.jpg"), false);
    assert.notEqual(pictureKey(POSTER), pictureKey(PHOTO));
    const own = addressOf(BUCKET, `published/${LIST}/abc123`);
    assert.equal(pictureKey(own), own);
  });

  it("make a ranking of a list whose photos were copied, from a client that still has the old addresses", () => {
    const stored = [{ title: "Lion", imageUrl: copyOf(LIST, PHOTO) }, { title: "Matrix", imageUrl: POSTER }];
    const sent = [{ title: "Matrix", imageUrl: POSTER }, { title: "Lion", imageUrl: PHOTO }];
    assert.equal(sameCards(stored, sent), true);
  });
});

describe("cards at publication", () => {
  const cards: CardPicture[] = [
    { imageUrl: POSTER, sent: { link: "https://www.themoviedb.org/movie/603" } },
    { imageUrl: PHOTO, credit: PHOTO_CREDIT },
    { imageUrl: COMMONS },
    { imageUrl: CLOSED_PHOTO, credit: PHOTO_CREDIT },
    { imageUrl: "https://example.com/found.jpg" },
    { imageUrl: addressOf(BUCKET, `published/${LIST}/own-photo-id`) },
    { imageUrl: null },
  ];

  it("get each its attribution, and the pictures we may keep are the ones copied", () => {
    const attributions = attributionsOf(cards, COMMONS_MAP);
    assert.deepEqual(attributions.map((one) => one?.source ?? null), ["tmdb", "inaturalist", "wikimedia", "inaturalist", "web", null, null]);
    assert.equal(attributions[0]?.link, "https://www.themoviedb.org/movie/603");
    assert.deepEqual(copiesWanted(cards, attributions), [PHOTO, COMMONS]);
    assert.deepEqual(commonsFilesOf(cards), ["Felis catus-cat on snow.jpg"]);
  });

  it("keep their catalogue address when sent as our copy, but only for the address the copy was made from", () => {
    const copy = copyOf(LIST, PHOTO);
    const honest: CardPicture = { imageUrl: copy, credit: PHOTO_CREDIT, sent: { originalUrl: PHOTO } };
    const forged: CardPicture = { imageUrl: copy, credit: PHOTO_CREDIT, sent: { originalUrl: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpeg" } };
    assert.equal(originalOf(honest), PHOTO);
    assert.equal(originalOf(forged), null);
    const [kept, unproven] = attributionsOf([honest, forged], new Map());
    assert.equal(kept?.originalUrl, PHOTO);
    assert.equal(kept?.author, "Douglas Goldman");
    assert.deepEqual(unproven, { source: "web" });
    // An old client sends the copy back without its attribution: the previous snapshot still knows.
    const previous = attributionsByPicture([{ imageUrl: copy, attribution: kept }]);
    const [remembered] = attributionsOf([{ imageUrl: copy, credit: PHOTO_CREDIT, previous: previous.get(copy) }], new Map());
    assert.equal(remembered?.originalUrl, PHOTO);
    assert.equal(previous.get(PHOTO)?.originalUrl, PHOTO);
  });

  it("point at the copies made, cover and collage too, and keep the catalogue address beside", () => {
    const copy = copyOf(LIST, PHOTO);
    const list = withCatalogueCopies({
      items: [{ title: "Lion", imageUrl: PHOTO, attribution: { source: "inaturalist" as const, author: "Douglas Goldman" } }, { title: "Matrix", imageUrl: POSTER }],
      coverImageUrl: PHOTO,
      previewImages: [POSTER, PHOTO],
    }, new Map([[PHOTO, copy]]));
    assert.deepEqual(list.items[0], { title: "Lion", imageUrl: copy, attribution: { source: "inaturalist", author: "Douglas Goldman", originalUrl: PHOTO } });
    assert.deepEqual(list.items[1], { title: "Matrix", imageUrl: POSTER });
    assert.equal(list.coverImageUrl, copy);
    assert.deepEqual(list.previewImages, [POSTER, copy]);
  });
});

function fakeTools(failing = new Set<string>()): OutsideTools & { files: Map<string, Buffer>; fetched: string[] } {
  const fake = {
    bucket: BUCKET,
    files: new Map<string, Buffer>(),
    fetched: [] as string[],
    namesIn: async (folder: string) => new Set([...fake.files.keys()].filter((path) => path.startsWith(folder)).map((path) => path.slice(folder.length))),
    save: async (path: string, bytes: Buffer) => {
      fake.files.set(path, bytes);
    },
    remove: async (path: string) => {
      fake.files.delete(path);
    },
    fetch: async (url: string): Promise<FetchedPicture> => {
      fake.fetched.push(url);
      return failing.has(url) ? { error: "UNREACHABLE" } : { bytes: STUB_PICTURE, type: "image/png" };
    },
    lookAt: async () => {
      throw new Error("catalogue copies are not looked at");
    },
    reserve: async () => {
      throw new Error("catalogue copies do not count against a person's day");
    },
    giveBack: async () => undefined,
  };
  return fake;
}

describe("copying catalogue pictures", () => {
  it("copies each once under its address's name, without SafeSearch or the day's count, and leaves out what failed", async () => {
    const base = fakeTools(new Set([COMMONS]));
    const tools = { ...catalogueCopyTools(base), fetch: base.fetch };
    const first = await copyCataloguePictures(`published/${LIST}/`, [PHOTO, COMMONS], tools, { nameSuffix: "_p_x" });
    assert.deepEqual([...first.copies], [[PHOTO, copyOf(LIST, PHOTO, "_p_x")]]);
    assert.deepEqual(first.saved, [`published/${LIST}/${outsideName(PHOTO)}_p_x`]);
    // Already there: nothing is fetched again.
    base.fetched.length = 0;
    const again = await copyCataloguePictures(`published/${LIST}/`, [PHOTO], tools, { nameSuffix: "_p_x" });
    assert.deepEqual(base.fetched, []);
    assert.equal(again.copies.get(PHOTO), copyOf(LIST, PHOTO, "_p_x"));
  });

  it("asks nothing of an address it may not copy", async () => {
    const tools = catalogueCopyTools(fakeTools());
    assert.deepEqual(await tools.fetch(POSTER, AbortSignal.timeout(1000)), { error: "NOT_ALLOWED" });
    assert.equal(await tools.reserve(5), true);
  });
});

describe("search hits", () => {
  it("carry each catalogue's attribution and page", () => {
    const [movie] = tmdbHits({ results: [{ media_type: "movie", id: 603, title: "The Matrix", poster_path: "/a.jpg", release_date: "1999-03-30" }] });
    assert.deepEqual(movie.attribution, { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" });
    const anime = anilistHits({ data: { media: { media: [{ id: 21, type: "ANIME", title: { english: "One Piece" }, coverImage: { large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-a.jpg" } }] }, characters: { characters: [{ id: 17, name: { full: "Naruto Uzumaki" }, image: { large: CHARACTER } }] } } });
    assert.deepEqual(anime.map((hit) => hit.attribution?.link), ["https://anilist.co/anime/21", "https://anilist.co/character/17"]);
    const [game] = igdbHits([{ id: 1, name: "Elden Ring", url: "https://www.igdb.com/games/elden-ring", cover: { image_id: "co4jni", width: 600, height: 800 } }]);
    assert.equal(game.attribution?.link, "https://www.igdb.com/games/elden-ring");
    const [wrong] = igdbHits([{ id: 1, name: "Elden Ring", url: "https://evil.example/", cover: { image_id: "co4jni" } }]);
    assert.deepEqual(wrong.attribution, { source: "igdb", id: "igdb:1" });
    const [steam] = steamHits([1245620], { response: { store_items: [{ appid: 1245620, name: "Elden Ring", assets: { asset_url_format: "steam/apps/1245620/${FILENAME}", library_capsule_2x: "library_600x900_2x.jpg" } }] } });
    assert.equal(steam.attribution?.link, "https://store.steampowered.com/app/1245620");
    const [book] = openLibraryHits({ docs: [{ title: "Dune", key: "/works/OL893415W", cover_i: 1 }] });
    assert.equal(book.attribution?.link, "https://openlibrary.org/works/OL893415W");
    const [lion] = inaturalistHits({ results: [{ id: 41964, name: "Panthera leo", preferred_common_name: "lion", default_photo: {
      medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/medium.jpeg",
      license_code: "cc-by-sa",
      attribution: PHOTO_CREDIT,
      original_dimensions: { width: 1000, height: 800 },
    } }] });
    assert.deepEqual(lion.attribution, { source: "inaturalist", author: "Douglas Goldman", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", link: "https://www.inaturalist.org/photos/82354387" });
    const commons = commonsPictures({ query: { pages: { 1: { pageid: 4466700, title: "File:Cat.jpg", imageinfo: [{ width: 800, height: 800, extmetadata: { LicenseShortName: { value: "CC0" } } }] } } } }, false);
    assert.deepEqual(commons.get("Cat.jpg")?.attribution, { source: "wikimedia", license: "CC0", link: "https://commons.wikimedia.org/?curid=4466700" });
  });

  it("give a house card its attribution, and the house does not add a picture it already shows as a copy", () => {
    const [lion] = inaturalistHits({ results: [{ id: 41964, name: "Panthera leo", default_photo: { medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/medium.jpeg", license_code: "cc-by-sa", attribution: PHOTO_CREDIT, original_dimensions: { width: 1000, height: 800 } } }] });
    const card = cardOf("Lion", lion);
    assert.equal(card.attribution?.author, "Douglas Goldman");
    const extended = extendList({ tiers: [], items: [{ title: "Big cat", imageUrl: copyOf(LIST, PHOTO), tierIndex: null }] }, [card]);
    assert.ok(extended.ok);
    assert.deepEqual(extended.ok && extended.duplicates, ["Lion"]);
  });
});

describe("a publication's cards", () => {
  it("read back only the link and the original address of an attribution, and store what the server works out", () => {
    const decision = decidePublish({ isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "someone", body: {
      title: "Animals",
      category: "animals",
      tiers: [{ label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" }],
      items: [{ title: "Lion", imageUrl: PHOTO, credit: PHOTO_CREDIT, attribution: { source: "tmdb", author: "Me", link: "https://www.inaturalist.org/photos/1", originalUrl: POSTER, extra: 1 } }],
    } });
    assert.ok(decision.ok);
    if (!decision.ok) return;
    assert.deepEqual(decision.draft.items[0].sent, { link: "https://www.inaturalist.org/photos/1", originalUrl: POSTER });
    assert.equal(settle(decision.draft, new Map()).items[0].attribution, undefined);
    decision.draft.items[0].attribution = attributionsOf([{ imageUrl: PHOTO, credit: PHOTO_CREDIT, sent: decision.draft.items[0].sent }], new Map())[0]!;
    // The address's own page wins over whatever the client said.
    assert.equal(settle(decision.draft, new Map()).items[0].attribution?.link, "https://www.inaturalist.org/photos/82354387");
    assert.equal(settle(decision.draft, new Map()).items[0].attribution?.author, "Douglas Goldman");
  });
});

describe("an attribution kept on a private board", () => {
  it("is a known source with its text cleaned, and an original address only on a catalogue", () => {
    assert.deepEqual(readAttribution({ source: "tmdb", link: "https://www.themoviedb.org/movie/603", extra: 1 }), { source: "tmdb", link: "https://www.themoviedb.org/movie/603" });
    assert.deepEqual(readAttribution({ source: "inaturalist", author: "  Ann  ", originalUrl: PHOTO }), { source: "inaturalist", author: "Ann", originalUrl: PHOTO });
    assert.deepEqual(readAttribution({ source: "web", originalUrl: "https://example.com/a.jpg", link: "http://plain.example/" }), { source: "web" });
    assert.equal(readAttribution({ source: "unknown" }), null);
    assert.equal(readAttribution("tmdb"), null);
    assert.equal(readAttribution(null), null);
  });
});
