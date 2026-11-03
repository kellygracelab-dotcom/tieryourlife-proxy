/**
 * Filling the house lists out: the searches a job asks for, which catalogue
 * hit a planned card takes, and the list as publish would store it with the
 * new cards after the old ones. Pure: the searches run in
 * src/houseFillJobs.ts, the writes in scripts/house-fill.ts.
 */
import { pictureScopeOf, type PictureHit, type PictureKind, type PictureScope } from "./pictureSources";
import {
  MAX_CREDIT_LENGTH,
  MAX_ITEMS_PER_LIST,
  MAX_PREVIEW_IMAGES,
  MAX_SNAPSHOT_BYTES,
  MAX_TITLE_LENGTH,
  tierCountsOf,
  type PublishedItem,
} from "./publishing";
import { fold, wordsOf } from "./search";

export const HOUSE_FILL_JOBS = "houseFillJobs";
export const HOUSE_FILL_UID = "script:house-fill";
export const MAX_JOB_QUERIES = 60;
export const MAX_SPACING_MS = 5_000;
export const HITS_KEPT = 8;

export interface FillQuery {
  typed: string;
  scope: PictureScope;
  /** Games only: IGDB's games of exactly this name, instead of the app's search. */
  exact?: true;
}

/**
 * A job's searches as the script wrote them, at most a job's worth, each in
 * its place: one the app would not run either is null, so the answers still
 * line up with the cards.
 */
export function readJob(raw: unknown): { queries: (FillQuery | null)[]; spacingMs: number } {
  const job = (raw ?? {}) as { queries?: unknown; spacingMs?: unknown };
  const queries = (Array.isArray(job.queries) ? job.queries : []).map((one): FillQuery | null => {
    const { typed, scope, exact } = (one ?? {}) as { typed?: unknown; scope?: unknown; exact?: unknown };
    if (typeof typed !== "string" || [...typed.trim()].length < 2) return null;
    const query: FillQuery = { typed: typed.trim().slice(0, 100), scope: pictureScopeOf(scope) };
    return exact === true && query.scope === "games" ? { ...query, exact: true } : query;
  });
  const spacing = typeof job.spacingMs === "number" && Number.isFinite(job.spacingMs) ? job.spacingMs : 0;
  return { queries: queries.slice(0, MAX_JOB_QUERIES), spacingMs: Math.min(MAX_SPACING_MS, Math.max(0, spacing)) };
}

export interface PlannedCard {
  title: string;
  /** What is searched for; the title when absent. */
  typed?: string;
  scope: PictureScope;
  kind: PictureKind;
  /** The catalogue's own name for it when that differs from the title; empty to go by the subtitle alone. */
  name?: string;
  /** How the catalogue's subtitle starts: a year, a Latin name, the series a character is from. */
  subtitle?: string;
  /** The hit's own id (`steam:70`) when it is known: then nothing else needs to agree. */
  id?: string;
  /** Games only: see [FillQuery.exact]. */
  exact?: true;
}

export function sameName(left: string, right: string): boolean {
  return wordsOf(left).join(" ") === wordsOf(right).join(" ");
}

/** The first hit that is surely this card: its kind, its name, its subtitle. None is better than a near one. */
export function pickHit(card: PlannedCard, hits: readonly PictureHit[]): PictureHit | null {
  if (card.id !== undefined) return hits.find((hit) => hit.id === card.id && hit.kind === card.kind) ?? null;
  const name = card.name ?? card.title;
  return hits.find((hit) =>
    hit.kind === card.kind &&
    (name === "" || sameName(hit.title, name)) &&
    (card.subtitle === undefined || fold(hit.subtitle ?? "").startsWith(fold(card.subtitle))),
  ) ?? null;
}

/** A card as publish stores one: cleaned the way it cleans them, unranked, with its picture's credit. */
export function cardOf(title: string, hit: PictureHit): PublishedItem {
  const credit = hit.credit?.replace(/\s+/g, " ").trim().slice(0, MAX_CREDIT_LENGTH);
  return {
    title: title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH),
    imageUrl: hit.imageUrl,
    tierIndex: null,
    ...(credit ? { credit } : {}),
  };
}

export interface HouseList {
  tiers: unknown[];
  items: PublishedItem[];
  previewImages?: string[];
}

export type Extension =
  | {
      ok: true;
      fields: { items: PublishedItem[]; itemCount: number; previewImages: string[]; tierCounts: number[] };
      added: PublishedItem[];
      /** Titles left out because the list already shows that thing or that picture. */
      duplicates: string[];
    }
  | { ok: false; detail: string };

function cardArt(items: readonly PublishedItem[]): string[] {
  return items.map((item) => item.imageUrl).filter((url): url is string => url !== null).slice(0, MAX_PREVIEW_IMAGES);
}

/**
 * The old cards as they are and in their order, then each new one the list
 * does not already show. The collage follows the cards' art, as publish
 * derives it, unless the house chose its own.
 */
export function extendList(list: HouseList, cards: readonly PublishedItem[]): Extension {
  const items = [...list.items];
  const added: PublishedItem[] = [];
  const duplicates: string[] = [];
  for (const card of cards) {
    const shown = items.some((item) => sameName(item.title, card.title) || (card.imageUrl !== null && item.imageUrl === card.imageUrl));
    if (shown) {
      duplicates.push(card.title);
      continue;
    }
    items.push(card);
    added.push(card);
  }
  if (items.length > MAX_ITEMS_PER_LIST) return { ok: false, detail: "Too many items" };
  const previous = list.previewImages ?? [];
  const derived = JSON.stringify(previous) === JSON.stringify(cardArt(list.items));
  const previewImages = derived ? cardArt(items) : previous;
  const fields = { items, itemCount: items.length, previewImages, tierCounts: tierCountsOf(list.tiers.length, items) };
  if (JSON.stringify({ ...list, ...fields }).length > MAX_SNAPSHOT_BYTES) return { ok: false, detail: "The list is too heavy to store" };
  return { ok: true, fields, added, duplicates };
}
