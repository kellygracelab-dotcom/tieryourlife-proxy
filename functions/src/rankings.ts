/**
 * A ranking of somebody else's list. Taking a list and publishing it again
 * with the same cards is not a second list: it is this reader's placing of
 * the author's cards, kept beside the original and counted on it. Pure, like
 * the rest of the deciding here; `community.ts` does the reads and writes.
 */

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

export interface BasedOn {
  id: string;
  title: string;
  authorName: string;
}

/** The list a board was saved from, as much of it as the decision needs. */
export interface SourceList {
  id: string;
  authorUid: string;
  title: string;
  authorName: string;
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
 * Whether a publication is a list of its own or a ranking of the one it was
 * taken from. A source that is gone or under review decides nothing, and the
 * author of a list cannot rank their own.
 */
export function decidePublication({ takenFrom, source, callerUid, items }: PublicationInput): Publication {
  if (takenFrom === null || source === null || source.underReview || source.authorUid === callerUid) {
    return { kind: "list", basedOn: null };
  }
  if (sameCards(source.items, items)) {
    return { kind: "ranking", listId: source.id };
  }
  return { kind: "list", basedOn: { id: source.id, title: source.title, authorName: source.authorName } };
}

/** The reader's own ranking ahead of everyone's, flagged, the rest as they came. */
export function mineFirst<T extends { uid: string }>(rankings: T[], uid: string): (T & { mine: boolean })[] {
  const mine = rankings.filter((one) => one.uid === uid).map((one) => ({ ...one, mine: true }));
  const others = rankings.filter((one) => one.uid !== uid).map((one) => ({ ...one, mine: false }));
  return [...mine, ...others];
}
