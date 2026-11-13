import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COPY_SWITCHES, readCopySwitches, wantsCopy } from "../src/pictureCopies";

const POSTER = "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg";
const COMMONS = "https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Tyrannosaurus_Rex_Holotype.jpg/500px-Tyrannosaurus_Rex_Holotype.jpg";
const LICENSED = { source: "wikimedia" as const, license: "CC BY-SA 4.0", link: "https://commons.wikimedia.org/wiki/File:Tyrannosaurus_Rex_Holotype.jpg" };

describe("the switches of picture copies, one per catalogue", () => {
  it("are the openly licensed only until one is written, and each one written counts alone", () => {
    assert.deepEqual(readCopySwitches(undefined), DEFAULT_COPY_SWITCHES);
    assert.deepEqual(readCopySwitches({ sources: "all" }), DEFAULT_COPY_SWITCHES);
    const read = readCopySwitches({ sources: { tmdb: true, wikimedia: false, igdb: "yes", deezer: true } });
    assert.deepEqual(read, { ...DEFAULT_COPY_SWITCHES, tmdb: true, wikimedia: false });
  });

  it("copy a catalogue switched on, a Commons file only with its licence, and never another site or Deezer", () => {
    const all = readCopySwitches({ sources: { tmdb: true, anilist: true, igdb: true, steam: true, openlibrary: true } });
    assert.equal(wantsCopy(POSTER, null, all), true);
    assert.equal(wantsCopy(POSTER, null, DEFAULT_COPY_SWITCHES), false);
    assert.equal(wantsCopy(COMMONS, LICENSED, all), true);
    assert.equal(wantsCopy(COMMONS, { source: "wikimedia", link: LICENSED.link }, all), false);
    assert.equal(wantsCopy(COMMONS, LICENSED, { ...all, wikimedia: false }), false);
    assert.equal(wantsCopy("https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg", null, all), false);
    assert.equal(wantsCopy("https://example.com/found.jpg", null, all), false);
    assert.equal(wantsCopy(null, null, all), false);
  });
});
