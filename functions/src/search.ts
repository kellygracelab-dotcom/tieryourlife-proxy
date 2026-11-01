/**
 * Search by words rather than by the start of a title. A list or a topic
 * stores `searchKeys`: every word of its name, of its name in the app's other
 * languages once those are known, and every start of each of those words, all
 * folded the same way. A search asks for one typed word with `array-contains`
 * and keeps what holds every other typed word too. Pure: the I/O is elsewhere.
 */

/** Keys made from the name alone. The sweep (src/sweepSearch.ts) raises it once the translations are in. */
export const SEARCH_WORDS_ONLY = 0;
export const SEARCH_TRANSLATED = 1;

/** The languages the app speaks; a name is looked for in all of them. */
export const SEARCH_LANGUAGES = ["en", "ru", "uk", "de", "es", "fr", "ja", "pl", "pt-BR", "tr", "ar"] as const;

/** A word longer than this is looked for by its first this many letters. */
const MAX_KEY_LENGTH = 20;
/** Far above what eleven translations of a title make; a guard, not a budget. */
const MAX_KEYS = 1500;

/**
 * Lower case, with accents and marks gone, so ё is е and é is e on both sides
 * of a search. Й stays: it is a letter of its own, not и with a mark.
 */
export function fold(text: string): string {
  return [...text.toLowerCase()].map((char) => (char === "й" ? char : char.normalize("NFKD").replace(/\p{M}+/gu, ""))).join("");
}

/** The words of a text, folded; anything not a letter or a digit separates them. */
export function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => [...word].slice(0, MAX_KEY_LENGTH).join(""));
}

/** Every word of every text, and every start of each. */
export function searchKeysFor(texts: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const word of wordsOf(text)) {
      const letters = [...word];
      for (let end = 1; end <= letters.length; end++) keys.add(letters.slice(0, end).join(""));
    }
  }
  return [...keys].slice(0, MAX_KEYS);
}

/** What a document stores for its names, before the sweep has translated them. */
export function searchFieldsFor(texts: readonly string[]): { searchKeys: string[]; searchVersion: number } {
  return { searchKeys: searchKeysFor(texts), searchVersion: SEARCH_WORDS_ONLY };
}

/** What was typed, as the words to look for; null when there are none. */
export interface SearchQuery {
  /** The one word asked of Firestore: the longest, so the fewest documents come back. */
  key: string;
  words: string[];
}

export function searchQueryOf(typed: string | null): SearchQuery | null {
  if (typed === null) return null;
  const words = [...new Set(wordsOf(typed))];
  if (words.length === 0) return null;
  const key = words.reduce((longest, word) => ([...word].length > [...longest].length ? word : longest));
  return { key, words };
}

/** Whether a document's keys hold every typed word. */
export function matchesSearch(keys: unknown, query: SearchQuery): boolean {
  if (!Array.isArray(keys)) return false;
  const held = new Set(keys);
  return query.words.every((word) => held.has(word));
}

/** The prompt that asks for a batch of names in every language; the answer is one array per name. */
export function translationPrompt(names: readonly string[]): string {
  return [
    "You translate titles of tier lists and topics for a search index.",
    `For each title below, give how people would write it in each of these languages: ${SEARCH_LANGUAGES.join(", ")}.`,
    "Use the official or commonly used localized name for films, games, books, shows, brands and people when there is one",
    "(for example 'Star Wars' is 'Звёздные войны' in Russian); otherwise translate the meaning, or transliterate a proper name.",
    "Answer with JSON only: an array with one entry per title, in the same order, each entry an array of strings",
    "(the title in each language, duplicates allowed).",
    "",
    JSON.stringify(names),
  ].join("\n");
}

/**
 * The model's answer, as one list of names per title asked about; null when it
 * is not the shape asked for. Every name is a string and short, so nothing
 * odd lands in an index.
 */
export function parseTranslations(text: string, count: number): string[][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  return parsed.map((entry) =>
    Array.isArray(entry)
      ? entry.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 200)
      : [],
  );
}

/** A query nothing answered, as it is kept: folded, trimmed, short. Null when it is not worth keeping. */
export function missOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const folded = wordsOf(raw).join(" ").slice(0, 60);
  return [...folded].length >= 2 ? folded : null;
}
