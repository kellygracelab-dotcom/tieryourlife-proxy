/**
 * Rules for what may be published and in what shape. Pure, like `quota.ts`:
 * the adapter in `community.ts` turns these decisions into Firestore writes.
 */
import { MAX_LINK_LENGTH, type PictureAttribution } from "./pictureAttribution";
import { isPictureId, MAX_OWN_PICTURES_PER_LIST } from "./safety";
import { isSectionId } from "./sections";
import { readAnonymous } from "./anonymous";
import { isDeezerPicture } from "./pictureSources";
import { MAX_CREDIT_LENGTH } from "./pictureCredit";
import { storageMediaUrl } from "./publicMedia";
export { MAX_CREDIT_LENGTH } from "./pictureCredit";

/**
 * Twenty was low enough that an enthusiastic person would meet it, and it also
 * happened to equal a page of the feed, so one author could never fill more
 * than one page -- which made the feed's paging untestable with one account.
 */
export const MAX_LISTS_PER_AUTHOR = 50;
/**
 * Two thousand is where a board still opens without the phone stumbling,
 * measured on a device. The real ceiling is Firestore's one-megabyte
 * document, which a count cannot express, so the assembled snapshot is weighed as well.
 */
export const MAX_ITEMS_PER_LIST = 2000;
/** The most tiers any stored list has: lists published before the limit below may have twenty. */
export const MAX_TIERS_PER_LIST = 20;
/** Ranked tiers a new publication may bring: a board's nineteen, its pool being the unranked cards. */
export const MAX_RANKED_TIERS = 19;
export const MAX_SNAPSHOT_BYTES = 700_000;
export const MAX_TITLE_LENGTH = 80;
export const MAX_CAPTION_LENGTH = 60;
export const FEED_PAGE_SIZE = 20;
export const REPORT_PAGE_SIZE = 50;
export const MAX_PREVIEW_IMAGES = 6;
export const MAX_TIER_COLORS = 5;


export interface PublishedTier {
  label: string;
  caption: string | null;
  colorLight: string;
  colorDark: string;
}

export interface PublishedItem {
  title: string;
  /** Catalogue art where the catalogue keeps it, or our own published copy (`outsidePictures.ts`). */
  imageUrl: string | null;
  /**
   * Which tier the author put this card in, by position in [PublishedList.tiers],
   * or null for one left unranked. Absent on everything published before this
   * existed, which reads as null: those snapshots genuinely do not know.
   */
  tierIndex: number | null;
  /** Who the picture's license asks to be named; absent when nobody. */
  credit?: string;
  /** Where the picture came from and whom it names (`pictureAttribution.ts`); absent for a person's own photo and on lists from before. */
  attribution?: PictureAttribution;
}

/**
 * A card before its own photograph has a public address. A poster comes as an
 * https address and is carried through; a gallery photograph comes as the
 * name of a file in a private folder nobody else can read, so the adapter
 * copies the ones that pass and [settle] puts the new addresses in.
 */
export interface DraftItem {
  title: string;
  imageUrl: string | null;
  pictureId: string | null;
  tierIndex: number | null;
  credit?: string;
  sourceIndex?: number;
  /** What the client sent back of the card's attribution: only its page link and original address are read, and both are checked. */
  sent?: { link?: string; originalUrl?: string; web?: true; id?: string };
  /** Set by the publisher once it knows; `settle` stores it. */
  attribution?: PictureAttribution;
}

export interface PublishDraft {
  title: string;
  titleLower: string;
  /** A section id as written; whether it names a section the author may use is decided against the stored ones. */
  category: string;
  tiers: PublishedTier[];
  items: DraftItem[];
  coverImageUrl: string | null;
  coverPictureId: string | null;
  /** The pictures the author chose for the collage, in their order; empty when the cards' art decides. */
  coverImageUrls: string[];
  tierColors: string[];
  /**
   * Whether to publish without the author's name: true or false when the
   * body says, null when it says nothing, which keeps what a republished list was.
   */
  anonymous: boolean | null;
}

export interface PublishedList {
  title: string;
  /** Lower-cased title, so the feed can be searched by prefix. */
  titleLower: string;
  category: string;
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
  | { reason: "too_many_tiers"; detail: string }
  | { reason: "too_large"; detail: string }
  | { reason: "invalid"; detail: string };

export type PublishDecision = { ok: true; draft: PublishDraft } | { ok: false } & PublishRejection;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Local images never leave the device, so anything that is not an https URL is
 * dropped rather than rejected: a list of holiday photos should still publish,
 * just without the photos.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;
  return trimmed.length > 2000 ? null : storageMediaUrl(trimmed);
}

const OWN_FOLDER = /\/o\/users%2F([^/?#%]+)%2Fpictures%2F([^/?#]+)/i;

function isOwnFolder(url: string): boolean {
  return OWN_FOLDER.test(url);
}

/**
 * An address into someone's own folder carries its download token, so a public
 * list never keeps one. The publisher's own picture becomes the pictureId it
 * is, copied after SafeSearch like any other; older apps still send addresses.
 */
export function ownPictureIdOf(url: string | null, uploaderUid: string): string | null {
  const match = url === null ? null : OWN_FOLDER.exec(url);
  if (match === null || decodeURIComponent(match[1]) !== uploaderUid) return null;
  const id = decodeURIComponent(match[2]);
  return isPictureId(id) ? id : null;
}

function keepableImageUrl(value: unknown): string | null {
  const url = httpsUrl(value);
  return url === null || isOwnFolder(url) ? null : url;
}

/** What a public list may show: Deezer's covers are left out, as if they had never been sent. */
function publicImageUrl(value: unknown): string | null {
  const url = keepableImageUrl(value);
  return isDeezerPicture(url) ? null : url;
}

/**
 * Kept only if it names a tier this board has: out of range means the phone
 * and the snapshot disagree, and the honest answer is "unranked".
 */
function tierIndexOf(value: unknown, tierCount: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value < tierCount ? value : null;
}

/**
 * The collage an author chose: each picture once, in their order, as many as a
 * preview holds, and only ones the feed can fetch. A photograph from the
 * gallery is a card picture and travels as one, not here.
 */
export function chosenPictures(value: unknown, { ownFolder }: { ownFolder: "keep" | "drop" }): string[] {
  const urls = (Array.isArray(value) ? value : [])
    .map(ownFolder === "keep" ? httpsUrl : keepableImageUrl)
    .filter((url): url is string => url !== null);
  return [...new Set(urls)].slice(0, MAX_PREVIEW_IMAGES);
}

/** A tier's label: collapsed, trimmed, not empty, at most a title long. The rankings sheet's labels follow it too. */
export function cleanTierLabel(value: unknown): string | null {
  return cleanText(value, MAX_TITLE_LENGTH);
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
  /** Whose folder the list's own pictures are copied from. */
  uploaderUid: string;
  /** How many tiers the list being replaced already has; absent for a new list. */
  storedTierCount?: number;
}

/** A replaced list may keep the tiers it was published with, when that was more than a new one may have. */
export function tierLimitFor(storedTierCount: number | undefined): number {
  return Math.max(MAX_RANKED_TIERS, storedTierCount ?? 0);
}

export function decidePublish({
  body,
  isAnonymous,
  listsAlreadyPublished,
  uploaderUid,
  storedTierCount,
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

  const category = isSectionId(source.category) ? source.category : null;
  if (!category) {
    return { ok: false, reason: "invalid", detail: "A list needs a category" };
  }

  const rawTiers = Array.isArray(source.tiers) ? source.tiers : null;
  if (!rawTiers || rawTiers.length === 0) {
    return { ok: false, reason: "invalid", detail: "A list needs at least one tier" };
  }
  const tierLimit = tierLimitFor(storedTierCount);
  if (rawTiers.length > tierLimit) {
    return { ok: false, reason: "too_many_tiers", detail: `At most ${tierLimit} ranked tiers` };
  }

  const tiers: PublishedTier[] = [];
  for (const raw of rawTiers) {
    const tier = raw as Record<string, unknown>;
    const label = cleanTierLabel(tier.label);
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
    const imageUrl = publicImageUrl(item.imageUrl);
    const pictureId = isPictureId(item.pictureId) ? item.pictureId : ownPictureIdOf(httpsUrl(item.imageUrl), uploaderUid);
    // A card is a name or a picture and needs one of them: a photograph from
    // the gallery has no name and does not need one. Neither is nothing.
    // A card that had only a Deezer cover still counts as sent, and goes without art.
    if (!itemTitle && !keepableImageUrl(item.imageUrl) && pictureId === null) {
      return { ok: false, reason: "invalid", detail: "An item needs a title or a picture" };
    }
    const credit = cleanText(item.credit, MAX_CREDIT_LENGTH);
    if (item.sourceIndex !== undefined && item.sourceIndex !== null && (!Number.isSafeInteger(item.sourceIndex) || (item.sourceIndex as number) < 0 || (item.sourceIndex as number) >= MAX_ITEMS_PER_LIST)) {
      return { ok: false, reason: "invalid", detail: "Invalid sourceIndex" };
    }
    const sent = sentAttribution(item.attribution);
    items.push({
      title: itemTitle ?? "",
      imageUrl,
      pictureId,
      tierIndex: tierIndexOf(item.tierIndex, tiers.length),
      ...(credit ? { credit } : {}),
      ...(sent ? { sent } : {}),
      ...(typeof item.sourceIndex === "number" ? { sourceIndex: item.sourceIndex } : {}),
    });
  }

  const coverPictureId = isPictureId(source.coverPictureId)
    ? source.coverPictureId
    : ownPictureIdOf(httpsUrl(source.coverImageUrl), uploaderUid);
  const coverImageUrls = chosenPictures(source.coverImageUrls, { ownFolder: "drop" }).filter((url) => !isDeezerPicture(url));
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
    coverImageUrl: publicImageUrl(source.coverImageUrl),
    coverPictureId,
    coverImageUrls,
    tierColors: tiers.slice(0, MAX_TIER_COLORS).map((tier) => tier.colorLight),
    anonymous: readAnonymous(source.anonymous),
  };

  // Weighed against the addresses our own copies will have, which are longer
  // than nothing and shorter than most posters'. Weighing the draft instead
  // would let a board pass here and outgrow the document later.
  if (!snapshotFits(settle(draft, new Map()))) {
    return { ok: false, reason: "too_large", detail: "The list is too heavy to store" };
  }

  return { ok: true, draft };
}

/**
 * A picture missing from [addresses] leaves its card without art rather than
 * failing the publication: ninety photographs should not be lost to one that would not copy.
 */
export function settle(draft: PublishDraft, addresses: Map<string, string>): PublishedList {
  const resolve = (imageUrl: string | null, pictureId: string | null): string | null =>
    imageUrl ?? (pictureId === null ? null : addresses.get(pictureId) ?? null);

  const items: PublishedItem[] = draft.items.map((item) => ({
    title: item.title,
    imageUrl: resolve(item.imageUrl, item.pictureId),
    tierIndex: item.tierIndex,
    ...(item.credit ? { credit: item.credit } : {}),
    ...(item.attribution ? { attribution: item.attribution } : {}),
  }));

  return {
    title: draft.title,
    titleLower: draft.titleLower,
    category: draft.category,
    tiers: draft.tiers,
    items,
    coverImageUrl: resolve(draft.coverImageUrl, draft.coverPictureId),
    // What the author chose, or failing that the first cards' art.
    previewImages: draft.coverImageUrls.length > 0
      ? draft.coverImageUrls
      : items
        .map((item) => item.imageUrl)
        .filter((url): url is string => url !== null)
        .slice(0, MAX_PREVIEW_IMAGES),
    tierColors: draft.tierColors,
  };
}

/**
 * What the server reads back of a card's `attribution`: its page link, its
 * original address, and whether a picture of the person's own folder came from
 * another site. It works out the rest itself.
 */
function sentAttribution(raw: unknown): DraftItem["sent"] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { link, originalUrl, source, id } = raw as Record<string, unknown>;
  const short = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= MAX_LINK_LENGTH ? value : null);
  const sent = {
    ...(short(link) ? { link: link as string } : {}),
    ...(short(originalUrl) ? { originalUrl: originalUrl as string } : {}),
    ...(source === "web" ? { web: true as const } : {}),
    ...(typeof id === "string" && id.length > 0 && id.length <= 100 ? { id } : {}),
  };
  return Object.keys(sent).length > 0 ? sent : null;
}

/** The wire and Firestore limits are bytes, including multibyte names and credits. */
export function snapshotFits(value: object): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_SNAPSHOT_BYTES;
}

/**
 * How many cards sit in each tier, in tier order, and how many are left
 * unranked, last, as the pool: what a list page needs to lay itself out
 * before the cards arrive. A card naming a tier the list does not have is
 * counted with the unranked ones, as `tierIndexOf` reads it.
 */
export function tierCountsOf(tierCount: number, items: readonly { tierIndex?: unknown }[]): number[] {
  const counts = new Array(tierCount + 1).fill(0);
  for (const item of items) {
    const tier = item.tierIndex;
    const placed = typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier < tierCount;
    counts[placed ? tier : tierCount] += 1;
  }
  return counts;
}

/**
 * The board a publication comes from, by the device's own uid: present and
 * small, never parsed. The same author publishing the same board again is
 * answered with the list it already made.
 */
export function readBoardUid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

/** Every own photograph a draft names, each one once. */
export function picturesWanted(draft: PublishDraft): string[] {
  return [...new Set(
    [...draft.items.map((item) => item.pictureId), draft.coverPictureId].filter(
      (id): id is string => id !== null,
    ),
  )];
}
