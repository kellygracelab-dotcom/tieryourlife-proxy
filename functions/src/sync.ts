/**
 * Rules for the copy of a board an account keeps. Pure, like `publishing.ts`:
 * `boards.ts` turns these decisions into Firestore writes. Not the published
 * snapshot: this is the board itself, pool and trash included, with the
 * identifiers that let a second device recognise a board it has seen.
 */

/**
 * Firestore's ceiling is a megabyte per document. A count of cards cannot
 * express weight: two hundred cards with long addresses outweigh a thousand short ones.
 */
export const MAX_BOARD_BYTES = 700_000;
export const MAX_ITEMS_PER_BOARD = 2000;
export const MAX_TIERS_PER_BOARD = 20;
/**
 * Someone with two hundred boards is not backing up a hobby any more. High
 * enough that nobody honest meets it, low enough that an account cannot be
 * turned into free storage.
 */
export const MAX_BOARDS_PER_ACCOUNT = 200;
export const MAX_TITLE_LENGTH = 80;
export const MAX_CAPTION_LENGTH = 60;
export const MAX_URL_LENGTH = 2000;
/** Long enough for any digest a device might use to stand for a board. */
export const MAX_FINGERPRINT_LENGTH = 128;
/** How many boards an index page names before the caller asks for more. */
export const BOARD_PAGE_SIZE = 100;

/**
 * Where a board came from, shown on the copy kept after a conflict: "from
 * Pixel 7" is the only thing that tells two versions of the same board apart.
 */
export const MAX_DEVICE_NAME_LENGTH = 40;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DISPLAY_MODES = ["WRAP", "RANKED"] as const;
const ITEM_SOURCES = ["MANUAL", "TMDB", "GENERATED"] as const;

export interface StoredTier {
  uid: string;
  position: number;
  label: string;
  caption: string | null;
  colorLight: string;
  colorDark: string;
  isPool: boolean;
}

export interface StoredItem {
  uid: string;
  /**
   * A picture of this person's own, kept in their account. The id is the
   * file's own name, which means the same thing on a second phone; the path
   * around it does not, so only this travels.
   */
  pictureId: string | null;
  /** The tier it sits in, by the tier's own uid rather than a row number. */
  tierUid: string;
  position: number;
  title: string;
  imageUrl: string | null;
  source: string;
  /** When it went to the trash, or null while it is on the board. */
  deletedAt: number | null;
}

export interface StoredBoard {
  /**
   * The device's own stand-in for these contents; opaque here, only handed
   * back. Lets a phone whose database returned from a system backup tell "the
   * same board twice" from "two afternoons", which a revision number cannot.
   */
  fingerprint: string | null;
  title: string;
  displayMode: string;
  category: string | null;
  coverImageUrl: string | null;
  authorName: string | null;
  publishedId: string | null;
  /** When the whole board went to the trash, or null while it is in use. */
  deletedAt: number | null;
  tiers: StoredTier[];
  items: StoredItem[];
}

export type StoreRejection =
  | { reason: "not_signed_in" }
  | { reason: "too_many_boards" }
  | { reason: "too_large"; detail: string }
  | { reason: "invalid"; detail: string };

export type StoreDecision = { ok: true; board: StoredBoard } | { ok: false } & StoreRejection;

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, maxLength);
}

/**
 * A picture the account can still find later. A file on the old phone cannot
 * be one, so it is dropped rather than rejected -- the board comes back
 * without that card's art, which beats not coming back.
 */
function keepableImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;
  return trimmed.length > MAX_URL_LENGTH ? null : trimmed;
}

/**
 * Only ever compared and used to address a file, so the check is that it could
 * be a file name at all. Anything with a slash or a dot leading somewhere is
 * refused outright: this string is concatenated into a storage path.
 */
function pictureId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Uids are made on the device and only ever compared, never parsed, so the
 * check is that one is present and small rather than that it is a UUID. A
 * board written by a future version with a different id scheme should still
 * come back.
 */
function uid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

export function cleanDeviceName(value: unknown): string | null {
  return cleanText(value, MAX_DEVICE_NAME_LENGTH);
}

export interface StoreInput {
  body: unknown;
  isAnonymous: boolean;
  /** How many boards the account already keeps, excluding the one being written. */
  boardsAlreadyKept: number;
}

export function decideStore({ body, isAnonymous, boardsAlreadyKept }: StoreInput): StoreDecision {
  // An anonymous identity lives in the install, so keeping its boards would be
  // a backup whose key is destroyed by the very thing it protects against.
  if (isAnonymous) {
    return { ok: false, reason: "not_signed_in" };
  }
  if (boardsAlreadyKept >= MAX_BOARDS_PER_ACCOUNT) {
    return { ok: false, reason: "too_many_boards" };
  }

  const source = body as Record<string, unknown> | null;
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "invalid", detail: "Body must be an object" };
  }

  const title = cleanText(source.title, MAX_TITLE_LENGTH);
  if (!title) {
    return { ok: false, reason: "invalid", detail: "A board needs a title" };
  }

  const rawTiers = Array.isArray(source.tiers) ? source.tiers : null;
  if (!rawTiers || rawTiers.length === 0) {
    return { ok: false, reason: "invalid", detail: "A board needs at least one tier" };
  }
  if (rawTiers.length > MAX_TIERS_PER_BOARD) {
    return { ok: false, reason: "too_large", detail: "Too many tiers" };
  }

  const tiers: StoredTier[] = [];
  const tierUids = new Set<string>();
  for (const raw of rawTiers) {
    const tier = raw as Record<string, unknown>;
    const tierUid = uid(tier.uid);
    const label = cleanText(tier.label, MAX_TITLE_LENGTH);
    const colorLight = typeof tier.colorLight === "string" ? tier.colorLight : "";
    const colorDark = typeof tier.colorDark === "string" ? tier.colorDark : "";
    if (!tierUid) {
      return { ok: false, reason: "invalid", detail: "A tier needs an id" };
    }
    if (tierUids.has(tierUid)) {
      return { ok: false, reason: "invalid", detail: "Two tiers share an id" };
    }
    if (!label || !HEX_COLOR.test(colorLight) || !HEX_COLOR.test(colorDark)) {
      return { ok: false, reason: "invalid", detail: "A tier needs a label and two hex colours" };
    }
    tierUids.add(tierUid);
    tiers.push({
      uid: tierUid,
      position: Math.max(0, Math.trunc(Number(tier.position) || 0)),
      label,
      caption: cleanText(tier.caption, MAX_CAPTION_LENGTH),
      colorLight,
      colorDark,
      isPool: tier.isPool === true,
    });
  }

  // An empty board is worth keeping. Someone who made the tiers, named them,
  // and got as far as the shop is exactly the person whose work should
  // survive; refusing until there is a first card would drop it.
  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (rawItems.length > MAX_ITEMS_PER_BOARD) {
    return { ok: false, reason: "too_large", detail: "Too many items" };
  }

  const items: StoredItem[] = [];
  const itemUids = new Set<string>();
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const itemUid = uid(item.uid);
    const tierUid = uid(item.tierUid);
    const itemTitle = cleanText(item.title, MAX_TITLE_LENGTH);
    if (!itemUid) {
      return { ok: false, reason: "invalid", detail: "An item needs an id" };
    }
    if (itemUids.has(itemUid)) {
      return { ok: false, reason: "invalid", detail: "Two items share an id" };
    }
    // A card pointing at a tier that is not here would come back as a card
    // nobody can see, which reads as data loss rather than as a bad write.
    if (!tierUid || !tierUids.has(tierUid)) {
      return { ok: false, reason: "invalid", detail: "An item names a tier that is not on the board" };
    }
    if (!itemTitle) {
      return { ok: false, reason: "invalid", detail: "An item needs a title" };
    }
    itemUids.add(itemUid);
    items.push({
      uid: itemUid,
      pictureId: pictureId(item.pictureId),
      tierUid,
      position: Math.max(0, Math.trunc(Number(item.position) || 0)),
      title: itemTitle,
      imageUrl: keepableImageUrl(item.imageUrl),
      source: ITEM_SOURCES.find((known) => known === item.source) ?? "MANUAL",
      deletedAt: timestamp(item.deletedAt),
    });
  }

  const board: StoredBoard = {
    fingerprint: cleanText(source.fingerprint, MAX_FINGERPRINT_LENGTH),
    title,
    displayMode: DISPLAY_MODES.find((known) => known === source.displayMode) ?? "WRAP",
    category: cleanText(source.category, MAX_TITLE_LENGTH),
    coverImageUrl: keepableImageUrl(source.coverImageUrl),
    authorName: cleanText(source.authorName, MAX_TITLE_LENGTH),
    publishedId: cleanText(source.publishedId, MAX_TITLE_LENGTH),
    deletedAt: timestamp(source.deletedAt),
    tiers,
    items,
  };

  if (JSON.stringify(board).length > MAX_BOARD_BYTES) {
    return { ok: false, reason: "too_large", detail: "The board is too heavy to keep" };
  }

  return { ok: true, board };
}

/**
 * Whether a write may land on what is already there. If the account has moved
 * on since the revision the device worked from, two people edited the board
 * apart and there is no merge -- the order of cards is the content -- so the
 * write is refused and the caller is handed what is stored. A first write says
 * nothing: the same board arriving on a second device is not a conflict.
 *
 * The revision alone cannot tell the two apart: a phone that uploads a board
 * and dies before writing down the revision it was given comes back saying the
 * old number, and judged on numbers it kept a second copy of its own board per
 * crash. The fingerprint settles it: the same content as stored is that lost
 * receipt, and only a number is handed back.
 */
export type WriteVerdict = "create" | "update" | "conflict" | "already";

export interface StoredWrite {
  revision: number;
  fingerprint: string | null;
}

export function decideWrite(stored: StoredWrite | null, basedOn: unknown, fingerprint: string | null): WriteVerdict {
  if (stored === null) {
    return "create";
  }
  if (typeof basedOn === "number" && basedOn === stored.revision) {
    return "update";
  }
  // Only a fingerprint that exists on both sides says anything. Two boards
  // that have never been fingerprinted are not thereby the same board.
  if (fingerprint !== null && fingerprint === stored.fingerprint) {
    return "already";
  }
  return "conflict";
}
