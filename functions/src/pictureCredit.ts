/** A whole attribution, including licence and source links, in the existing optional field. */
export const MAX_CREDIT_LENGTH = 1000;

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function decode(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", copy: "©" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|copy);/gi, (entity, key: string) => {
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? entity;
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

function safeUrl(value: string): string | null {
  try {
    const raw = decode(value).trim();
    if (!/^(https?:\/\/|\/\/|\/)/i.test(raw) || /\s/.test(raw)) return null;
    const url = new URL(raw, "https://commons.wikimedia.org");
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function plain(value: string): string {
  return decode(value.replace(/<\/?[^>]+>/g, " ")).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  const safe = value.replace(/<!--[^]*?-->/g, "").replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  return plain(safe.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([^]*?)<\/a\s*>/gi, (_all, href: string, label: string) => {
    const url = safeUrl(href);
    const name = plain(label);
    return url && name !== url ? `${name} (${url})` : name;
  }));
}

const BARE_URL = /^(?:https?:)?\/\/\S+$/i;
/** Commons' {{self}} credit, "I, Name": the uploader speaking of themselves. */
const SELF = /^I\s*,\s*(?=\S)/;
const URL_IN_BRACKETS = /\s*\((?:https?:)?\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*\)/gi;

/**
 * The name a credit shows for a Commons author, without addresses: Commons
 * writes a linked author as "Name (https://…)", and a frame from a YouTube
 * video often names the channel by its address alone. "Name (address)" keeps
 * the name; an address alone gives the channel's handle or user name it
 * carries (`youtube.com/@TV10` → "@TV10", `/user/mang2goon` → "mang2goon"),
 * "YouTube" for a YouTube address that names nobody (`/channel/UC…`), and the
 * site's name for any other. The address itself is not kept: a credit has no
 * field for an author's page, and the file's page (`link`) says the rest.
 * A trailing " - YouTube" on a channel's name goes too, and the "I, " of a
 * {{self}} credit ("I, Luc Viatour" → "Luc Viatour") (since 14.11.2026).
 */
export function authorName(raw: string): string {
  const named = raw.replace(URL_IN_BRACKETS, "").replace(/\s+-\s+YouTube$/i, "").replace(/\s+/g, " ").trim().replace(SELF, "");
  if (named !== "" && !BARE_URL.test(named)) return named;
  const address = named !== "" ? named : (/(?:https?:)?\/\/[^\s()]+/i.exec(raw)?.[0] ?? "");
  let url: URL;
  try {
    url = new URL(address.startsWith("//") ? `https:${address}` : address);
  } catch {
    return named;
  }
  const host = url.hostname.replace(/^(?:www|m)\./, "");
  if (host === "youtube.com" || host === "youtu.be") {
    const handle = /^\/(@[\w.-]{1,100})/.exec(url.pathname)?.[1];
    if (handle) return handle;
    const user = /^\/(?:user|c)\/([\w.-]{1,100})/.exec(url.pathname)?.[1];
    return user ?? "YouTube";
  }
  return host;
}

/** Undefined when nothing was supplied; null when a known attribution cannot be kept whole. */
export function commonsCredit(page: unknown, info: unknown): string | undefined | null {
  const file = object(page);
  const image = object(info);
  const metadata = object(image.extmetadata);
  const field = (key: string) => text(object(metadata[key]).value);
  const author = field("Attribution") || [field("Artist"), field("Credit")].filter(Boolean).join(" · ");
  const licence = field("LicenseShortName") || field("UsageTerms");
  const licenceRaw = object(metadata.LicenseUrl).value;
  const licenceUrls = typeof licenceRaw === "string"
    ? [...licenceRaw.matchAll(/(?:https?:)?\/\/[^\s<>"']+/gi)].map((match) => safeUrl(match[0])).filter((url): url is string => url !== null)
    : [];
  if (!author && !licence && licenceUrls.length === 0) return undefined;
  const pageId = file.pageid;
  const source = typeof pageId === "number" && Number.isSafeInteger(pageId) && pageId > 0
    ? `https://commons.wikimedia.org/?curid=${pageId}`
    : typeof file.title === "string"
      ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.title.replace(/ /g, "_"))}`
      : null;
  const credit = [...new Set([author, licence, ...licenceUrls, source].filter((part): part is string => Boolean(part)))].join(" · ");
  return credit.length <= MAX_CREDIT_LENGTH ? credit : null;
}

/**
 * The same metadata as separate fields: author, licence, licence page and the
 * file's page. Undefined when Commons names no licence, which is also when a
 * copy is not made.
 */
export function commonsDetails(page: unknown, info: unknown): { author?: string; license: string; licenseUrl?: string; link: string } | undefined {
  const file = object(page);
  const metadata = object(object(info).extmetadata);
  const field = (key: string) => text(object(metadata[key]).value);
  const license = field("LicenseShortName") || field("UsageTerms");
  if (!license) return undefined;
  const author = authorName(field("Attribution") || field("Artist") || field("Credit"));
  const licenceRaw = object(metadata.LicenseUrl).value;
  const licenseUrl = typeof licenceRaw === "string"
    ? [...licenceRaw.matchAll(/(?:https?:)?\/\/[^\s<>"']+/gi)].map((match) => safeUrl(match[0])).find((url): url is string => url !== null)
    : undefined;
  const pageId = file.pageid;
  const link = typeof pageId === "number" && Number.isSafeInteger(pageId) && pageId > 0
    ? `https://commons.wikimedia.org/?curid=${pageId}`
    : `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(file.title ?? "").replace(/ /g, "_"))}`;
  return {
    ...(author ? { author: author.slice(0, 300) } : {}),
    license: license.slice(0, 100),
    ...(licenseUrl ? { licenseUrl: licenseUrl.replace(/^http:/, "https:") } : {}),
    link,
  };
}
