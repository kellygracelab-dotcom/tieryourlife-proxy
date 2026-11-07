import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPLOADS_PER_DAY, isAnimated, judgeUpload, looksLikePicture, ownPictureOwner } from "../src/pictureBytes";
import { gifOf, webpOf } from "./pictureFixtures";
import { STUB_PICTURE } from "../src/emulator";

const ascii = (text: string) => Buffer.from(text, "latin1");

describe("looksLikePicture", () => {
  it("takes JPEG, PNG, GIF and WebP by their first bytes", () => {
    assert.ok(looksLikePicture(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])));
    assert.ok(looksLikePicture(STUB_PICTURE));
    assert.ok(looksLikePicture(ascii("GIF89a\x01\x00")));
    assert.ok(looksLikePicture(ascii("GIF87a\x01\x00")));
    assert.ok(looksLikePicture(ascii("RIFF\x24\x00\x00\x00WEBPVP8 ")));
  });

  it("refuses anything else, whatever type it was uploaded as", () => {
    assert.equal(looksLikePicture(ascii("%PDF-1.7\n")), false);
    assert.equal(looksLikePicture(ascii("PK\x03\x04zipfile")), false);
    assert.equal(looksLikePicture(ascii("<svg xmlns=")), false);
    assert.equal(looksLikePicture(ascii("RIFF\x24\x00\x00\x00WAVEfmt ")), false);
    assert.equal(looksLikePicture(Buffer.from([0xff, 0xd8])), false);
    assert.equal(looksLikePicture(Buffer.alloc(0)), false);
  });
});

describe("ownPictureOwner", () => {
  it("names the owner of a file in somebody's own folder", () => {
    assert.equal(ownPictureOwner("users/abc123/pictures/p-1"), "abc123");
  });

  it("leaves every other folder alone", () => {
    assert.equal(ownPictureOwner("published/list1/p-1"), null);
    assert.equal(ownPictureOwner("avatars/abc123/p-1"), null);
    assert.equal(ownPictureOwner("users/abc123/pictures/nested/p-1"), null);
    assert.equal(ownPictureOwner("users/abc123/other/p-1"), null);
  });
});

describe("judgeUpload", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const live = async () => false;

  it("keeps a picture up to the daily limit and removes the one past it", async () => {
    assert.equal(await judgeUpload(jpeg, async () => UPLOADS_PER_DAY, live), "keep");
    assert.equal(await judgeUpload(jpeg, async () => UPLOADS_PER_DAY + 1, live), "overDailyLimit");
  });

  it("does not count a file that is not a picture", async () => {
    let counted = false;
    const verdict = await judgeUpload(ascii("%PDF"), async () => {
      counted = true;
      return 1;
    }, live);

    assert.equal(verdict, "notAPicture");
    assert.equal(counted, false);
  });

  // QA S16: another phone of an erased account uploads with the token it still holds.
  it("removes a picture an erased account uploads, without counting it", async () => {
    let counted = false;
    const verdict = await judgeUpload(jpeg, async () => {
      counted = true;
      return 1;
    }, async () => true);

    assert.equal(verdict, "accountErased");
    assert.equal(counted, false);
  });
});

describe("isAnimated", () => {
  it("knows a GIF of more than one image", () => {
    assert.equal(isAnimated(gifOf(1)), false);
    assert.equal(isAnimated(gifOf(1, { palette: true, comment: true })), false);
    assert.equal(isAnimated(gifOf(2)), true);
    assert.equal(isAnimated(gifOf(3, { palette: true, comment: true })), true);
  });

  it("knows a WebP by its animation flag or an animation chunk", () => {
    const still = webpOf(["VP8 ", [1, 2, 3, 4]]);
    const extendedStill = webpOf(["VP8X", [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ["VP8 ", [1, 2]]);
    const flagged = webpOf(["VP8X", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ["VP8 ", [1, 2]]);
    const chunked = webpOf(["VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], ["ANIM", [0, 0, 0, 0, 0, 0]], ["ANMF", [1, 2, 3]]);
    assert.equal(isAnimated(still), false);
    assert.equal(isAnimated(extendedStill), false);
    assert.equal(isAnimated(flagged), true);
    assert.equal(isAnimated(chunked), true);
  });

  it("leaves a JPEG, a PNG and bytes cut short alone", () => {
    assert.equal(isAnimated(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false);
    assert.equal(isAnimated(STUB_PICTURE), false);
    assert.equal(isAnimated(gifOf(2).subarray(0, 20)), false);
  });
});
