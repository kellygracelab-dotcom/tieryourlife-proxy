/**
 * A picture's author, licence and page as the house's editor gives them
 * (Danylo's decision of 13.11.2026): on a card of a house publication, and on
 * its cover. Kept as given, marked `manual: true`, and never worked out again
 * by publishing, the backfill or `refreshPictures`. Anyone else's are ignored:
 * their pictures carry only what the server works out itself.
 *
 * A credit without a licence permits nothing, and one without the page it
 * stands on cannot be checked, so both are required. When the page is a
 * Commons file, a Flickr photo or an iNaturalist observation and the author
 * or the licence is left empty, they are read from there.
 */
import { askCommons } from "./cataloguePictures";
import {
  commonsFileOf,
  inaturalistLicence,
  MAX_AUTHOR_LENGTH,
  MAX_LICENSE_LENGTH,
  MAX_LINK_LENGTH,
  pageLink,
  type ManualAttribution,
} from "./pictureAttribution";
import { getJson } from "./pictureSearch";

/** What an editor sent, read but not yet decided. */
export interface ManualAsk {
  author?: string;
  license?: string;
  licenseUrl?: string;
  link?: string;
}

/** What the page a credit stands on says about the picture, where it says anything. */
export interface PageCredit {
  author?: string;
  license?: string;
  licenseUrl?: string;
}

export type ManualRefusal = "NO_LICENSE" | "UNKNOWN_LICENSE" | "NO_LINK" | "BAD_LINK" | "BAD_LICENSE_URL" | "TOO_LONG";

export const USED_WITH_PERMISSION = "Used with permission";
const PUBLIC_DOMAIN = "Public domain";
const CC_VERSIONS = new Set(["1.0", "2.0", "2.5", "3.0", "4.0"]);

/** A Creative Commons deed's address as the licence it names (`by-sa/2.0` → CC BY-SA 2.0). */
const DEED = /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses\/(by|by-sa)\/(\d\.\d)(?:\/[a-z]{2,3})?|publicdomain\/(zero|mark)\/1\.0)\/?(?:deed\.[a-z-]+)?$/i;

/**
 * [raw] as one of the licences a manual credit may name, in its one shape, with
 * its deed where it has one: CC0 1.0, CC BY or CC BY-SA with a version, Public
 * domain, or Used with permission. A deed's address names its licence too.
 * Null for anything else.
 */
export function knownLicence(raw: string): { license: string; licenseUrl?: string } | null {
  const deed = DEED.exec(raw.trim());
  if (deed) return knownLicence(deed[3] === "zero" ? "CC0" : deed[3] === "mark" ? "Public domain" : `CC ${deed[1]} ${deed[2]}`);
  const plain = raw.replace(/[\s_-]+/g, " ").trim().toUpperCase();
  if (plain === "CC0" || plain === "CC0 1.0" || plain === "CC ZERO" || plain === "PUBLIC DOMAIN DEDICATION (CC0)") {
    return { license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" };
  }
  if (plain === "PUBLIC DOMAIN" || plain === "PD" || plain === "PUBLIC DOMAIN MARK") {
    return { license: PUBLIC_DOMAIN, licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/" };
  }
  if (plain === "USED WITH PERMISSION") return { license: USED_WITH_PERMISSION };
  const cc = /^CC BY( SA)? (\d\.\d)(?: [A-Z]{2,3})?$/.exec(plain);
  if (cc && CC_VERSIONS.has(cc[2]!)) {
    const kind = cc[1] ? "by-sa" : "by";
    return { license: `CC ${kind.toUpperCase()} ${cc[2]}`, licenseUrl: `https://creativecommons.org/licenses/${kind}/${cc[2]}/` };
  }
  return null;
}

/**
 * The manual credit an attribution carries, when it says `manual: true`: its
 * four fields as sent, or what is wrong with them. Null when it says nothing
 * of the kind. `manual: false` is [cleared]: the editor took theirs off.
 */
export function readManual(raw: unknown): ManualAsk | { error: ManualRefusal } | "cleared" | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.manual === false) return "cleared";
  if (value.manual !== true) return null;
  const text = (key: string): string | undefined => {
    const one = value[key];
    return typeof one === "string" && one.replace(/\s+/g, " ").trim() !== "" ? one.replace(/\s+/g, " ").trim() : undefined;
  };
  const author = text("author");
  const license = text("license");
  const licenseUrl = text("licenseUrl");
  const link = text("link");
  if ((author?.length ?? 0) > MAX_AUTHOR_LENGTH || (license?.length ?? 0) > MAX_LICENSE_LENGTH) return { error: "TOO_LONG" };
  if (link !== undefined && pageLink(link) === null) return { error: link.length > MAX_LINK_LENGTH ? "TOO_LONG" : "BAD_LINK" };
  if (licenseUrl !== undefined && pageLink(licenseUrl) === null) return { error: licenseUrl.length > MAX_LINK_LENGTH ? "TOO_LONG" : "BAD_LICENSE_URL" };
  return {
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(licenseUrl ? { licenseUrl: pageLink(licenseUrl)! } : {}),
    ...(link ? { link: pageLink(link)! } : {}),
  };
}

/**
 * The credit kept for [asked]: each field the editor left empty is taken from
 * what its page says ([page]), and the licence must be one we know.
 */
export function decideManual(asked: ManualAsk, page: PageCredit | null): ManualAttribution | { error: ManualRefusal } {
  if (!asked.link) return { error: "NO_LINK" };
  const given = asked.license ? knownLicence(asked.license) : null;
  if (asked.license && given === null) return { error: "UNKNOWN_LICENSE" };
  const found = !given && page?.license ? knownLicence(page.license) : null;
  const licence = given ?? found;
  if (licence === null) return { error: page?.license ? "UNKNOWN_LICENSE" : "NO_LICENSE" };
  const author = asked.author ?? page?.author?.slice(0, MAX_AUTHOR_LENGTH);
  const licenseUrl = asked.licenseUrl ?? (found && page?.licenseUrl ? pageLink(page.licenseUrl) ?? licence.licenseUrl : licence.licenseUrl);
  return {
    ...(author ? { author } : {}),
    license: licence.license,
    ...(licenseUrl ? { licenseUrl } : {}),
    link: asked.link,
    manual: true,
  };
}

/** Whether [link] is a page whose credit can be read: a Commons file, a Flickr photo, an iNaturalist observation. */
export function readablePage(link: string): "commons" | "flickr" | "inaturalist" | null {
  const one = new URL(link);
  if (commonsFileOf(link) !== null) return "commons";
  if ((one.hostname === "www.flickr.com" || one.hostname === "flickr.com") && /^\/photos\/[^/]+\/\d{1,20}\/?$/.test(one.pathname)) return "flickr";
  if ((one.hostname === "www.inaturalist.org" || one.hostname === "inaturalist.org") && /^\/observations\/\d{1,12}\/?$/.test(one.pathname)) return "inaturalist";
  return null;
}

/** Flickr's oEmbed answer about one photo, as a credit. */
export function flickrCredit(body: unknown): PageCredit | null {
  const value = (body ?? {}) as Record<string, unknown>;
  if (value.type !== "photo") return null;
  const text = (key: string) => (typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string).trim() : undefined);
  // Flickr names a licence in words ("Attribution-ShareAlike License"); its deed says which version.
  const license = text("license_url") && DEED.test(text("license_url")!) ? text("license_url") : text("license");
  if (!license) return null;
  return { ...(text("author_name") ? { author: text("author_name") } : {}), license, ...(text("license_url") ? { licenseUrl: text("license_url") } : {}) };
}

/** iNaturalist's answer about one observation, as the credit of its first photo. */
export function inaturalistCredit(body: unknown): PageCredit | null {
  const results = (body as { results?: unknown } | null)?.results;
  const photo = Array.isArray(results) ? ((results[0] as { photos?: unknown[] } | undefined)?.photos?.[0] as { attribution?: unknown } | undefined) : undefined;
  const attribution = typeof photo?.attribution === "string" ? photo.attribution : null;
  const licence = inaturalistLicence(attribution);
  return licence === null ? null : { ...licence };
}

/** What [link] says about the picture, when the editor left the author or the licence to it. Null when it says nothing. */
export async function pageCredit(link: string): Promise<PageCredit | null> {
  try {
    switch (readablePage(link)) {
      case "commons": {
        const file = commonsFileOf(link)!;
        const details = (await askCommons([file])).get(file);
        return details?.license ? { ...(details.author ? { author: details.author } : {}), license: details.license, ...(details.licenseUrl ? { licenseUrl: details.licenseUrl } : {}) } : null;
      }
      case "flickr":
        return flickrCredit(await getJson(`https://www.flickr.com/services/oembed/?${new URLSearchParams({ format: "json", url: link })}`));
      case "inaturalist": {
        const id = /\/observations\/(\d+)/.exec(link)![1];
        return inaturalistCredit(await getJson(`https://api.inaturalist.org/v1/observations/${id}`));
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** [asked] decided: looked up on its page when it leaves the author or the licence empty. */
export async function manualAttributionOf(asked: ManualAsk): Promise<ManualAttribution | { error: ManualRefusal }> {
  const page = asked.link && (!asked.author || !asked.license) ? await pageCredit(asked.link) : null;
  return decideManual(asked, page);
}

/** Pages read at once while a publication's credits are decided. */
const LOOKUPS_AT_ONCE = 4;

/** Whether [asked] is the credit [known] already is, sent back as stored: then nothing is looked up again. */
export function sameCredit(asked: ManualAsk, known: ManualAttribution | null | undefined): known is ManualAttribution {
  if (!known || asked.link !== known.link || !asked.license || knownLicence(asked.license)?.license !== known.license) return false;
  return (asked.author ?? known.author) === known.author && (asked.licenseUrl ?? known.licenseUrl) === known.licenseUrl;
}

/**
 * Each raw attribution of a house publication as the editor's credit: decided,
 * "cleared", null when it gives none, or what is wrong with it. A credit sent
 * back as [known] has it is kept as it is; the others' pages are read a few at a time.
 */
export async function manualCredits(
  raws: readonly unknown[],
  known: readonly (ManualAttribution | null | undefined)[] = [],
): Promise<(ManualAttribution | "cleared" | { error: ManualRefusal } | null)[]> {
  const read = raws.map(readManual);
  const decided: (ManualAttribution | "cleared" | { error: ManualRefusal } | null)[] = read.map((one, at) => {
    if (one === null || one === "cleared" || "error" in one) return one;
    return sameCredit(one, known[at]) ? known[at]! : null;
  });
  const asks = read.flatMap((one, at) => (one !== null && one !== "cleared" && !("error" in one) && decided[at] === null ? [{ at, ask: one }] : []));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < asks.length) {
      const { at, ask } = asks[next++]!;
      decided[at] = await manualAttributionOf(ask);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, asks.length) }, worker));
  return decided;
}
