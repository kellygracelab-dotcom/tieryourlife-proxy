/**
 * An iNaturalist photo's author and licence, read from the observation it
 * belongs to (Web's report of 15.11.2026: a photo pasted by its address came
 * without them, where a Commons file gets its own). iNaturalist's API has no
 * lookup by photo id, and its photo pages sit behind a browser check, so the
 * observation is the one place that says: an observation page pasted itself,
 * or the observation page sent with a photo's address.
 */
import { MAX_CREDIT_LENGTH } from "./pictureCredit";
import { getJson } from "./pictureSearch";

/** The licences a house list may show, as iNaturalist codes them. */
const OPEN_CODES = new Set(["cc0", "cc-by", "cc-by-sa", "pd"]);
const PHOTO_HOSTS = new Set(["inaturalist-open-data.s3.amazonaws.com", "static.inaturalist.org"]);
const PHOTO_PATH = /^\/photos\/(\d{1,12})\/(?:original|large|medium|small|square|thumb)\.(jpe?g|png|gif|webp)$/i;

function https(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

/** The id of the iNaturalist observation page [link] is, or null. */
export function observationIdOf(link: string | null | undefined): string | null {
  const url = https(link);
  if (url === null || (url.hostname !== "www.inaturalist.org" && url.hostname !== "inaturalist.org")) return null;
  return /^\/observations\/(\d{1,12})\/?$/.exec(url.pathname)?.[1] ?? null;
}

/** The id of the iNaturalist photo at [address], one of its sizes on either of its hosts, or null. */
export function photoIdOf(address: string | null | undefined): string | null {
  const url = https(address);
  return url !== null && PHOTO_HOSTS.has(url.hostname) ? PHOTO_PATH.exec(url.pathname)?.[1] ?? null : null;
}

/** An observation's photo: its large address and the credit iNaturalist writes for it. */
export interface ObservationPhoto {
  imageUrl: string;
  credit: string | null;
}

/**
 * The photo of a `/v1/observations/{id}` answer: the one with [photoId] when
 * one is asked for (none when the observation has no such photo), otherwise
 * the first one with an open licence, or else the first.
 */
export function observationPhoto(body: unknown, photoId: string | null): ObservationPhoto | null {
  const results = (body as { results?: unknown } | null)?.results;
  const row = Array.isArray(results) ? (results[0] as { photos?: unknown } | undefined) : undefined;
  const photos = (Array.isArray(row?.photos) ? row.photos : []).filter(
    (one): one is Record<string, unknown> => one !== null && typeof one === "object" && photoIdOf((one as { url?: string }).url) !== null,
  );
  const pick = photoId !== null
    ? photos.find((one) => photoIdOf(one.url as string) === photoId)
    : photos.find((one) => typeof one.license_code === "string" && OPEN_CODES.has(one.license_code)) ?? photos[0];
  if (pick === undefined) return null;
  const url = https(pick.url as string)!;
  const imageUrl = `https://${url.hostname}${url.pathname.replace(/\/(?:original|large|medium|small|square|thumb)\.(\w+)$/i, "/large.$1")}`;
  const credit = typeof pick.attribution === "string" ? pick.attribution.replace(/\s+/g, " ").trim().slice(0, MAX_CREDIT_LENGTH) : "";
  return { imageUrl, credit: credit || null };
}

/** How an observation is asked for: iNaturalist's answer, or a throw when there is none. */
export type ObservationAsk = (id: string) => Promise<unknown>;

export const askObservation: ObservationAsk = (id) => getJson(`https://api.inaturalist.org/v1/observations/${id}`);
