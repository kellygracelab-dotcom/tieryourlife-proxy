import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESULT_LIMIT,
  coverUrl,
  gamesQuery,
  isSearchable,
  releaseYear,
  toCatalogue,
  tokenFrom,
  tokenIsUsable,
} from "../src/igdb";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

describe("gamesQuery", () => {
  it("asks for the fields a card needs and nothing else", () => {
    const query = gamesQuery("Silksong");

    assert.match(query, /search "Silksong";/);
    assert.match(query, /fields name, first_release_date, cover\.image_id;/);
    assert.match(query, /limit 20;/);
  });

  // Bundles and season passes carry the name of the game inside them, so one
  // real game comes back several times over unless they are excluded.
  it("leaves out the kinds nobody ranks", () => {
    assert.match(gamesQuery("Doom"), /where category = \(0,8,9,10,11,4\) & version_parent = null;/);
  });

  // Their language has no placeholders, so a quote in the box would end the
  // search string early and the rest would be read as more statements.
  it("cannot have its query closed early by a quote", () => {
    const query = gamesQuery('Silksong"; fields id; where id = 1');
    const search = query.slice(0, query.indexOf(";") + 1);

    assert.equal(query.match(/"/g)?.length, 2);
    assert.equal(search, 'search "Silksong   fields id  where id = 1";');
  });

  it("cannot be made to ask for more than a page", () => {
    assert.match(gamesQuery("Doom", 500), new RegExp(`limit ${RESULT_LIMIT};`));
  });
});

describe("isSearchable", () => {
  it("wants two letters, like the screen that asks", () => {
    assert.equal(isSearchable("D"), false);
    assert.equal(isSearchable("  "), false);
    assert.equal(isSearchable('""'), false);
    assert.equal(isSearchable("Doom"), true);
  });
});

describe("toCatalogue", () => {
  it("keeps a game that has no cover", () => {
    const out = toCatalogue([{ id: 1, name: "Unillustrated" }]);

    assert.deepEqual(out, [{ id: 1, name: "Unillustrated", year: null, imageUrl: null }]);
  });

  it("builds the cover address from the image id", () => {
    const out = toCatalogue([{ id: 2, name: "Silksong", cover: { image_id: "co9abc" } }]);

    assert.equal(out[0].imageUrl, "https://images.igdb.com/igdb/image/upload/t_cover_big/co9abc.jpg");
  });

  it("turns a release date into a year", () => {
    const out = toCatalogue([
      { id: 3, name: "Blue Prince", first_release_date: Date.parse("2025-04-10") / 1000 },
    ]);

    assert.equal(out[0].year, 2025);
  });

  // A nameless card is a blank the reader can neither recognise nor rank.
  it("drops a row with no name", () => {
    assert.deepEqual(toCatalogue([{ id: 4 }, { id: 5, name: "   " }]), []);
  });

  it("keeps the first of a repeated id and the order it arrived in", () => {
    const out = toCatalogue([
      { id: 6, name: "First" },
      { id: 7, name: "Second" },
      { id: 6, name: "First again" },
    ]);

    assert.deepEqual(out.map((game) => game.name), ["First", "Second"]);
  });
});

describe("releaseYear", () => {
  it("has no year rather than 1970 for something undated", () => {
    assert.equal(releaseYear(undefined), null);
    assert.equal(releaseYear(Number.NaN), null);
  });
});

describe("coverUrl", () => {
  it("is nothing at all when there is no image", () => {
    assert.equal(coverUrl(undefined), null);
  });
});

describe("the token we hold between requests", () => {
  it("is reused while it has a minute of life left", () => {
    assert.equal(tokenIsUsable({ token: "t", expiresAtMs: NOW + 120_000 }, NOW), true);
  });

  // Fetched for a request that has not been made yet: a token valid at the
  // check and expired at the request would fail for no reason.
  it("is replaced in the last minute, before it can expire mid-request", () => {
    assert.equal(tokenIsUsable({ token: "t", expiresAtMs: NOW + 30_000 }, NOW), false);
    assert.equal(tokenIsUsable(null, NOW), false);
  });

  it("is read from what Twitch sends back", () => {
    assert.deepEqual(tokenFrom({ access_token: "abc", expires_in: 100 }, NOW), {
      token: "abc",
      expiresAtMs: NOW + 100_000,
    });
  });

  it("is nothing when the reply is not one we can use", () => {
    assert.equal(tokenFrom({}, NOW), null);
    assert.equal(tokenFrom({ access_token: "abc" }, NOW), null);
    assert.equal(tokenFrom({ access_token: "  ", expires_in: 100 }, NOW), null);
    assert.equal(tokenFrom({ access_token: "abc", expires_in: 0 }, NOW), null);
  });
});
