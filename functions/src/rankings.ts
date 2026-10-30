/**
 * A ranking of somebody else's list. Taking a list and publishing it again
 * with the same cards is not a second list: it is this reader's placing of
 * the author's cards, kept beside the original and counted on it. Pure, like
 * the rest of the deciding here; `community.ts` does the reads and writes.
 */

import { cleanTierLabel, MAX_TIERS_PER_LIST } from "./publishing";

export const RANKINGS_PAGE_SIZE = 30;

/** A card as the deciding here needs to see it: a name and, maybe, a picture. */
export interface Card {
  title: string;
  imageUrl: string | null;
}

/** A card with where its owner put it. */
export interface PlacedCard extends Card {
  tierIndex: number | null;
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
}

export type Publication =
  | { kind: "list"; basedOn: BasedOn | null }
  | { kind: "ranking"; listId: string };

/**
 * What makes a card the same card on two boards: its picture, when it has
 * one, and otherwise its name, read loosely. A poster is a poster whatever
 * caption sits under it; a card typed by hand is its words.
 */
export function cardIdentity(card: Card): string {
  if (card.imageUrl) return `picture:${card.imageUrl}`;
  return `title:${card.title.replace(/\s+/g, " ").trim().toLowerCase()}`;
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
}

/**
 * A copy is always a list of its own, named after the one it came from, even
 * with the very same cards: two people can share a taste to the letter, and
 * those who follow the second one should still see it (Danylo, 27.10). A
 * source that is gone or under review, or the author's own, credits nobody.
 * Rankings written before this stay readable on their lists.
 */
export function decidePublication({ takenFrom, source, callerUid }: PublicationInput): Publication {
  if (takenFrom === null || source === null || source.underReview || source.authorUid === callerUid) {
    return { kind: "list", basedOn: null };
  }
  return { kind: "list", basedOn: creditFor(source) };
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

/** The reader's own ranking ahead of everyone's, flagged, the rest as they came. */
export function mineFirst<T extends { uid: string }>(rankings: T[], uid: string): (T & { mine: boolean })[] {
  const mine = rankings.filter((one) => one.uid === uid).map((one) => ({ ...one, mine: true }));
  const others = rankings.filter((one) => one.uid !== uid).map((one) => ({ ...one, mine: false }));
  return [...mine, ...others];
}

export type RankingBody =
  /** `rows` is null for a placing sent the old way, as a tier per card, which keeps no order within a tier. */
  | { ok: true; arrangement: (number | null)[]; rows: number[][] | null; tierLabels: string[] }
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
 */
export function readRankingBody(body: unknown, itemCount: number): RankingBody {
  const source = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(source.tierLabels) || source.tierLabels.length < 1 || source.tierLabels.length > MAX_TIERS_PER_LIST) {
    return { ok: false, detail: "tierLabels" };
  }
  const tierLabels = source.tierLabels.map(cleanTierLabel);
  if (tierLabels.some((label) => label === null)) return { ok: false, detail: "tierLabels" };
  if (source.rows !== undefined && source.rows !== null) {
    const rows = readRows(source.rows, tierLabels.length, itemCount);
    if (rows === null) return { ok: false, detail: "rows" };
    return { ok: true, arrangement: arrangementFromRows(rows, itemCount), rows, tierLabels: tierLabels as string[] };
  }
  if (source.arrangement === undefined || source.arrangement === null) return { ok: false, detail: "rows" };
  if (!Array.isArray(source.arrangement) || source.arrangement.length !== itemCount) {
    return { ok: false, detail: "arrangement" };
  }
  const tiers = tierLabels.length;
  const placed = (entry: unknown) =>
    entry === null || (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < tiers);
  if (!source.arrangement.every(placed)) return { ok: false, detail: "arrangement" };
  return { ok: true, arrangement: source.arrangement as (number | null)[], rows: null, tierLabels: tierLabels as string[] };
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

/** What writing a reader's ranking does to the list's count: one more only for a ranking that was not there. */
export function rankingWrite(existed: boolean): { created: boolean; countChange: 0 | 1 } {
  return existed ? { created: false, countChange: 0 } : { created: true, countChange: 1 };
}
