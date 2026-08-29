/**
 * Rules for what may be published and in what shape. Pure, like `quota.ts`:
 * the adapter in `community.ts` turns these decisions into Firestore writes.
 */

export const MAX_LISTS_PER_AUTHOR = 20;
/**
 * Someone can genuinely have watched thousands of films, so the count is
 * generous. Two thousand is where a board still opens without the phone
 * stumbling over it, measured on a device rather than guessed. The real
 * ceiling is Firestore's one-megabyte document, which a count alone cannot
 * express -- a list of two hundred cards with very long addresses can outweigh
 * a thousand with short ones -- so the assembled snapshot is weighed as well,
 * well under the limit.
 */
export const MAX_ITEMS_PER_LIST = 2000;
export const MAX_TIERS_PER_LIST = 20;
export const MAX_SNAPSHOT_BYTES = 700_000;
export const MAX_TITLE_LENGTH = 80;
export const MAX_CAPTION_LENGTH = 60;
export const FEED_PAGE_SIZE = 20;
export const REPORT_PAGE_SIZE = 50;
export const MAX_PREVIEW_IMAGES = 6;
export const MAX_TIER_COLORS = 5;

/**
 * Eight of them, fixed. A free-text category would splinter the feed into
 * synonyms nobody can browse.
 */
export const CATEGORIES = [
  "anime",
  "film_tv",
  "games",
  "music",
  "food",
  "sport",
  "people",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface PublishedTier {
  label: string;
  caption: string | null;
  colorLight: string;
  colorDark: string;
}

export interface PublishedItem {
  title: string;
  /** Only ever an https URL someone else already hosts. */
  imageUrl: string | null;
}

export interface PublishedList {
  title: string;
  /** Lower-cased title, so the feed can be searched by prefix. */
  titleLower: string;
  category: Category;
  tiers: PublishedTier[];
  items: PublishedItem[];
  /** Author's own cover, only ever an https URL. */
  coverImageUrl: string | null;
  /** Enough card art for the feed to draw a mosaic without opening the list. */
  previewImages: string[];
  /** The author's palette, for a card that has neither a cover nor card art. */
  tierColors: string[];
}

export type PublishRejection =
  | { reason: "not_signed_in" }
  | { reason: "too_many_lists" }
  | { reason: "too_large"; detail: string }
  | { reason: "invalid"; detail: string };

export type PublishDecision = { ok: true; list: PublishedList } | { ok: false } & PublishRejection;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Local images never leave the device, so anything that is not an https URL is
 * dropped rather than rejected: a list of holiday photos should still publish,
 * just without the photos.
 */
function keepableImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;
  return trimmed.length > 2000 ? null : trimmed;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, maxLength);
}

export interface PublishInput {
  body: unknown;
  isAnonymous: boolean;
  listsAlreadyPublished: number;
}

export function decidePublish({
  body,
  isAnonymous,
  listsAlreadyPublished,
}: PublishInput): PublishDecision {
  // Reading and copying stay open to everyone; putting your name on something
  // does not.
  if (isAnonymous) {
    return { ok: false, reason: "not_signed_in" };
  }
  if (listsAlreadyPublished >= MAX_LISTS_PER_AUTHOR) {
    return { ok: false, reason: "too_many_lists" };
  }

  const source = body as Record<string, unknown> | null;
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "invalid", detail: "Body must be an object" };
  }

  const title = cleanText(source.title, MAX_TITLE_LENGTH);
  if (!title) {
    return { ok: false, reason: "invalid", detail: "A list needs a title" };
  }

  const category = CATEGORIES.find((known) => known === source.category);
  if (!category) {
    return { ok: false, reason: "invalid", detail: "A list needs a category" };
  }

  const rawTiers = Array.isArray(source.tiers) ? source.tiers : null;
  if (!rawTiers || rawTiers.length === 0) {
    return { ok: false, reason: "invalid", detail: "A list needs at least one tier" };
  }
  if (rawTiers.length > MAX_TIERS_PER_LIST) {
    return { ok: false, reason: "too_large", detail: "Too many tiers" };
  }

  const tiers: PublishedTier[] = [];
  for (const raw of rawTiers) {
    const tier = raw as Record<string, unknown>;
    const label = cleanText(tier.label, MAX_TITLE_LENGTH);
    const colorLight = typeof tier.colorLight === "string" ? tier.colorLight : "";
    const colorDark = typeof tier.colorDark === "string" ? tier.colorDark : "";
    if (!label || !HEX_COLOR.test(colorLight) || !HEX_COLOR.test(colorDark)) {
      return { ok: false, reason: "invalid", detail: "A tier needs a label and two hex colours" };
    }
    tiers.push({ label, caption: cleanText(tier.caption, MAX_CAPTION_LENGTH), colorLight, colorDark });
  }

  const rawItems = Array.isArray(source.items) ? source.items : null;
  if (!rawItems || rawItems.length === 0) {
    return { ok: false, reason: "invalid", detail: "A list needs at least one item" };
  }
  if (rawItems.length > MAX_ITEMS_PER_LIST) {
    return { ok: false, reason: "too_large", detail: "Too many items" };
  }

  const items: PublishedItem[] = [];
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const itemTitle = cleanText(item.title, MAX_TITLE_LENGTH);
    if (!itemTitle) {
      return { ok: false, reason: "invalid", detail: "An item needs a title" };
    }
    items.push({ title: itemTitle, imageUrl: keepableImageUrl(item.imageUrl) });
  }

  const list: PublishedList = {
    title,
    titleLower: title.toLowerCase(),
    category,
    tiers,
    items,
    coverImageUrl: keepableImageUrl(source.coverImageUrl),
    previewImages: items
      .map((item) => item.imageUrl)
      .filter((url): url is string => url !== null)
      .slice(0, MAX_PREVIEW_IMAGES),
    tierColors: tiers.slice(0, MAX_TIER_COLORS).map((tier) => tier.colorLight),
  };

  if (JSON.stringify(list).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, reason: "too_large", detail: "The list is too heavy to store" };
  }

  return { ok: true, list };
}
