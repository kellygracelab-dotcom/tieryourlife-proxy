import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { attributionsByPicture, attributionsOf, type CardPicture } from "../src/cataloguePictures";
import { coverCreditFields } from "../src/community";
import {
  decideManual,
  flickrCredit,
  inaturalistCredit,
  knownLicence,
  manualCredits,
  readablePage,
  readManual,
  sameCredit,
  USED_WITH_PERMISSION,
} from "../src/manualAttribution";
import { cleanAttribution, manualOf, readAttribution, withManual, type CommonsDetails, type ManualAttribution } from "../src/pictureAttribution";
import { decidePublish } from "../src/publishing";

const PAGE = "https://example.com/where-it-was-found";
const OWN = "https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/users%2Fsomeone%2Fpictures%2Fabc?alt=media&token=t";
const COMMONS = "https://commons.wikimedia.org/wiki/Special:FilePath/Felis_catus-cat_on_snow.jpg?width=600";
const CAT: CommonsDetails = { author: "Von.grzanka", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", link: "https://commons.wikimedia.org/?curid=4466700" };
const COMMONS_MAP = new Map([["Felis catus-cat on snow.jpg", CAT]]);
const CREDIT: ManualAttribution = { author: "Jane Doe", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", link: PAGE, manual: true };

describe("a licence an editor may name", () => {
  it("is CC0, CC BY or CC BY-SA with a version, Public domain or Used with permission, in one shape with its deed", () => {
    assert.deepEqual(knownLicence("cc-by-sa 3.0"), { license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/" });
    assert.deepEqual(knownLicence("CC BY 2.0"), { license: "CC BY 2.0", licenseUrl: "https://creativecommons.org/licenses/by/2.0/" });
    assert.deepEqual(knownLicence("CC BY-SA 3.0 de"), { license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/" });
    assert.equal(knownLicence("CC0")?.license, "CC0 1.0");
    assert.equal(knownLicence("Public Domain Dedication (CC0)")?.license, "CC0 1.0");
    assert.equal(knownLicence("public domain")?.license, "Public domain");
    assert.deepEqual(knownLicence("used with permission"), { license: USED_WITH_PERMISSION });
  });

  it("is read from a deed's address too", () => {
    assert.equal(knownLicence("https://creativecommons.org/licenses/by-sa/2.0/")?.license, "CC BY-SA 2.0");
    assert.equal(knownLicence("http://creativecommons.org/licenses/by/3.0/de/deed.en")?.license, "CC BY 3.0");
    assert.equal(knownLicence("https://creativecommons.org/publicdomain/zero/1.0/")?.license, "CC0 1.0");
    assert.equal(knownLicence("https://creativecommons.org/publicdomain/mark/1.0/")?.license, "Public domain");
  });

  it("is never one that forbids changes or sale, an unversioned one, or all rights reserved", () => {
    for (const refused of ["CC BY-NC 4.0", "CC BY-ND 4.0", "CC BY-SA", "CC BY 5.0", "All Rights Reserved", "GFDL", "https://creativecommons.org/licenses/by-nc/2.0/"]) {
      assert.equal(knownLicence(refused), null, refused);
    }
  });
});

describe("an editor's credit as sent", () => {
  it("says nothing unless it is marked manual, and manual: false takes the editor's off", () => {
    assert.equal(readManual({ source: "web", link: PAGE }), null);
    assert.equal(readManual(null), null);
    assert.equal(readManual([{ manual: true }]), null);
    assert.equal(readManual({ manual: false, license: "CC0" }), "cleared");
  });

  it("is its four fields with spaces tidied, https only, within the usual lengths", () => {
    assert.deepEqual(readManual({ manual: true, author: "  Jane   Doe ", license: " CC BY 4.0", link: PAGE, extra: 1 }), { author: "Jane Doe", license: "CC BY 4.0", link: PAGE });
    assert.deepEqual(readManual({ manual: true, link: "http://example.com/page" }), { error: "BAD_LINK" });
    assert.deepEqual(readManual({ manual: true, link: PAGE, licenseUrl: "javascript:alert(1)" }), { error: "BAD_LICENSE_URL" });
    assert.deepEqual(readManual({ manual: true, link: PAGE, author: "a".repeat(301) }), { error: "TOO_LONG" });
    assert.deepEqual(readManual({ manual: true, link: PAGE, license: "b".repeat(101) }), { error: "TOO_LONG" });
    assert.deepEqual(readManual({ manual: true, link: `https://example.com/${"c".repeat(500)}` }), { error: "TOO_LONG" });
  });
});

describe("an editor's credit decided", () => {
  it("needs the page it stands on and a licence we know", () => {
    assert.deepEqual(decideManual({ license: "CC0" }, null), { error: "NO_LINK" });
    assert.deepEqual(decideManual({ link: PAGE }, null), { error: "NO_LICENSE" });
    assert.deepEqual(decideManual({ link: PAGE, license: "CC BY-NC 4.0" }, null), { error: "UNKNOWN_LICENSE" });
    assert.deepEqual(decideManual({ link: PAGE }, { license: "All Rights Reserved" }), { error: "UNKNOWN_LICENSE" });
  });

  it("keeps what the editor gave and fills the deed of a licence named", () => {
    assert.deepEqual(decideManual({ author: "Jane Doe", license: "cc by 4.0", link: PAGE }, null), CREDIT);
    assert.deepEqual(decideManual({ license: "Used with permission", link: PAGE }, null), { license: USED_WITH_PERMISSION, link: PAGE, manual: true });
    // The editor's licence wins over the page's; their author too.
    assert.deepEqual(decideManual({ author: "Me", license: "CC0", link: PAGE }, { author: "Them", license: "CC BY 2.0" }), {
      author: "Me", license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", link: PAGE, manual: true,
    });
  });

  it("takes from the page what the editor left empty", () => {
    assert.deepEqual(decideManual({ link: PAGE }, { author: "Von.grzanka", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0" }), {
      author: "Von.grzanka", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", link: PAGE, manual: true,
    });
    assert.deepEqual(decideManual({ license: "CC BY 4.0", link: PAGE }, { author: "Jane Doe", license: "CC BY 2.0" }), CREDIT);
  });
});

describe("a page whose credit can be read", () => {
  it("is a Commons file, a Flickr photo or an iNaturalist observation", () => {
    assert.equal(readablePage("https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg"), "commons");
    assert.equal(readablePage("https://www.flickr.com/photos/37996580417@N01/2186370218/"), "flickr");
    assert.equal(readablePage("https://www.inaturalist.org/observations/12345"), "inaturalist");
    assert.equal(readablePage("https://www.flickr.com/photos/someone/"), null);
    assert.equal(readablePage(PAGE), null);
  });

  it("gives Flickr's author and the licence its deed names, never one it does not", () => {
    assert.deepEqual(flickrCredit({ type: "photo", author_name: "Paul", license: "Attribution-ShareAlike License", license_url: "https://creativecommons.org/licenses/by-sa/2.0/" }), {
      author: "Paul", license: "https://creativecommons.org/licenses/by-sa/2.0/", licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    });
    assert.deepEqual(flickrCredit({ type: "photo", author_name: "Paul", license: "All Rights Reserved" }), { author: "Paul", license: "All Rights Reserved" });
    assert.equal(flickrCredit({ type: "video", license: "Attribution License" }), null);
    assert.equal(flickrCredit(null), null);
    const decided = decideManual({ link: "https://www.flickr.com/photos/p/1/" }, flickrCredit({ type: "photo", author_name: "Paul", license_url: "https://creativecommons.org/licenses/by-sa/2.0/" }));
    assert.deepEqual(decided, { author: "Paul", license: "CC BY-SA 2.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/", link: "https://www.flickr.com/photos/p/1/", manual: true });
  });

  it("gives iNaturalist's first photo's credit", () => {
    assert.deepEqual(inaturalistCredit({ results: [{ photos: [{ attribution: "(c) Douglas Goldman, some rights reserved (CC BY-SA)" }] }] }), {
      author: "Douglas Goldman", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    });
    assert.equal(inaturalistCredit({ results: [{ photos: [{ attribution: "(c) Someone, all rights reserved" }] }] }), null);
    assert.equal(inaturalistCredit({ results: [] }), null);
  });
});

describe("a publication's editor credits", () => {
  it("are decided each, in place, with what is wrong where it is wrong", async () => {
    const decided = await manualCredits([
      undefined,
      { manual: true, author: "Jane Doe", license: "CC BY 4.0", link: PAGE },
      { manual: false },
      { manual: true, link: PAGE },
      { manual: true, link: "http://example.com" },
    ]);
    assert.deepEqual(decided, [null, CREDIT, "cleared", { error: "NO_LICENSE" }, { error: "BAD_LINK" }]);
  });

  it("are kept as stored when sent back unchanged, and decided again when changed", async () => {
    const stored: ManualAttribution = { ...CREDIT, author: "Read from the page" };
    assert.ok(sameCredit({ license: "CC BY 4.0", link: PAGE, author: "Read from the page" }, stored));
    assert.ok(sameCredit({ license: "cc-by 4.0", link: PAGE }, stored));
    assert.ok(!sameCredit({ license: "CC BY 4.0", link: PAGE, author: "Someone else" }, stored));
    assert.ok(!sameCredit({ link: PAGE }, stored));
    assert.ok(!sameCredit({ license: "CC BY 4.0", link: PAGE }, null));
    const [kept, changed] = await manualCredits(
      [{ manual: true, license: "CC BY 4.0", link: PAGE }, { manual: true, license: "CC0", link: PAGE }],
      [stored, stored],
    );
    assert.equal(kept, stored);
    assert.deepEqual(changed, { license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", link: PAGE, manual: true });
  });
});

describe("a card with an editor's credit", () => {
  it("shows it over a catalogue's, which keeps its source and addresses", () => {
    const [cat] = attributionsOf([{ imageUrl: COMMONS, manual: CREDIT }], COMMONS_MAP);
    assert.equal(cat?.source, "wikimedia");
    assert.equal(cat?.author, "Jane Doe");
    assert.equal(cat?.license, "CC BY 4.0");
    assert.equal(cat?.link, PAGE);
    assert.equal(cat?.manual, true);
  });

  it("makes an uploaded file a picture of the web", () => {
    assert.deepEqual(attributionsOf([{ imageUrl: OWN, manual: CREDIT }], new Map())[0], { source: "web", ...CREDIT });
    assert.equal(attributionsOf([{ imageUrl: OWN }], new Map())[0], null);
  });

  it("keeps the credit the same picture had until the editor takes it off", () => {
    const previous = attributionsByPicture([{ imageUrl: OWN, attribution: { source: "web", ...CREDIT } }]);
    const again: CardPicture = { imageUrl: OWN, previous: previous.get(OWN) };
    assert.deepEqual(attributionsOf([again], new Map())[0], { source: "web", ...CREDIT });
    assert.equal(attributionsOf([{ ...again, manual: "cleared" }], new Map())[0], null);
    assert.equal(attributionsOf([{ imageUrl: null }], new Map())[0], null);
    // An own photo has no address until it is copied: the editor's credit is its attribution all the same.
    assert.deepEqual(attributionsOf([{ imageUrl: null, manual: CREDIT }], new Map())[0], { source: "web", ...CREDIT });
  });

  it("is read back and kept by the shapes every attribution goes through", () => {
    const one = { source: "web" as const, ...CREDIT };
    assert.deepEqual(cleanAttribution(one), one);
    assert.deepEqual(readAttribution({ ...one, extra: 1 }), one);
    assert.deepEqual(readAttribution({ ...one, manual: "yes" }), { source: "web", author: "Jane Doe", license: "CC BY 4.0", licenseUrl: CREDIT.licenseUrl, link: PAGE });
    assert.deepEqual(manualOf(one), CREDIT);
    assert.equal(manualOf({ source: "web", link: PAGE, manual: true }), null);
    assert.deepEqual(withManual({ source: "tmdb", id: "tmdb:movie:603", author: "Old", link: "https://www.themoviedb.org/movie/603" }, CREDIT), { source: "tmdb", id: "tmdb:movie:603", ...CREDIT });
  });

  it("is passed from the body as sent, for the house to decide", () => {
    const manual = { source: "web", manual: true, license: "CC0", link: PAGE };
    const decision = decidePublish({ isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "someone", body: {
      title: "Animals",
      category: "animals",
      tiers: [{ label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" }],
      items: [{ title: "Cat", imageUrl: COMMONS, attribution: manual }, { title: "Dog", imageUrl: COMMONS, attribution: { manual: false } }],
    } });
    assert.ok(decision.ok);
    if (!decision.ok) return;
    assert.deepEqual(decision.draft.items[0].sent, { link: PAGE, web: true, manual });
    assert.deepEqual(decision.draft.items[1].sent, { manual: { manual: false } });
  });
});

describe("a house cover's credit", () => {
  const COVER = "https://example.com/cover.jpg";
  const deleted = (fields: { coverAttribution?: unknown }) => FieldValue.delete().isEqual(fields.coverAttribution as FieldValue);

  it("is the editor's new one while there is a cover", () => {
    assert.deepEqual(coverCreditFields(CREDIT, COVER, null), { coverAttribution: CREDIT });
    assert.deepEqual(coverCreditFields(undefined, COVER, null), {});
    assert.deepEqual(coverCreditFields(CREDIT, null, null), {});
  });

  it("stays while the cover is the same picture, and goes when it changes or the editor takes it off", () => {
    const previous = { coverImageUrl: COVER, coverAttribution: CREDIT };
    assert.deepEqual(coverCreditFields(undefined, COVER, previous), { coverAttribution: CREDIT });
    assert.ok(deleted(coverCreditFields(undefined, "https://example.com/other.jpg", previous)));
    assert.ok(deleted(coverCreditFields("cleared", COVER, previous)));
    assert.ok(deleted(coverCreditFields(undefined, null, previous)));
  });
});
