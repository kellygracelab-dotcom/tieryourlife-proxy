/**
 * Rules for what may be published and in what shape. Pure, like `quota.ts`:
 * the adapter in `community.ts` turns these decisions into Firestore writes.
 */
import { isPictureId, MAX_OWN_PICTURES_PER_LIST } from "./safety";

/**
 * Twenty was low enough that an enthusiastic person would meet it, and it also
 * happened to equal a page of the feed, so one author could never fill more
 * than one page -- which made the feed's paging untestable with one account.
 */
export const MAX_LISTS_PER_AUTHOR = 50;
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
  /** Only ever an https URL. Somebody else's, or our own published copy. */
  imageUrl: string | null;
}

/**
 * A card before its own photograph has been given a public address.
 *
 * Two kinds of picture reach this point and they arrive differently. A poster
 * comes as an https address somebody else already hosts, and is carried
 * through untouched. A photograph out of somebody's gallery comes as the name
 * of a file already sitting in their private folder, and cannot go into the
 * feed as it is -- nobody but them can read that folder. The adapter looks at
 * those, copies the ones that pass, and [settle] puts the new addresses in.
 */
export interface DraftItem {
  title: string;
  imageUrl: string | null;
  pictureId: string | null;
}

export interface PublishDraft {
  title: string;
  titleLower: string;
  category: Category;
  tiers: PublishedTier[];
  items: DraftItem[];
  coverImageUrl: string | null;
  coverPictureId: string | null;
  tierColors: string[];
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

export type PublishDecision = { ok: true; draft: PublishDraft } | { ok: false } & PublishRejection;

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

  const items: DraftItem[] = [];
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const itemTitle = cleanText(item.title, MAX_TITLE_LENGTH);
    const imageUrl = keepableImageUrl(item.imageUrl);
    const pictureId = isPictureId(item.pictureId) ? item.pictureId : null;
    // A card is a name or a picture, and needs one of them to be a card at
    // all. It used to need the name, from back when every card came out of a
    // catalogue and arrived with one; a photograph somebody chose from their
    // gallery has no name and does not need one -- the picture is what it is.
    // A card with neither is nothing, and refusing it is still right.
    if (!itemTitle && !imageUrl && pictureId === null) {
      return { ok: false, reason: "invalid", detail: "An item needs a title or a picture" };
    }
    items.push({ title: itemTitle ?? "", imageUrl, pictureId });
  }

  const coverPictureId = isPictureId(source.coverPictureId) ? source.coverPictureId : null;
  const wanted = new Set(
    [...items.map((item) => item.pictureId), coverPictureId].filter(
      (id): id is string => id !== null,
    ),
  );
  // Counted by distinct picture rather than by card: the same photograph on
  // four cards is one read, one look and one copy.
  if (wanted.size > MAX_OWN_PICTURES_PER_LIST) {
    return { ok: false, reason: "too_large", detail: "Too many of your own photographs" };
  }

  const draft: PublishDraft = {
    title,
    titleLower: title.toLowerCase(),
    category,
    tiers,
    items,
    coverImageUrl: keepableImageUrl(source.coverImageUrl),
    coverPictureId,
    tierColors: tiers.slice(0, MAX_TIER_COLORS).map((tier) => tier.colorLight),
  };

  // Weighed against the addresses our own copies will have, which are longer
  // than nothing and shorter than most posters'. Weighing the draft instead
  // would let a board pass here and outgrow the document later.
  if (JSON.stringify(settle(draft, new Map())).length > MAX_SNAPSHOT_BYTES) {
    return { ok: false, reason: "too_large", detail: "The list is too heavy to store" };
  }

  return { ok: true, draft };
}

/**
 * The draft with its own photographs given the addresses they were copied to.
 *
 * A picture missing from [addresses] leaves its card without art rather than
 * failing the publication: the card still says what it is, and a board of
 * ninety photographs should not be lost to one that would not copy.
 */
export function settle(draft: PublishDraft, addresses: Map<string, string>): PublishedList {
  const resolve = (imageUrl: string | null, pictureId: string | null): string | null =>
    imageUrl ?? (pictureId === null ? null : addresses.get(pictureId) ?? null);

  const items: PublishedItem[] = draft.items.map((item) => ({
    title: item.title,
    imageUrl: resolve(item.imageUrl, item.pictureId),
  }));

  return {
    title: draft.title,
    titleLower: draft.titleLower,
    category: draft.category,
    tiers: draft.tiers,
    items,
    coverImageUrl: resolve(draft.coverImageUrl, draft.coverPictureId),
    previewImages: items
      .map((item) => item.imageUrl)
      .filter((url): url is string => url !== null)
      .slice(0, MAX_PREVIEW_IMAGES),
    tierColors: draft.tierColors,
  };
}

/** Every own photograph a draft names, each one once. */
export function picturesWanted(draft: PublishDraft): string[] {
  return [...new Set(
    [...draft.items.map((item) => item.pictureId), draft.coverPictureId].filter(
      (id): id is string => id !== null,
    ),
  )];
}
