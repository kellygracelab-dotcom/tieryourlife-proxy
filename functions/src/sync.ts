/**
 * Rules for the copy of a board an account keeps. Pure, like `publishing.ts`:
 * the adapter in `boards.ts` turns these decisions into Firestore writes.
 *
 * This is not the published snapshot. A published list is a picture of a board
 * arranged for strangers to look at; this is the board itself, the thing a
 * person would lose with their phone -- pool included, trash included, the
 * order of everything, and the identifiers that let a second device recognise
 * a board it has already seen rather than duplicating it.
 */

/**
 * Firestore's own ceiling is a megabyte per document. The same headroom as a
 * published snapshot, for the same reason: a count of cards cannot express
 * weight, since two hundred cards with very long addresses outweigh a thousand
 * with short ones.
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
   * The device's own short stand-in for these contents. Opaque here -- never
   * parsed, never compared, only handed back. It exists so a phone whose
   * database returned from a system backup can tell "the same board twice"
   * from "two afternoons", which a revision number cannot say.
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
 * Whether a write may land on what is already there.
 *
 * The device says which revision it was working from. If the account has moved
 * on since, two people edited the same board apart from each other, and there
 * is no arithmetic that merges them -- the order of cards is the content, and
 * an automatic merge would silently invent an arrangement neither person made.
 * So the write is refused and the caller is handed what is stored, to keep
 * beside its own.
 *
 * A first write says nothing, which is how a board arrives on a second device
 * with the same uid: the same board, not a conflict.
 */
export type WriteVerdict = "create" | "update" | "conflict";

export function decideWrite(storedRevision: number | null, basedOn: unknown): WriteVerdict {
  if (storedRevision === null) {
    return "create";
  }
  return typeof basedOn === "number" && basedOn === storedRevision ? "update" : "conflict";
}
