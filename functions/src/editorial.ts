/**
 * Lists the house publishes: always anonymous, stored under an author id no
 * Auth account can hold, so they belong to nobody's account, outlive any of
 * them and never show who wrote them, and only they carry translations.
 * Pure: `community.ts` does the I/O.
 */
import type { Identity } from "./auth";
import { SEARCH_LANGUAGES, SEARCH_WORDS_ONLY, searchKeysFor } from "./search";

/** Not a Firebase uid (those are 28 characters with no hyphen), so no sign-in can become it. */
export const EDITORIAL_UID = "tyl-editorial";

export type StaffRole = "owner" | "moderator";

/** Who a list is stored under: the person publishing, or the house. */
export interface Byline {
  uid: string;
  name: string;
  photoUrl: string | null;
  /** Set only for the house: the role of whoever speaks for it, for the audit log. */
  speaker: StaffRole | null;
}

export function bylineOf(identity: Identity): Byline {
  return { uid: identity.uid, name: identity.name ?? "Anonymous", photoUrl: identity.picture, speaker: null };
}

export function editorialByline(speaker: StaffRole): Byline {
  return { uid: EDITORIAL_UID, name: "", photoUrl: null, speaker };
}

/** The owner and the moderators speak for the house; anybody else is turned away. */
export function decideEditorialAccess(role: StaffRole | null): { ok: true; speaker: StaffRole } | { ok: false } {
  return role === null ? { ok: false } : { ok: true, speaker: role };
}

/**
 * A house list in the reader's language: per locale, each text of the list
 * as written mapped to how it reads there. Keyed by the text itself, so a
 * reader shows `translations[locale]?.[text] ?? text`; keys can hold dots,
 * so the field is only ever written whole.
 */
export type Translations = Record<string, Record<string, string>>;

export const TRANSLATION_LOCALES: readonly string[] = SEARCH_LANGUAGES.filter((locale) => locale !== "en");
export const MAX_TRANSLATIONS_PER_LOCALE = 2000;
export const MAX_TRANSLATION_LENGTH = 200;
/** Firestore holds a mebibyte a document; the list itself takes the rest. */
const MAX_DOCUMENT_BYTES = 1_000_000;

interface TranslatableList {
  title: string;
  tiers?: unknown[];
  items?: unknown[];
}

/** The texts a list shows: its title, tier labels and captions, card titles. */
export function translatableStrings(list: TranslatableList): Set<string> {
  const texts = [list.title];
  for (const tier of list.tiers ?? []) {
    const { label, caption } = (tier ?? {}) as { label?: unknown; caption?: unknown };
    texts.push(label as string, caption as string);
  }
  for (const item of list.items ?? []) texts.push((item as { title?: unknown } | null)?.title as string);
  // Firestore keeps no empty field names, nor ones like __this__.
  return new Set(texts.filter((text) => typeof text === "string" && text.length > 0 && !/^__.*__$/.test(text)));
}

/** Only what the list still shows, and only translations that say something; anything malformed goes. */
export function pruneTranslations(stored: unknown, strings: ReadonlySet<string>): { translations: Translations; dropped: number } {
  const translations: Translations = {};
  let dropped = 0;
  for (const [locale, entries] of Object.entries(isPlainObject(stored) ? stored : {})) {
    if (!TRANSLATION_LOCALES.includes(locale) || !isPlainObject(entries)) continue;
    const kept = Object.entries(entries).filter(([source, text]) => {
      const keep = strings.has(source) && typeof text === "string" && text.trim().length > 0;
      if (!keep) dropped++;
      return keep;
    });
    if (kept.length > 0) translations[locale] = Object.fromEntries(kept.map(([source, text]) => [source, (text as string).trim()]));
  }
  return { translations, dropped };
}

export type TranslationsDecision =
  | { ok: true; translations: Translations; dropped: number }
  | { ok: false; status: 400 | 413; detail: string };

/** What a PUT of a house list's translations stores, or why it stores nothing. */
export function decideTranslations(input: { raw: unknown; strings: ReadonlySet<string>; listBytes: number }): TranslationsDecision {
  const { raw, strings, listBytes } = input;
  if (!isPlainObject(raw)) return { ok: false, status: 400, detail: "translations" };
  for (const [locale, entries] of Object.entries(raw)) {
    if (!TRANSLATION_LOCALES.includes(locale)) return { ok: false, status: 400, detail: `locale:${locale}` };
    if (!isPlainObject(entries)) return { ok: false, status: 400, detail: `translations.${locale}` };
    const pairs = Object.entries(entries);
    if (pairs.length > MAX_TRANSLATIONS_PER_LOCALE) return { ok: false, status: 400, detail: `too_many:${locale}` };
    for (const [source, text] of pairs) {
      if (typeof text !== "string") return { ok: false, status: 400, detail: `not_text:${locale}` };
      if (source.length > MAX_TRANSLATION_LENGTH || text.length > MAX_TRANSLATION_LENGTH) {
        return { ok: false, status: 400, detail: `too_long:${locale}` };
      }
    }
  }
  const pruned = pruneTranslations(raw, strings);
  if (listBytes + Buffer.byteLength(JSON.stringify(pruned.translations)) > MAX_DOCUMENT_BYTES) {
    return { ok: false, status: 413, detail: "translations" };
  }
  return { ok: true, ...pruned };
}

/** The title in every language it has been translated into, as topics and sections carry `names`. */
export function titleNames(title: string, translations: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  if (!isPlainObject(translations)) return names;
  for (const locale of TRANSLATION_LOCALES) {
    const entries = translations[locale];
    const name = isPlainObject(entries) && Object.hasOwn(entries, title) ? entries[title] : undefined;
    if (typeof name === "string" && name.length > 0) names[locale] = name;
  }
  return names;
}

/**
 * Search keys straight after the house names a title: its own words and every
 * name it was given. The sweep still runs, even with every language named: a
 * name can keep a word in Latin letters (ru «Студия Ghibli»), and only the
 * sweep adds how people spell it (Гибли). It keeps these names as it does.
 */
export function searchAfterTranslations(title: string, names: Record<string, string>): { searchKeys: string[]; searchVersion: number } {
  return { searchKeys: searchKeysFor([title, ...Object.values(names)]), searchVersion: SEARCH_WORDS_ONLY };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
