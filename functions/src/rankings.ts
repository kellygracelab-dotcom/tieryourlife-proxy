/**
 * A ranking of somebody else's list. Taking a list and publishing it again
 * with the same cards is not a second list: it is this reader's placing of
 * the author's cards, kept beside the original and counted on it. Pure, like
 * the rest of the deciding here; `community.ts` does the reads and writes.
 */

import { pictureKey } from "./pictureAttribution";
import { isDeezerPicture } from "./pictureSources";
import { cleanTierLabel, MAX_TIERS_PER_LIST, MAX_TITLE_LENGTH, MAX_CAPTION_LENGTH } from "./publishing";
import { EDITORIAL_UID, TRANSLATION_LOCALES, type Translations } from "./editorial";

export const RANKINGS_PAGE_SIZE = 30;

/** A card as the deciding here needs to see it: a name and, maybe, a picture. */
export interface Card {
  title: string;
  imageUrl: string | null;
  /** A new private asset is content, but its private id never goes into a preflight result. */
  pictureId?: string | null;
}

/** A card with where its owner put it. */
export interface PlacedCard extends Card {
  tierIndex: number | null;
  sourceIndex?: number;
}

/**
 * The list a copy came from. An empty name and uid when that list went out
 * without one: never null, which the installed app cannot read.
 */
export interface BasedOn {
  id: string;
  title: string;
  authorUid: string;
  authorName: string;
}

/** The list a board was saved from, as much of it as the decision needs. */
export interface SourceList {
  id: string;
  authorUid: string;
  title: string;
  authorName: string;
  /** Published without a name, so a copy of it credits nobody by name. */
  anonymous: boolean;
  underReview: boolean;
  items: Card[];
  tiers: { label: string; caption?: string | null }[];
  translations?: Translations;
}

export type Publication =
  | { kind: "list"; basedOn: BasedOn | null }
  | { kind: "ranking"; listId: string };

/**
 * Each catalogue address a list's cards were moved from, to the address the
 * card shows now (`attribution.formerUrls`, written by `refreshPictures`): a
 * client that still shows the old one is still showing the same card.
 */
export function currentAddresses(source: readonly unknown[]): Map<string, string> {
  const moved = new Map<string, string>();
  for (const raw of source) {
    const card = (raw ?? {}) as { imageUrl?: unknown; attribution?: { formerUrls?: unknown } };
    const former = card.attribution?.formerUrls;
    if (typeof card.imageUrl !== "string" || !Array.isArray(former)) continue;
    for (const url of former) if (typeof url === "string" && url !== card.imageUrl) moved.set(url, card.imageUrl);
  }
  return moved;
}

/**
 * Both its normalized title and canonical public picture identify a card:
 * a catalogue or outside address and any copy of it count as one picture.
 * Renaming a picture card changes the content. Deezer art counts as absent,
 * as publishing drops it. Local identifiers and picture credits do not decide.
 */
export function cardIdentity(card: Card): string {
  // Match settle(): a kept public URL wins when both representations were sent.
  // A picture and our copy of it are one picture, whichever list the copy is in.
  const picture = card.imageUrl && !isDeezerPicture(card.imageUrl) ? pictureKey(card.imageUrl) : card.pictureId ? "owned-picture" : null;
  return JSON.stringify([card.title.replace(/\s+/g, " ").trim(),
    picture]);
}

/** The same cards, each as many times, in any order. Tiers and placing do not count. */
export function sameCards(left: Card[], right: Card[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const card of left) {
    const id = cardIdentity(card);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const card of right) {
    const id = cardIdentity(card);
    const left = counts.get(id);
    if (!left) return false;
    if (left === 1) {
      counts.delete(id);
    } else {
      counts.set(id, left - 1);
    }
  }
  return counts.size === 0;
}

/**
 * The reader's placing of the source's cards, in the source's order: for
 * each of them, the tier the reader gave the same card, or null for one
 * left unranked. Two copies of one card are matched in the order they come.
 */
export function arrangementOver(source: Card[], placed: PlacedCard[]): (number | null)[] {
  const waiting = new Map<string, (number | null)[]>();
  for (const card of placed) {
    const id = cardIdentity(card);
    const queue = waiting.get(id) ?? [];
    queue.push(card.tierIndex);
    waiting.set(id, queue);
  }
  return source.map((card) => waiting.get(cardIdentity(card))?.shift() ?? null);
}

/** A published list's id, or nothing: the same shape Firestore gives out. */
export function readTakenFrom(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export interface PublicationInput {
  takenFrom: string | null;
  /** The list that id named, or null when it names nothing. */
  source: SourceList | null;
  callerUid: string;
  items: Card[];
  title: string;
  tiers: { label: string; caption?: string | null }[];
}

/** One coherent official language version, with the same source positions and pictures. */
export function publicationBaseline(source: SourceList, draft: Pick<PublicationInput, "title" | "tiers" | "items">): SourceList | null {
  const words = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const structure = (rows: PublicationInput["tiers"]) => rows.map((tier) => [words(tier.label), words(tier.caption)]);
  const same = (variant: SourceList) => words(draft.title) === words(variant.title) && JSON.stringify(structure(draft.tiers)) === JSON.stringify(structure(variant.tiers)) && sameCards(draft.items, variant.items);
  if (same(source)) return source;
  if (source.authorUid !== EDITORIAL_UID) return null;
  for (const locale of TRANSLATION_LOCALES) {
    const entries = source.translations?.[locale];
    if (!entries) continue;
    const translated = (text: string, limit: number) => words(Object.hasOwn(entries, text) && typeof entries[text] === "string" ? entries[text] : text).slice(0, limit);
    const variant = { ...source, title: translated(source.title, MAX_TITLE_LENGTH),
      tiers: source.tiers.map((tier) => ({ ...tier, label: translated(tier.label, MAX_TITLE_LENGTH), caption: tier.caption ? translated(tier.caption, MAX_CAPTION_LENGTH) : null })),
      items: source.items.map((card) => ({ ...card, title: translated(card.title, MAX_TITLE_LENGTH) })) };
    if (same(variant)) return variant;
  }
  return null;
}

/**
 * A new publication with identical content is the reader's Ranking. A title,
 * card or meaningful tier-structure change permits a new attributed list.
 * Placement, colors, cover, credit and technical ids are not content changes.
 * Existing published lists are updated without reclassification or migration.
 */
export function decidePublication({ takenFrom, source, callerUid, title, tiers, items }: PublicationInput): Publication {
  if (takenFrom === null || source === null || source.underReview || source.authorUid === callerUid) {
    return { kind: "list", basedOn: null };
  }
  if (publicationBaseline(source, { title, tiers, items }) !== null) {
    return { kind: "ranking", listId: source.id };
  }
  return { kind: "list", basedOn: creditFor(source) };
}

/** Resolve positional identities before writing. Indices distinguish duplicate cards; legacy copies match occurrences. */
export function rankingRowsOver(source: Card[], placed: PlacedCard[], tierCount: number): number[][] | null {
  const used = new Set<number>();
  const positions = new Map<PlacedCard, number>();
  for (const card of placed) {
    if (card.sourceIndex === undefined) continue;
    const at = card.sourceIndex;
    if (!Number.isSafeInteger(at) || at < 0 || at >= source.length || used.has(at) || cardIdentity(card) !== cardIdentity(source[at])) return null;
    used.add(at);
    positions.set(card, at);
  }
  const waiting = new Map<string, number[]>();
  source.forEach((card, at) => {
    if (used.has(at)) return;
    const key = cardIdentity(card);
    const queue = waiting.get(key) ?? [];
    queue.push(at);
    waiting.set(key, queue);
  });
  const rows: number[][] = Array.from({ length: tierCount }, () => []);
  for (const card of placed) {
    const at = positions.get(card) ?? waiting.get(cardIdentity(card))?.shift();
    if (at === undefined) return null;
    if (card.tierIndex !== null) rows[card.tierIndex].push(at);
  }
  return rows;
}

/** The credit a copy gives the list it came from. */
export function creditFor(source: Pick<SourceList, "id" | "title" | "authorUid" | "authorName" | "anonymous">): BasedOn {
  return source.anonymous
    ? { id: source.id, title: source.title, authorUid: "", authorName: "" }
    : { id: source.id, title: source.title, authorUid: source.authorUid, authorName: source.authorName };
}

/** A stored credit as it goes out. One written before the author's uid travelled carries an empty one. */
export function shownCredit(stored: unknown): BasedOn | null {
  if (typeof stored !== "object" || stored === null) return null;
  const credit = stored as Record<string, unknown>;
  if (typeof credit.id !== "string") return null;
  return {
    id: credit.id,
    title: typeof credit.title === "string" ? credit.title : "",
    authorUid: typeof credit.authorUid === "string" ? credit.authorUid : "",
    authorName: typeof credit.authorName === "string" ? credit.authorName : "",
  };
}

/**
 * Whether a copy's credit still says the wrong thing about its original: a
 * name while the original is anonymous, or nobody's while it is not. Asked
 * of every copy on every publish, so a rewrite cut short is finished by the
 * next one.
 */
export function creditNeedsRewrite(credit: Pick<BasedOn, "authorUid">, originalAnonymous: boolean): boolean {
  return originalAnonymous ? credit.authorUid !== "" : credit.authorUid === "";
}

/**
 * A ranking somebody signed in made. The website's visitors rank into the
 * same collection without an account, and those are theirs to show, not the
 * app's rankings sheet.
 */
export function isOwnedRanking(ranking: { uid?: unknown }): boolean {
  return typeof ranking.uid === "string" && ranking.uid.length > 0;
}

export type RankingBody =
  /**
   * `rows` is null for a placing sent the old way, as a tier per card, which
   * keeps no order within a tier. `rows` and `arrangement` are about the
   * list's own cards alone, which is all installed apps read; `allRows`, only
   * when the reader added cards of their own, places those too, at `N+k`.
   */
  | { ok: true; arrangement: (number | null)[]; rows: number[][] | null; tierLabels: string[]; allRows?: number[][] }
  | { ok: false; detail: "tierLabels" | "rows" | "arrangement" };

/**
 * The cards in each tier, left to right, by their place in the list: as many
 * rows as tiers, each card at most once across them all. A card in no row is
 * unranked.
 */
function readRows(value: unknown, tiers: number, itemCount: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== tiers) return null;
  const seen = new Set<number>();
  for (const row of value) {
    if (!Array.isArray(row)) return null;
    for (const item of row) {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item >= itemCount || seen.has(item)) return null;
      seen.add(item);
    }
  }
  return value as number[][];
}

/** The tier each card sits in, by its place in the list, or null for one in no row: what older readers understand. */
export function arrangementFromRows(rows: readonly (readonly number[])[], itemCount: number): (number | null)[] {
  const arrangement: (number | null)[] = new Array(itemCount).fill(null);
  rows.forEach((row, tier) => row.forEach((item) => {
    arrangement[item] = tier;
  }));
  return arrangement;
}

/** The cards of each tier in the list's order, from a tier (or null) per card: the rows a placing without its own order has. */
export function rowsFromArrangement(arrangement: readonly (number | null)[], tiers: number): number[][] {
  const rows: number[][] = Array.from({ length: tiers }, () => []);
  arrangement.forEach((tier, at) => {
    if (tier !== null && tier >= 0 && tier < tiers) rows[tier].push(at);
  });
  return rows;
}

/** Firestore keeps no array inside an array, so each row is stored as `{items}`, as the website stores its own. */
export function rowsToDocument(rows: readonly (readonly number[])[]): { items: number[] }[] {
  return rows.map((row) => ({ items: [...row] }));
}

/** Stored rows read back, or none for a ranking stored without them, whose readers fall back to `arrangement`. */
export function rowsFromDocument(stored: unknown): number[][] {
  if (!Array.isArray(stored)) return [];
  const rows = stored.map((row) => (row as { items?: unknown } | null)?.items);
  if (!rows.every((items) => Array.isArray(items) && items.every((item) => typeof item === "number"))) return [];
  return rows as number[][];
}

/**
 * A reader's placing of a list, as they send it: one to twenty tier labels,
 * each a proper label, and the cards of each tier left to right (`rows`); or,
 * the old way, one tier or null per card in the list's order (`arrangement`),
 * which is still read when there are no rows. Rows win when both are sent.
 * The reader's own [addedCount] cards follow the list's in `rows`, at `N+k`;
 * the old way cannot place them, and leaves them unranked.
 */
export function readRankingBody(body: unknown, itemCount: number, addedCount = 0): RankingBody {
  const source = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(source.tierLabels) || source.tierLabels.length < 1 || source.tierLabels.length > MAX_TIERS_PER_LIST) {
    return { ok: false, detail: "tierLabels" };
  }
  const tierLabels = source.tierLabels.map(cleanTierLabel);
  if (tierLabels.some((label) => label === null)) return { ok: false, detail: "tierLabels" };
  const labels = tierLabels as string[];
  if (source.rows !== undefined && source.rows !== null) {
    const rows = readRows(source.rows, labels.length, itemCount + addedCount);
    if (rows === null) return { ok: false, detail: "rows" };
    const listRows = addedCount === 0 ? rows : rows.map((row) => row.filter((item) => item < itemCount));
    return { ok: true, arrangement: arrangementFromRows(listRows, itemCount), rows: listRows, tierLabels: labels, ...(addedCount > 0 ? { allRows: rows } : {}) };
  }
  if (source.arrangement === undefined || source.arrangement === null) return { ok: false, detail: "rows" };
  if (!Array.isArray(source.arrangement) || source.arrangement.length !== itemCount) {
    return { ok: false, detail: "arrangement" };
  }
  const tiers = labels.length;
  const placed = (entry: unknown) =>
    entry === null || (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < tiers);
  if (!source.arrangement.every(placed)) return { ok: false, detail: "arrangement" };
  const arrangement = source.arrangement as (number | null)[];
  return { ok: true, arrangement, rows: null, tierLabels: labels, ...(addedCount > 0 ? { allRows: rowsFromArrangement(arrangement, tiers) } : {}) };
}

export type RankingRefusal = "not_signed_in" | "banned" | "missing" | "own_list";

export interface RankingCaller {
  uid: string;
  isAnonymous: boolean;
  banned: boolean;
}

/**
 * Who may put their placing of a list in its rankings sheet: somebody signed
 * in and free to publish, on a list that is there for everybody to see, and
 * not its own author, judged by the stored author since an anonymous list
 * names nobody.
 */
export function rankingRefusal(
  caller: RankingCaller,
  list: { authorUid: string; underReview: boolean } | null,
): RankingRefusal | null {
  if (caller.isAnonymous) return "not_signed_in";
  if (caller.banned) return "banned";
  if (list === null || list.underReview) return "missing";
  if (list.authorUid === caller.uid) return "own_list";
  return null;
}

/** Everything a reader's ranking is refused for, asked before anything about it costs a fetch. */
export function rankingPrecheck(
  caller: RankingCaller,
  list: { authorUid: string; underReview: boolean; itemCount: number } | null,
  body: unknown,
  addedCount = 0,
): { ok: true } | { refused: RankingRefusal } | { invalid: string } {
  const refused = rankingRefusal(caller, list);
  if (refused !== null || list === null) return { refused: refused ?? "missing" };
  const read = readRankingBody(body, list.itemCount, addedCount);
  return read.ok ? { ok: true } : { invalid: read.detail };
}

/** What writing a reader's ranking does to the list's count: one more only for a ranking that was not there. */
export function rankingWrite(existed: boolean): { created: boolean; countChange: 0 | 1 } {
  return existed ? { created: false, countChange: 0 } : { created: true, countChange: 1 };
}

export const MAX_ADDED_CARDS = 50;

/**
 * The cards a reader adds to their ranking of somebody's list, as the body of
 * a list of one tier holding just them, so they are read by the very reader a
 * published list's cards are (`decidePublish`): the same names, pictures,
 * links, credits and limits. Where a card goes is the ranking's `rows`, so a
 * card's own tier and source position are not read; nor is an editor's
 * credit, which is the house's alone. Null for no cards; refused for anything
 * but up to fifty of them.
 */
export function addedCardsBody(raw: unknown): { ok: true; body: Record<string, unknown> | null; count: number } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, body: null, count: 0 };
  if (!Array.isArray(raw) || raw.length > MAX_ADDED_CARDS) return { ok: false };
  if (raw.length === 0) return { ok: true, body: null, count: 0 };
  const items: Record<string, unknown>[] = [];
  for (const card of raw) {
    if (card === null || typeof card !== "object" || Array.isArray(card)) return { ok: false };
    const { tierIndex: _tier, sourceIndex: _source, attribution, ...rest } = card as Record<string, unknown>;
    const sent = attribution !== null && typeof attribution === "object" && !Array.isArray(attribution)
      ? Object.fromEntries(Object.entries(attribution as Record<string, unknown>).filter(([key]) => key !== "manual"))
      : null;
    items.push({ ...rest, ...(sent === null ? {} : { attribution: sent }), tierIndex: null });
  }
  return {
    ok: true,
    body: { title: "Added cards", category: "other", tiers: [{ label: "Added", colorLight: "#000000", colorDark: "#000000" }], items },
    count: items.length,
  };
}

/**
 * A new list made from somebody else's with other content is not published
 * as a list of its own: the reader shows their ranking of that list instead,
 * with any cards they added. The id of that list, or null when this may go out.
 */
export function rankInstead(publication: Publication): string | null {
  return publication.kind === "list" && publication.basedOn !== null ? publication.basedOn.id : null;
}
