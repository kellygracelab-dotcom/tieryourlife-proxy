/**
 * A section's picture in Storage. A proposal's picture is copied out of the
 * proposer's own folder at once, because the daily sweep deletes pictures no
 * board names, and a proposal can wait longer than a day. That copy is
 * private and is shown to the proposer and the moderators by an unguessable
 * address; approval copies it again into the public `sections/` folder.
 */
import { getStorage } from "firebase-admin/storage";
import { addressOf, privatePath } from "./publishedPictures";
import type { WeightedColour } from "./sectionColours";

export function proposalPath(sectionId: string, pictureId: string): string {
  return `proposals/${sectionId}/${pictureId}`;
}

export function sectionPicturePath(sectionId: string, pictureId: string): string {
  return `sections/${sectionId}/${pictureId}`;
}

/** The picture id a stored path ends with. */
export function pictureIdOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A download-token address: Storage serves it to whoever holds it, whatever
 * the rules say, so it is only ever handed to the people who may see the file.
 */
export function tokenAddressOf(bucket: string, path: string, token: string): string {
  return `${addressOf(bucket, path)}&token=${encodeURIComponent(token)}`;
}

export function bucketName(): string {
  return getStorage().bucket().name;
}

async function download(path: string): Promise<Buffer | null> {
  try {
    const [bytes] = await getStorage().bucket().file(path).download();
    return bytes;
  } catch {
    return null;
  }
}

/** Somebody's own upload, or null when it is not there. */
export async function readOwnPicture(uid: string, pictureId: string): Promise<Buffer | null> {
  return await download(privatePath(uid, pictureId));
}

export async function readStoredPicture(path: string): Promise<Buffer | null> {
  return await download(path);
}

export async function keepForProposal(path: string, bytes: Buffer, contentType: string, token: string): Promise<void> {
  await getStorage()
    .bucket()
    .file(path)
    .save(bytes, { resumable: false, contentType, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
}

/** Into the public folder, where `storage.rules` lets anybody read it. */
export async function publishSectionPicture(path: string, bytes: Buffer, contentType: string): Promise<void> {
  await getStorage().bucket().file(path).save(bytes, { resumable: false, contentType });
}

export async function discardProposalPicture(sectionId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `proposals/${sectionId}/`, force: true });
}

export async function discardSectionPictures(sectionId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `sections/${sectionId}/`, force: true });
}

/** The pictures a section had before a moderator gave it a new one. */
export async function discardOtherSectionPictures(sectionId: string, keeping: string): Promise<void> {
  const prefix = `sections/${sectionId}/`;
  const [files] = await getStorage().bucket().getFiles({ prefix });
  await Promise.all(
    files
      .filter((file) => file.name.slice(prefix.length) !== keeping)
      .map((file) => file.delete().catch(() => undefined)),
  );
}

/**
 * Vision's dominant colours, each weighed by the share of the picture it
 * covers. They stand in for the pixels of §5's shrunk picture: decoding JPEG,
 * PNG and WebP here would take a dependency for every format.
 */
export async function realPictureColours(image: Buffer): Promise<WeightedColour[]> {
  // Imported here rather than at the top, as in publishedPictures.ts: most calls never need it.
  const { ImageAnnotatorClient } = await import("@google-cloud/vision");
  const client = new ImageAnnotatorClient();
  const [response] = await client.batchAnnotateImages({
    requests: [{ image: { content: image }, features: [{ type: "IMAGE_PROPERTIES" }] }],
  });
  const colours = response.responses?.[0]?.imagePropertiesAnnotation?.dominantColors?.colors ?? [];
  return colours.map((one) => ({
    r: Math.round(Number(one.color?.red ?? 0)),
    g: Math.round(Number(one.color?.green ?? 0)),
    b: Math.round(Number(one.color?.blue ?? 0)),
    weight: Number(one.pixelFraction ?? one.score ?? 0),
    score: Number(one.score ?? 0),
  }));
}
