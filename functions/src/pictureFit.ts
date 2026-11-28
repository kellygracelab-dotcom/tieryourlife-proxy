/**
 * A catalogue copy is kept at most COPY_LONGEST pixels on its long side (28.11.2026). Open Library has
 * no size between its 500 px cover and the uploaded original (up to 4000 px and more), and a tall
 * Commons file at its 960 px width is 1440 px high: both are made smaller here, as the site makes its
 * own copies (sharp 0.35.5, Web functions/src/pictures.ts). A picture already small enough, an
 * animated GIF, or one sharp cannot read is kept as it came.
 */
import type sharpModule from "sharp";

export const COPY_LONGEST = 1200;

export interface Picture {
  bytes: Buffer;
  type: string;
}

let loaded: Promise<typeof sharpModule> | null = null;
/** Loaded the first time a picture needs it: most copies never do, and a cold start should not pay for it. */
function sharp(): Promise<typeof sharpModule> {
  loaded ??= import("sharp").then((one) => ((one as unknown as { default?: typeof sharpModule }).default ?? (one as unknown as typeof sharpModule)));
  return loaded;
}

/** [picture] no longer than [longest] pixels on its long side, in its own format. */
export async function fitPicture(picture: Picture, longest: number = COPY_LONGEST): Promise<Picture> {
  if (!/^image\/(jpeg|png|webp)$/.test(picture.type)) return picture;
  try {
    const make = await sharp();
    const meta = await make(picture.bytes).metadata();
    // EXIF orientations 5 to 8 turn the picture a quarter: its long side is the other one.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    if (!width || !height || Math.max(width, height) <= longest || (meta.pages ?? 1) > 1) return picture;
    const resized = make(picture.bytes).rotate().resize({ width: longest, height: longest, fit: "inside", withoutEnlargement: true });
    if (picture.type === "image/png") return { bytes: await resized.png({ compressionLevel: 9 }).toBuffer(), type: "image/png" };
    if (picture.type === "image/webp") return { bytes: await resized.webp({ quality: 80 }).toBuffer(), type: "image/webp" };
    return { bytes: await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), type: "image/jpeg" };
  } catch (error) {
    console.warn(`A picture could not be made smaller, kept as it came: ${String(error)}`);
    return picture;
  }
}
