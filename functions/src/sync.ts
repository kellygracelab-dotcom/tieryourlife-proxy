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
import { chosenPictures } from "./publishing";

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
  /** The pictures chosen for the cover collage, in their order; empty when the cards' art decides. */
  coverImageUrls: string[];
  authorName: string | null;
  publishedId: string | null;
  /** When the whole board went to the trash, or null while it is in use. */
  deletedAt: number | null;
  tiers: StoredTier[];
  items: StoredItem[];
  /** A game of play mode under way on this board; absent when there is none. */
  play?: Play;
  /** The author publishes this board without their name; absent, rather than false, when they do not. */
  anonymous?: true;
}

export const PLAY_KINDS = ["swiss", "hill", "bracket"] as const;
export type PlayKind = (typeof PLAY_KINDS)[number];

/** Play is offered for two to sixty-four cards; a bigger board picks a subset first. */
export const MIN_PLAY_CARDS = 2;
export const MAX_PLAY_CARDS = 64;
export const MAX_PLAY_HISTORY = 2000;

/** A game nobody has touched for a month is not coming back; it stops travelling. */
export const PLAY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** One answer: the two cards, by their place in `ids`, and which went on, or null for a skip. */
export type PlayOutcome = [number, number, number | null];

/**
 * A game as the engine needs it to resume anywhere: what kind, which cards in
 * which order, the seed, and every answer so far. See docs/play-mode-spec.md
 * in the app.
 */
export interface Play {
  kind: PlayKind;
  count: number;
  seed: number;
  refine: boolean;
  ids: string[];
  history: PlayOutcome[];
  round: number;
  startedAt: number;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function playOutcome(value: unknown, count: number): PlayOutcome | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [first, second, winner] = value;
  if (!isInteger(first, 0, count - 1) || !isInteger(second, 0, count - 1) || first === second) return null;
  if (winner !== null && winner !== first && winner !== second) return null;
  return [first, second, winner];
}

/**
 * A game, read strictly: every field present and of its kind, the cards two
 * to sixty-four distinct ids with `count` saying as many, every answer naming
 * two different cards of them and a winner that is one of the two or nobody.
 * Anything else is no game at all, and the board is kept without it.
 */
export function readPlay(value: unknown): Play | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const kind = PLAY_KINDS.find((known) => known === source.kind);
  if (!kind || typeof source.refine !== "boolean") return null;
  if (!Array.isArray(source.ids) || source.ids.length < MIN_PLAY_CARDS || source.ids.length > MAX_PLAY_CARDS) return null;
  const ids = source.ids.map(uid);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
  if (!isInteger(source.count, MIN_PLAY_CARDS, MAX_PLAY_CARDS) || source.count !== ids.length) return null;
  if (!isInteger(source.seed, INT32_MIN, INT32_MAX)) return null;
  if (!isInteger(source.round, 0, MAX_PLAY_HISTORY)) return null;
  if (!isInteger(source.startedAt, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(source.history) || source.history.length > MAX_PLAY_HISTORY) return null;
  const count = source.count;
  const history = source.history.map((one) => playOutcome(one, count));
  if (history.some((one) => one === null)) return null;
  return {
    kind,
    count,
    seed: source.seed,
    refine: source.refine,
    ids: ids as string[],
    history: history as PlayOutcome[],
    round: source.round,
    startedAt: source.startedAt,
  };
}

/**
 * Firestore keeps no array inside an array, so the answers are stored flat,
 * three numbers each, a skip's winner as -1; and with them when this
 * service last stored the game, which is what its month is counted from.
 */
export interface StoredPlay extends Omit<Play, "history"> {
  history: number[];
  touchedAt: number;
}

/** A game kept, and when it was last written by this service. */
export interface KeptPlay {
  play: Play;
  touchedAt: number;
}

/** A game as stored, stamped with the server's own time of this write. */
export function playToDocument(play: Play, touchedAt: number): StoredPlay {
  return {
    ...play,
    history: play.history.flatMap(([first, second, winner]) => [first, second, winner ?? -1]),
    touchedAt,
  };
}

/**
 * A stored game read back, or nothing when what is stored is not one any
 * more. One stored before the stamp existed counts from when it started.
 */
export function playFromDocument(stored: unknown): KeptPlay | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { history: flat, touchedAt, ...rest } = stored as { history?: unknown; touchedAt?: unknown };
  if (!Array.isArray(flat) || flat.length % 3 !== 0) return null;
  const history: unknown[] = [];
  for (let at = 0; at < flat.length; at += 3) {
    history.push([flat[at], flat[at + 1], flat[at + 2] === -1 ? null : flat[at + 2]]);
  }
  const play = readPlay({ ...rest, history });
  if (play === null) return null;
  return { play, touchedAt: typeof touchedAt === "number" && Number.isFinite(touchedAt) ? touchedAt : play.startedAt };
}

/** A game still worth handing back: one written within the last month. */
export function livePlay(kept: KeptPlay | null, nowMs: number): Play | null {
  if (kept === null) return null;
  return nowMs - kept.touchedAt <= PLAY_LIFETIME_MS ? kept.play : null;
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
  /** The server's time: a game cannot have started after it. */
  nowMs: number;
}

export function decideStore({ body, isAnonymous, boardsAlreadyKept, nowMs }: StoreInput): StoreDecision {
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
    coverImageUrls: chosenPictures(source.coverImageUrls),
    authorName: cleanText(source.authorName, MAX_TITLE_LENGTH),
    publishedId: cleanText(source.publishedId, MAX_TITLE_LENGTH),
    deletedAt: timestamp(source.deletedAt),
    tiers,
    items,
  };
  // Added only when there is one, so a board without a game or the flag is
  // stored and handed back exactly as it always was.
  if (source.anonymous === true) board.anonymous = true;
  if (JSON.stringify(board).length > MAX_BOARD_BYTES) {
    return { ok: false, reason: "too_large", detail: "The board is too heavy to keep" };
  }
  const play = readPlay(source.play);
  // A game never costs the board itself: one that would push it past the
  // ceiling is left behind, and a clock running ahead cannot start one later than now.
  if (play !== null) {
    const kept = { ...play, startedAt: Math.min(play.startedAt, nowMs) };
    if (JSON.stringify({ ...board, play: kept }).length <= MAX_BOARD_BYTES) board.play = kept;
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
