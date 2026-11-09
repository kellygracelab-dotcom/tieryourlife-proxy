import type { Response } from "express";

const BUCKET = "tieryourlife.firebasestorage.app";
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`;
const ORIGINAL = "https://tieryourlife.web.app/img/original/";
const KINDS = new Set(["published", "avatars", "sections", "topics"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PICTURE = /^[A-Za-z0-9_-]+$/;

/** The same allowlist as the site's existing original-image handler, never users/ or proposals/. */
function publicPath(parts: string[]): string | null {
  if (parts.length !== 3) return null;
  const [kind, id, picture] = parts;
  const path = parts.join("/");
  return path.length <= 1024 && KINDS.has(kind) && ID.test(id) && PICTURE.test(picture) ? path : null;
}

function pathOf(url: string): string | null {
  if (url.startsWith(ORIGINAL)) return publicPath(url.slice(ORIGINAL.length).split(/[?#]/)[0].split("/"));
  if (!url.startsWith(STORAGE)) return null;
  const query = url.indexOf("?", STORAGE.length);
  if (query < 0 || new URLSearchParams(url.slice(query + 1).split("#")[0]).get("alt") !== "media") return null;
  return publicPath(url.slice(STORAGE.length, query).split(/%2f/i));
}

/** Public display bytes do not require the old client's image loader to know about App Check. */
export function publicMediaUrl(url: string): string {
  const path = pathOf(url);
  return path === null ? url : ORIGINAL + path;
}

/** Keep stored picture identities and publication/copy matching independent of the display address. */
export function storageMediaUrl(url: string): string {
  const path = pathOf(url);
  return path === null ? url : `${STORAGE}${encodeURIComponent(path)}?alt=media`;
}

const IMAGE_FIELDS = new Set([
  "imageUrl", "coverImageUrl", "authorPhotoUrl", "photoUrl", "pictureUrl", "url",
  "previewImages", "collage",
]);

/** Only image fields change on the wire. IDs, titles, credits and stored documents stay as they were. */
export function publicMediaJson(value: unknown, field = ""): unknown {
  if (typeof value === "string") return IMAGE_FIELDS.has(field) ? publicMediaUrl(value) : value;
  if (Array.isArray(value)) return value.map((item) => publicMediaJson(item, field));
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicMediaJson(item, key)]));
}

/** Community's single JSON boundary covers feed/detail, House, rankings, sections and account faces. */
export function publicMediaResponses(response: Response): void {
  const json = response.json.bind(response);
  response.json = (body: unknown) => json(publicMediaJson(body));
}
