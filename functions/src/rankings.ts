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
