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

export function topicPicturePath(topicId: string, pictureId: string): string {
  return `topics/${topicId}/${pictureId}`;
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

/** Every upload gets a new picture id, so a public copy's address never shows other bytes and can be kept for a year. */
export const PUBLIC_PICTURE_CACHE = "public, max-age=31536000, immutable";

/** Into the public folder, where `storage.rules` lets anybody read it. */
export async function publishSectionPicture(path: string, bytes: Buffer, contentType: string): Promise<void> {
  await getStorage().bucket().file(path).save(bytes, { resumable: false, contentType, metadata: { cacheControl: PUBLIC_PICTURE_CACHE } });
}

export async function discardProposalPicture(sectionId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `proposals/${sectionId}/`, force: true });
}

export async function discardStoredPicture(path: string): Promise<void> {
  await getStorage()
    .bucket()
    .file(path)
    .delete()
    .catch(() => undefined);
}

export async function discardSectionPictures(sectionId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `sections/${sectionId}/`, force: true });
}

/** A picture copied for a write that threw is nobody's: it goes, and the error goes on. */
export async function keepingOnlyIfWritten<T>(
  copied: string | null,
  write: () => Promise<T>,
  discard: (path: string) => Promise<void> = discardStoredPicture,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (copied !== null) await discard(copied);
    throw error;
  }
}

/** Every picture a topic has, for a topic that is gone. */
export async function discardTopicPictures(topicId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `topics/${topicId}/`, force: true });
}

/** The Storage path a public address names, or null for one that is not an address of ours. */
export function storedPathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /\/v0\/b\/[^/]+\/o\/([^?]+)/.exec(url);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * The file a picture edit leaves behind: the one shown before, when that was
 * in this folder and is not the one shown now. Only that file, so an edit
 * that lost a race never deletes the winner's.
 */
function replacedIn(folder: string, before: unknown, after: unknown): string | null {
  const old = storedPathOf(before);
  if (old === null || !old.startsWith(folder)) return null;
  return old === storedPathOf(after) ? null : old;
}

export function replacedTopicPicture(topicId: string, before: unknown, after: unknown): string | null {
  return replacedIn(topicPicturePath(topicId, ""), before, after);
}

export function replacedSectionPicture(sectionId: string, before: unknown, after: unknown): string | null {
  return replacedIn(sectionPicturePath(sectionId, ""), before, after);
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
