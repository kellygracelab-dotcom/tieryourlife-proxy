import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageSize, judgePicture, MIN_PICTURE_WIDTH } from "../src/imageSize";

const bytes = (...parts: (number[] | string)[]) =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));
const u16be = (value: number) => [value >> 8, value & 0xff];
const u32be = (value: number) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

function png(width: number, height: number): Buffer {
  return bytes([0x89], "PNG\r\n\x1a\n", u32be(13), "IHDR", u32be(width), u32be(height), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
}

/** A JFIF header, a Huffman table that must not be read as a frame, then the frame. */
function jpeg(width: number, height: number, frame = 0xc0): Buffer {
  const app0 = bytes([0xff, 0xe0], u16be(16), "JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dht = bytes([0xff, 0xc4], u16be(5), [0, 0, 0]);
  const sof = bytes([0xff, frame], u16be(17), [8], u16be(height), u16be(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return bytes([0xff, 0xd8], [...app0], [...dht], [...sof], [0xff, 0xda]);
}

function riff(chunk: string, body: number[]): Buffer {
  const padded = [...body, ...new Array(Math.max(0, 10 - body.length)).fill(0)];
  return bytes("RIFF", u32be(0), "WEBP", chunk, u32be(padded.length), padded);
}

const webpExtended = (width: number, height: number) => riff("VP8X", [0x10, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
const webpLossy = (width: number, height: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
function webpLossless(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
}

describe("imageSize", () => {
  it("reads a PNG's header", () => {
    assert.deepEqual(imageSize(png(1600, 1000)), { format: "png", width: 1600, height: 1000 });
  });

  it("reads a JPEG's frame past the segments before it", () => {
    assert.deepEqual(imageSize(jpeg(1920, 1200)), { format: "jpeg", width: 1920, height: 1200 });
  });

  it("reads a progressive JPEG's frame too", () => {
    assert.deepEqual(imageSize(jpeg(1280, 800, 0xc2)), { format: "jpeg", width: 1280, height: 800 });
  });

  it("reads the three kinds of WebP", () => {
    assert.deepEqual(imageSize(webpExtended(2400, 1500)), { format: "webp", width: 2400, height: 1500 });
    assert.deepEqual(imageSize(webpLossy(1600, 1000)), { format: "webp", width: 1600, height: 1000 });
    assert.deepEqual(imageSize(webpLossless(1600, 1000)), { format: "webp", width: 1600, height: 1000 });
  });

  it("knows nothing else", () => {
    assert.equal(imageSize(Buffer.from("GIF89a and the rest of it")), null);
    assert.equal(imageSize(Buffer.alloc(0)), null);
  });

  it("gives up on a header cut short", () => {
    assert.equal(imageSize(png(1600, 1000).subarray(0, 20)), null);
    assert.equal(imageSize(jpeg(1600, 1000).subarray(0, 30)), null);
    assert.equal(imageSize(webpLossy(1600, 1000).subarray(0, 24)), null);
  });

  it("gives up on a JPEG whose scan starts before any frame", () => {
    assert.equal(imageSize(bytes([0xff, 0xd8, 0xff, 0xda], u16be(8), [0, 0, 0, 0, 0, 0])), null);
  });
});

describe("judgePicture", () => {
  it("takes a picture wide enough at sixteen by ten", () => {
    assert.deepEqual(judgePicture(png(1600, 1000)), { ok: true, size: { format: "png", width: 1600, height: 1000 } });
    assert.equal(judgePicture(jpeg(MIN_PICTURE_WIDTH, 600)).ok, true);
  });

  it("takes the 1600 by 1000 WebP both clients upload, and sets no upper bound", () => {
    assert.deepEqual(judgePicture(webpLossy(1600, 1000)), { ok: true, size: { format: "webp", width: 1600, height: 1000 } });
    assert.equal(judgePicture(webpExtended(1600, 1000)).ok, true);
    assert.equal(judgePicture(webpExtended(4000, 2500)).ok, true);
  });

  it("says when there is no picture", () => {
    assert.deepEqual(judgePicture(null), { ok: false, why: "missing" });
  });

  it("says when it is not a picture", () => {
    assert.deepEqual(judgePicture(Buffer.from("not an image at all, just words")), { ok: false, why: "not_image" });
    assert.deepEqual(judgePicture(png(0, 0)), { ok: false, why: "not_image" });
  });

  it("says when it is too narrow", () => {
    assert.deepEqual(judgePicture(png(MIN_PICTURE_WIDTH - 16, 590)), { ok: false, why: "too_small" });
  });

  it("allows two percent either side of sixteen by ten, and no more", () => {
    assert.equal(judgePicture(png(1600, 1016)).ok, true);
    assert.equal(judgePicture(png(1600, 985)).ok, true);
    assert.deepEqual(judgePicture(png(1600, 1040)), { ok: false, why: "not_16_10" });
    assert.deepEqual(judgePicture(png(1600, 1200)), { ok: false, why: "not_16_10" });
    assert.deepEqual(judgePicture(png(1600, 900)), { ok: false, why: "not_16_10" });
  });
});
