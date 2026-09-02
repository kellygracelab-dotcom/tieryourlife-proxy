/**
 * What to ask IGDB for a game, and what to keep of the answer. Pure, like
 * `quota.ts` and `safety.ts`: `games.ts` holds the token and the fetching,
 * this file only decides the question and reads the reply.
 *
 * Games are the one thing the catalogues behind this app could never show. A
 * cover belongs to whoever published the game, so Wikimedia Commons will not
 * hold one, and TMDB is films. IGDB has both the names and the covers, and
 * gives them away -- for a commercial project through their partnership, and
 * still at no charge.
 */

/** Their query language wants one statement per line, each ended with a `;`. */
export const IGDB_GAMES_ENDPOINT = "https://api.igdb.com/v4/games";

/**
 * A page of results, matching what the feed shows. Twenty is what the app
 * already asks TMDB for, so a search reads the same however it was answered.
 */
export const RESULT_LIMIT = 20;

/**
 * Bundles, packs and season passes carry the name of the game they contain,
 * so a search for one real game comes back four times over. These are IGDB's
 * numbers for the kinds worth ranking: a game, a remake, a remaster, an
 * expanded edition, a port, and a standalone expansion.
 */
export const RANKABLE_CATEGORIES = [0, 8, 9, 10, 11, 4] as const;

/** The size their own site uses for a cover. Twice that on a dense screen. */
const COVER_SIZE = "t_cover_big";

export interface IgdbGame {
  id: number;
  name?: string;
  first_release_date?: number;
  cover?: { image_id?: string };
}

export interface CatalogueGame {
  id: number;
  name: string;
  /** The year, or null for something announced but not dated. */
  year: number | null;
  /** An https address, or null when IGDB has no cover for it either. */
  imageUrl: string | null;
}

/**
 * Their search is fuzzy and already ranks by relevance, so the order comes
 * back as it is rather than being sorted again here.
 *
 * Quotes, backslashes and semicolons are stripped rather than escaped: the
 * term is a person's search box, the language has no placeholders, and a name
 * is still findable without its punctuation. A semicolon ends a statement in
 * their language, so it never travels inside one of ours.
 */
export function gamesQuery(term: string, limit: number = RESULT_LIMIT): string {
  const cleaned = term.replace(/["\\;]/g, " ").trim();
  return [
    `search "${cleaned}";`,
    "fields name, first_release_date, cover.image_id;",
    `where category = (${RANKABLE_CATEGORIES.join(",")}) & version_parent = null;`,
    `limit ${Math.max(1, Math.min(limit, RESULT_LIMIT))};`,
  ].join(" ");
}

/** Whether the term is worth a request at all. Matches the app's own floor. */
export function isSearchable(term: string): boolean {
  return term.replace(/["\\;]/g, " ").trim().length >= 2;
}

export function coverUrl(imageId: string | undefined): string | null {
  return imageId ? `https://images.igdb.com/igdb/image/upload/${COVER_SIZE}/${imageId}.jpg` : null;
}

/**
 * Seconds since the epoch, which is how IGDB dates a release. Anything
 * unparseable becomes no year rather than 1970.
 */
export function releaseYear(seconds: number | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }
  const year = new Date(seconds * 1000).getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

/**
 * Everything usable, in the order it arrived.
 *
 * A row with no name is dropped: the card would be a blank the reader could
 * neither recognise nor rank. A row with no cover is kept, because that is
 * the whole reason for asking IGDB in the first place.
 */
export function toCatalogue(games: readonly IgdbGame[]): CatalogueGame[] {
  const seen = new Set<number>();
  const out: CatalogueGame[] = [];
  for (const game of games) {
    const name = game.name?.trim();
    if (!name || seen.has(game.id)) {
      continue;
    }
    seen.add(game.id);
    out.push({
      id: game.id,
      name,
      year: releaseYear(game.first_release_date),
      imageUrl: coverUrl(game.cover?.image_id),
    });
  }
  return out;
}

/**
 * When to ask Twitch for a new token.
 *
 * A minute early, so a token that was valid when the check ran cannot expire
 * between the check and the request it was fetched for.
 */
const RENEW_EARLY_MS = 60_000;

export interface TokenState {
  token: string;
  expiresAtMs: number;
}

export function tokenIsUsable(state: TokenState | null, nowMs: number): state is TokenState {
  return state !== null && state.expiresAtMs - RENEW_EARLY_MS > nowMs;
}

export function tokenFrom(
  reply: { access_token?: unknown; expires_in?: unknown },
  nowMs: number,
): TokenState | null {
  const token = typeof reply.access_token === "string" ? reply.access_token.trim() : "";
  const seconds = typeof reply.expires_in === "number" ? reply.expires_in : 0;
  if (!token || seconds <= 0) {
    return null;
  }
  return { token, expiresAtMs: nowMs + seconds * 1000 };
}
