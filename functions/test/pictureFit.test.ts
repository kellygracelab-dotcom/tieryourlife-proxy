import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { copySourcesOf } from "../src/cataloguePictures";
import { COPY_LONGEST, fitPicture } from "../src/pictureFit";

const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });

describe("a copy at most 1200 px on its long side (28.11.2026)", () => {
  it("makes a large JPEG smaller in its own shape, and keeps it a JPEG", async () => {
    const big = { bytes: await solid(2676, 4358).jpeg().toBuffer(), type: "image/jpeg" };
    const fitted = await fitPicture(big);
    const meta = await sharp(fitted.bytes).metadata();
    assert.equal(fitted.type, "image/jpeg");
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.height, COPY_LONGEST);
    assert.equal(meta.width, Math.round((2676 * COPY_LONGEST) / 4358));
  });

  it("keeps a PNG a PNG and a WebP a WebP", async () => {
    const png = await fitPicture({ bytes: await solid(960, 1440).png().toBuffer(), type: "image/png" });
    assert.equal(png.type, "image/png");
    assert.deepEqual([(await sharp(png.bytes).metadata()).width, (await sharp(png.bytes).metadata()).height], [800, 1200]);
    const webp = await fitPicture({ bytes: await solid(2000, 1000).webp().toBuffer(), type: "image/webp" });
    assert.equal(webp.type, "image/webp");
    assert.equal((await sharp(webp.bytes).metadata()).width, 1200);
  });

  it("leaves a picture small enough, an unreadable one and a GIF exactly as they came", async () => {
    const small = { bytes: await solid(780, 1170).jpeg().toBuffer(), type: "image/jpeg" };
    assert.equal(await fitPicture(small), small);
    const broken = { bytes: Buffer.from("not a picture"), type: "image/jpeg" };
    assert.equal(await fitPicture(broken), broken);
    const gif = { bytes: Buffer.from("GIF89a"), type: "image/gif" };
    assert.equal(await fitPicture(gif), gif);
  });

  it("turns a picture its EXIF says is turned, and measures it turned", async () => {
    const turned = await solid(1000, 3000).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const fitted = await fitPicture({ bytes: turned, type: "image/jpeg" });
    const meta = await sharp(fitted.bytes).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 400], "upright: 3000 wide, 1000 high");
  });
});

describe("an Open Library cover copied", () => {
  it("is taken from its uploaded original, then its 500 px cover", () => {
    assert.deepEqual(copySourcesOf("https://covers.openlibrary.org/b/id/15155833-L.jpg"), [
      "https://covers.openlibrary.org/b/id/15155833.jpg",
      "https://covers.openlibrary.org/b/id/15155833-L.jpg",
    ]);
  });
});
