import { CATEGORIES, type Category } from "./publishing";

/**
 * The nine places Community opens on. They are the categories a list is
 * published under, in the order the app draws its tiles.
 */
export const SECTION_IDS: readonly Category[] = CATEGORIES;

/** How many pictures a section's header collage takes, and how many it needs before it is drawn at all. */
export const COLLAGE_SIZE = 4;

/** A list's pictures speak for a section only once enough people have ranked it themselves. */
export const COLLAGE_MIN_RANKINGS = 5;

/** How far back "new this week" looks. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the counts are kept before they are read again. */
export const SECTION_STATS_TTL_MS = 10 * 60 * 1000;

export function isSectionId(value: unknown): value is Category {
  return typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);
}

/** Deterministic, like a topic follow: following twice writes the same document. */
export function sectionFollowId(uid: string, section: Category): string {
  return `${uid}_${section}`;
}

export interface CollageCandidate {
  id: string;
  rankingCount: number;
  underReview: boolean;
  coverImageUrl: string | null;
  previewImages: string[];
}

/** The picture a list lends a collage: its own cover when it is on the web, otherwise its first card's. */
export function collageImage(list: Pick<CollageCandidate, "coverImageUrl" | "previewImages">): string | null {
  if (list.coverImageUrl && list.coverImageUrl.startsWith("https://")) {
    return list.coverImageUrl;
  }
  return list.previewImages.find((url) => url.startsWith("https://")) ?? null;
}

/**
 * The header collage of a section: pictures of its most taken lists, in the
 * order given, from lists enough people ranked, nothing under review or with a
 * complaint still open, never the same picture twice. Fewer than four found
 * draws nothing: the app shows its own art rather than a gap-toothed grid.
 */
export function pickCollage(
  candidates: CollageCandidate[],
  reported: ReadonlySet<string>,
  size: number = COLLAGE_SIZE,
  minRankings: number = COLLAGE_MIN_RANKINGS,
): string[] {
  const picked: string[] = [];
  for (const list of candidates) {
    if (list.underReview || reported.has(list.id) || list.rankingCount < minRankings) continue;
    const image = collageImage(list);
    if (image === null || picked.includes(image)) continue;
    picked.push(image);
    if (picked.length === size) return picked;
  }
  return [];
}

export interface SectionStats {
  id: Category;
  listCount: number;
  followerCount: number;
  newThisWeek: number;
  collage: string[];
}

/** What one reader is told: the shared counts, and whether they follow each section. */
export function withFollowing(stats: SectionStats[], followed: ReadonlySet<string>) {
  return stats.map((one) => ({ ...one, following: followed.has(one.id) }));
}

/** A count that cannot go below nothing, whatever two reads taken a moment apart say. */
export function countWithout(all: number, excluded: number): number {
  return Math.max(0, all - excluded);
}

/**
 * The sections a following feed reads from: all that are followed, or, when
 * the feed is narrowed to one section, that one if it is followed.
 */
export function followedSectionRun(followed: Category[], narrowedTo: Category | null): Category[] {
  if (narrowedTo === null) return followed;
  return followed.includes(narrowedTo) ? [narrowedTo] : [];
}

/**
 * One value kept for a while and read again once it is old. Callers asking at
 * the same moment share one read; a read that fails leaves nothing behind, so
 * the next caller tries again rather than being handed the failure for ten minutes.
 */
export class TimedCache<T> {
  private value: T | null = null;
  private readAt = 0;
  private reading: Promise<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.value !== null && this.now() - this.readAt < this.ttlMs) {
      return this.value;
    }
    if (this.reading) {
      return this.reading;
    }
    this.reading = load()
      .then((fresh) => {
        this.value = fresh;
        this.readAt = this.now();
        return fresh;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
}
