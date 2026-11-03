import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bylineOf,
  decideEditorialAccess,
  decideTranslations,
  EDITORIAL_UID,
  editorialByline,
  MAX_TRANSLATIONS_PER_LOCALE,
  pruneTranslations,
  searchAfterTranslations,
  titleNames,
  translatableStrings,
  TRANSLATION_LOCALES,
} from "../src/editorial";
import { SEARCH_TRANSLATED, SEARCH_WORDS_ONLY } from "../src/search";

describe("EDITORIAL_UID", () => {
  // Firebase uids are 28 characters of letters and digits; this can never be one,
  // so no sign-in becomes the house and no account deletion reaches its lists.
  it("is not something Auth could hand out", () => {
    assert.notEqual(EDITORIAL_UID.length, 28);
    assert.match(EDITORIAL_UID, /-/);
  });
});

describe("editorialByline", () => {
  it("is the house: anonymous, with no name and no face, and remembers who spoke for it", () => {
    assert.deepEqual(editorialByline("moderator"), { uid: EDITORIAL_UID, name: "", photoUrl: null, speaker: "moderator" });
  });
});

describe("bylineOf", () => {
  it("is the person publishing, Anonymous while they have no name", () => {
    const identity = { uid: "u1", isAnonymous: false, name: null, picture: "https://p/face.jpg", email: null };
    assert.deepEqual(bylineOf(identity), { uid: "u1", name: "Anonymous", photoUrl: "https://p/face.jpg", speaker: null });
  });
});

describe("decideEditorialAccess", () => {
  it("lets the owner in", () => {
    assert.deepEqual(decideEditorialAccess("owner"), { ok: true, speaker: "owner" });
  });

  it("lets a moderator in", () => {
    assert.deepEqual(decideEditorialAccess("moderator"), { ok: true, speaker: "moderator" });
  });

  it("turns anybody else away", () => {
    assert.deepEqual(decideEditorialAccess(null), { ok: false });
  });
});

const list = {
  title: "Best Pixar Movies",
  tiers: [{ label: "S", caption: "Must watch" }, { label: "A", caption: null }],
  items: [{ title: "Toy Story" }, { title: "Monsters, Inc." }, { title: "Up" }],
};
const strings = translatableStrings(list);

describe("translatableStrings", () => {
  it("is the title, tier labels and captions, and card titles", () => {
    assert.deepEqual([...strings].sort(), ["A", "Best Pixar Movies", "Monsters, Inc.", "Must watch", "S", "Toy Story", "Up"]);
  });

  it("leaves out what Firestore cannot hold as a key", () => {
    assert.deepEqual([...translatableStrings({ title: "__x__", tiers: [{ label: "", caption: null }], items: [{}] })], []);
  });
});

describe("decideTranslations", () => {
  const decide = (raw: unknown, listBytes = 1000) => decideTranslations({ raw, strings, listBytes });

  it("keeps what the list shows, dots and all", () => {
    assert.deepEqual(decide({ ru: { "Monsters, Inc.": "Корпорация монстров", "Toy Story": "История игрушек" } }), {
      ok: true,
      translations: { ru: { "Monsters, Inc.": "Корпорация монстров", "Toy Story": "История игрушек" } },
      dropped: 0,
    });
  });

  it("drops keys the list does not hold and empty translations", () => {
    assert.deepEqual(decide({ de: { Up: "Oben", Cars: "Cars", S: "  " }, fr: { Cars: "Cars" } }), {
      ok: true,
      translations: { de: { Up: "Oben" } },
      dropped: 3,
    });
  });

  it("turns away a locale the app does not speak, en among them", () => {
    assert.deepEqual(decide({ en: { Up: "Up" } }), { ok: false, status: 400, detail: "locale:en" });
    assert.deepEqual(decide({ it: { Up: "Su" } }), { ok: false, status: 400, detail: "locale:it" });
  });

  it("turns away what is not a map of texts", () => {
    assert.equal(decide(null).ok, false);
    assert.equal(decide([]).ok, false);
    assert.equal(decide({ ru: ["x"] }).ok, false);
    assert.equal(decide({ ru: { Up: 3 } }).ok, false);
  });

  it("holds to the caps", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_TRANSLATIONS_PER_LOCALE + 1 }, (_, at) => [`t${at}`, "x"]));
    assert.deepEqual(decide({ ja: many }), { ok: false, status: 400, detail: "too_many:ja" });
    assert.deepEqual(decide({ ja: { Up: "x".repeat(201) } }), { ok: false, status: 400, detail: "too_long:ja" });
    assert.equal(decide({ ja: { Up: "x".repeat(200) } }).ok, true);
  });

  it("refuses what would not fit in the document beside the list", () => {
    assert.deepEqual(decide({ ru: { Up: "Вверх" } }, 999_990), { ok: false, status: 413, detail: "translations" });
  });
});

describe("pruneTranslations", () => {
  it("keeps only what a replaced list still shows", () => {
    const stored = { ru: { "Toy Story": "История игрушек", Cars: "Тачки" }, pl: { Cars: "Auta" }, xx: { Up: "?" } };
    assert.deepEqual(pruneTranslations(stored, strings), { translations: { ru: { "Toy Story": "История игрушек" } }, dropped: 2 });
  });

  it("makes nothing of nothing", () => {
    assert.deepEqual(pruneTranslations(undefined, strings), { translations: {}, dropped: 0 });
  });
});

describe("titleNames", () => {
  it("is the title in each language that names it", () => {
    const translations = { ru: { "Best Pixar Movies": "Лучшие мультфильмы Pixar", Up: "Вверх" }, de: { Up: "Oben" } };
    assert.deepEqual(titleNames("Best Pixar Movies", translations), { ru: "Лучшие мультфильмы Pixar" });
  });

  it("is empty for a list with no translations", () => {
    assert.deepEqual(titleNames("Up", undefined), {});
  });
});

describe("searchAfterTranslations", () => {
  it("finds the list by its own words and every name at once", () => {
    const after = searchAfterTranslations("Pixar", { ru: "Пиксар" });
    assert.ok(after.searchKeys.includes("pixar") && after.searchKeys.includes("пиксар"));
    assert.equal(after.searchVersion, SEARCH_WORDS_ONLY);
  });

  it("leaves the sweep nothing to do once every language is named", () => {
    const names = Object.fromEntries(TRANSLATION_LOCALES.map((locale) => [locale, `Pixar ${locale}`]));
    assert.equal(searchAfterTranslations("Pixar", names).searchVersion, SEARCH_TRANSLATED);
  });
});
