/**
 * Picture search, stage 1 (QA `qa-picture-search-2026-11-18`, IDEAL-SEARCH.md): what the list a name is
 * looked up for wants, how sure the server is of each hit, and the second attempt when the name as typed
 * found nothing like it. Pure: `pictureSearch.ts` does the asking.
 */
import { fold } from "./search";
import { matchScore, OWN_KINDS, scopeRank, type PictureHit, type PictureScope } from "./pictureSources";

/** What a list wants: a catalogue scope's own kind, a kind of thing Wikidata's descriptions tell, or anything. */
export type Want =
  | { kind: "scope"; scope: PictureScope }
  | { kind: "type"; type: ThingType }
  | { kind: "general" };

export type ThingType = "food" | "sport" | "cars" | "places" | "plants" | "brands";

/** The catalogue sections a list's `section` can name, and the kind each one's own catalogue shows. */
const CATALOGUE_SECTIONS: Record<string, PictureScope> = {
  film_tv: "film_tv",
  anime: "anime",
  games: "games",
  music: "music",
  books: "books",
  people: "people",
  animals: "animals",
};

/** Built-in sections without a catalogue, by what they hold. */
const TYPE_SECTIONS: Record<string, ThingType> = { food: "food", sport: "sport" };

/** A section or topic id as clients send it: anything else is no id. */
export function cleanId(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/**
 * What a built-in section wants, or undefined for a section of somebody's own, whose names have to be
 * read. No section at all is null: the order stays as it was before sections were sent.
 */
export function builtInWant(section: string | null): Want | null | undefined {
  if (section === null) return null;
  const scope = CATALOGUE_SECTIONS[section];
  if (scope) return { kind: "scope", scope };
  const type = TYPE_SECTIONS[section];
  if (type) return { kind: "type", type };
  if (section === "other") return { kind: "general" };
  return undefined;
}

/** Words in a section's or topic's names that tell what its lists hold, in the app's languages. */
const NAME_WORDS: readonly [ThingType, RegExp][] = [
  ["cars", /\b(cars?|autos?|automobiles?|vehicles?|supercars?|motorcycles?|coches?|carros?|voitures?|samochody|samoch[oó]d|arabalar|araba)\b|машин|автомоб|авто\b|車|自動車|سيار/iu],
  ["plants", /\b(plants?|flowers?|trees?|gardens?|garden|houseplants?|plantas?|fleurs?|pflanzen|blumen|ro[sś]liny|kwiaty|bitkiler|[çc]i[çc]ekler)\b|растен|рослин|цвет[ыо]|квіт|植物|花|نبات|زهور/iu],
  ["places", /\b(places?|cit(y|ies)|towns?|countr(y|ies)|capitals?|travel|landmarks?|mountains?|islands?|lakes?|rivers?|wonders?|ciudades|cidades|villes|st[äa]dte|miasta|[şs]ehirler|ülkeler)\b|город|місто|міста|стран|країн|столиц|гор[ыи]\b|都市|国|مدن|دول/iu],
  ["brands", /\b(brands?|logos?|compan(y|ies)|corporations?|marcas|marques|marken|firmy|markalar)\b|бренд|компан|логотип|ブランド|企業|علامات|شركات/iu],
  ["sport", /\b(clubs?|teams?|football|soccer|nba|nfl|nhl|f1|formula|sports?|athletes?|clubes|équipes|vereine|kluby|tak[ıi]mlar)\b|клуб|команд|футбол|спорт|クラブ|チーム|أندية|فرق/iu],
  ["food", /\b(food|foods|dish(es)?|drinks?|fruits?|desserts?|cuisine|snacks?|sweets|comida|platos|pratos|plats|essen|gerichte|jedzenie|potrawy|yemek)\b|еда|їжа|блюд|страв|напит|напо|фрукт|десерт|料理|食べ物|طعام|أطباق/iu],
];

/** What a section's or topic's names say its lists hold, or null when they say nothing this knows. */
export function typeOfNames(names: readonly string[]): ThingType | null {
  const text = names.join(" \n ");
  for (const [type, words] of NAME_WORDS) if (words.test(text)) return type;
  return null;
}

/**
 * Words in an item's English description that make it the kind a list of that type holds. Whole words,
 * a plural allowed; checked on the English description, which nearly every item has.
 */
const THING_WORDS: Record<ThingType, RegExp> = {
  food: /\b(dish|food|foodstuff|cuisine|soup|stew|drink|beverage|fruit|vegetable|dessert|cake|pastry|pastries|bread|cheese|sauce|dumpling|noodle|pasta|salad|snack|sweet|confection(ery)?|candy|chocolate|coffee|tea|wine|beer|liquor|cocktail|spice|meat|sausage|sandwich|pie|rice|porridge|pancake|cookie|biscuit|custard|ice cream|seafood|berry|berries|nut|condiment|kebab|viennoiserie|delicacy|staple)s?\b/i,
  sport: /\b(club|team|football|soccer|basketball|baseball|ice hockey|hockey|rugby|cricket|tennis|athlete|sportsperson|footballer|player|racing|formula one|sport|league|stadium|olympic|boxer|wrestler|cyclist|skier|swimmer|golfer|franchise)s?\b/i,
  cars: /\b(automobile|car|vehicle|automaker|automotive|marque|sports car|supercar|truck|motorcycle|suv|sedan|saloon|hatchback|coupe|coupé|roadster|minivan|pickup)s?\b/i,
  places: /\b(city|cities|capital|town|village|municipality|commune|country|countries|state|province|region|island|mountain|peak|volcano|river|lake|sea|ocean|waterfall|falls|canyon|gorge|valley|desert|forest|national park|park|landmark|tower|skyscraper|building|monument|statue|sculpture|church|cathedral|basilica|temple|mosque|shrine|castle|palace|fortress|bridge|museum|square|archaeological site|citadel|amphitheatre|amphitheater|ruins|beach|bay|metropolis|megacity|commune)s?\b/i,
  plants: /\b(plant|flower|flowering|tree|shrub|genus of plants|species of plant|grass|herb|cactus|cacti|succulent|fern|moss|cultivar|vine|conifer)s?\b/i,
  brands: /\b(company|companies|corporation|brand|manufacturer|business|enterprise|conglomerate|retailer|chain|multinational|firm|subsidiary|automaker|maker|producer|retail|franchise)s?\b/i,
};

/** Wikidata items that are a page about a name, not a thing: last wherever a section is known. */
const NOT_A_THING = /\b(disambiguation|given name|family name|surname|male given name|female given name|wikimedia (list|category|template)|name of)\b/i;

/** A hit's own description in English, kept beside it while it is ranked and never sent. */
export type Described = PictureHit & { about?: string };

/** Whether a hit is the kind of thing a list of [type] holds. */
export function fitsType(hit: Described, type: ThingType): boolean {
  if (hit.source === "inaturalist") return type === "plants" ? hit.kind === "plant" : false;
  if (hit.source !== "wikidata") return false;
  const about = hit.about ?? "";
  return about.length > 0 && !NOT_A_THING.test(about) && THING_WORDS[type].test(about);
}

/**
 * Where a hit stands for what the list wants, lower first. Without a section, the scope's own kind first
 * (stage 0). A section of a kind: Wikidata's things of that kind, its other things, the catalogues', a
 * name's page last. Anything (`other`): Wikidata's things, the catalogues', a name's page last.
 */
export function wantRank(hit: Described, scope: PictureScope, want: Want | null): number {
  if (want === null) return scopeRank(hit, scope);
  if (want.kind === "scope") return scopeRank(hit, want.scope);
  const page = hit.source === "wikidata" && NOT_A_THING.test(hit.about ?? "");
  if (page) return 3;
  if (want.kind === "type" && fitsType(hit, want.type)) return 0;
  if (hit.source === "wikidata") return 1;
  return 2;
}

/**
 * How a hit stands among those of its rank: by its title against what was typed, but where the list is
 * of a kind of thing or of anything, Wikidata's things keep the order its search gave them. That order
 * knows which Juventus, which oak and which Everest people mean; titles would put a player whose alias
 * is "Juventus" before Juventus FC, a language coded "oak" before Quercus, and Everest the motorcycle
 * maker before the mountain (measured on QA's 104 names without a catalogue, 18.11.2026).
 */
export function wantScore(hit: Described, want: Want | null, byTitle: number): number {
  return want !== null && want.kind !== "scope" && hit.source === "wikidata" ? 0 : byTitle;
}

/** Whether a hit is the kind the list wants: true, false, or undefined where the list says nothing. */
export function fitsWant(hit: Described, scope: PictureScope, want: Want | null): boolean | undefined {
  if (hit.kind === "web") return false;
  const wanted = want ?? (OWN_KINDS[scope] ? { kind: "scope" as const, scope } : null);
  if (wanted === null || wanted.kind === "general") return undefined;
  if (wanted.kind === "scope") {
    const own = OWN_KINDS[wanted.scope];
    // Music and people take Wikidata's things as their own: a band's photo, a person's portrait.
    if (hit.source === "wikidata" && (wanted.scope === "music" || wanted.scope === "people" || wanted.scope === "animals")) return true;
    return own ? own.includes(hit.kind) : undefined;
  }
  return fitsType(hit, wanted.type);
}

/** The key a [want] adds to the cache: what the server made of `section` and `topic`, not their ids. */
export function wantKey(want: Want | null): string {
  if (want === null) return "";
  return want.kind === "scope" ? `s:${want.scope}` : want.kind === "type" ? `t:${want.type}` : "g";
}

// Names.

const ARTICLES = new Set(["the", "a", "an", "le", "la", "les", "l", "el", "los", "las", "der", "die", "das", "il", "lo", "gli", "i"]);
const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20",
};

/**
 * A name as two names are compared: no case, accents or punctuation, "&" as "and", without a leading
 * article, Roman numbers as Arabic. "The Matrix" is "Matrix", "Final Fantasy VII" is "Final Fantasy 7".
 */
export function nameKey(name: string): string {
  const words = fold(name).replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length > 1 && ARTICLES.has(words[0]!)) words.shift();
  return words.map((word, at) => (at > 0 || words.length === 1 ? ROMAN[word] ?? word : word)).join(" ");
}

export function sameName(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  const key = nameKey(left);
  return key.length > 0 && key === nameKey(right);
}

/**
 * Whether [name] is [typed], or one is the other's English plural on the last word: "Pancakes" names
 * Wikidata's "pancake", "Tacos" its "taco", "Cherries" its "cherry". Latin letters only, words of 3 letters
 * and more, so "As" is no "A".
 */
export function sameOrPlural(name: string | null | undefined, typed: string): boolean {
  if (!name) return false;
  if (sameName(name, typed)) return true;
  const one = nameKey(name);
  const other = nameKey(typed);
  if (!/^[a-z0-9 ]+$/.test(one) || !/^[a-z0-9 ]+$/.test(other)) return false;
  const [shorter, longer] = one.length <= other.length ? [one, other] : [other, one];
  if (shorter.length < 3) return false;
  return longer === shorter + "s" || longer === shorter + "es" || (shorter.endsWith("y") && longer === shorter.slice(0, -1) + "ies");
}

/** The writing systems a text's letters are in. */
function scriptsOf(text: string): Set<string> {
  const scripts = new Set<string>();
  for (const char of text) {
    if (/\p{Script=Latin}/u.test(char)) scripts.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(char)) scripts.add("cyrillic");
    else if (/\p{Script=Greek}/u.test(char)) scripts.add("greek");
    else if (/\p{Script=Arabic}/u.test(char)) scripts.add("arabic");
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) scripts.add("cjk");
    else if (/\p{Script=Hangul}/u.test(char)) scripts.add("hangul");
    else if (/\p{Script=Hebrew}/u.test(char)) scripts.add("hebrew");
    else if (/\p{L}/u.test(char)) scripts.add("other");
  }
  return scripts;
}

/** Whether [typed] is written in none of the scripts of [names]: a translation, not a near miss. */
export function otherScript(typed: string, names: readonly (string | null | undefined)[]): boolean {
  const mine = scriptsOf(typed);
  if (mine.size === 0) return false;
  const theirs = new Set(names.flatMap((name) => (name ? [...scriptsOf(name)] : [])));
  return theirs.size > 0 && ![...mine].some((script) => theirs.has(script));
}

// How sure.

export type Confidence = "high" | "medium" | "low";
export type Doubt = "namesakes" | "otherName" | "spelling" | "otherKind" | "noSection" | "web";

/** A hit as the answer sends it: the name it was found by, how sure, and why not more. */
export type JudgedHit = PictureHit & { matchedName?: string; confidence?: Confidence; doubts?: Doubt[] };

/**
 * Each hit of a first page, judged in the order the answer shows them (IDEAL-SEARCH.md, "Уверенность").
 * [typed] is what was searched: the second attempt's text when there was one ([retried]). The name a hit
 * was found by goes out as `matchedName` when it is not its title; the hit's alias and description, kept
 * for ranking, are never sent.
 */
export function judgeHits(hits: readonly Described[], typed: string, scope: PictureScope, want: Want | null, retried: boolean, firstPage: boolean): JudgedHit[] {
  const named = hits.map((hit) => ({
    hit,
    title: sameName(hit.title, typed),
    alias: !sameName(hit.title, typed) && sameName(hit.alias, typed),
    close: Math.min(matchScore(hit.title, typed), hit.alias ? matchScore(hit.alias, typed) : 3) < 3,
    fits: fitsWant(hit, scope, want),
  }));
  const ownFirst = named.findIndex((one) => one.fits === true && one.hit.source !== "wikidata" && one.hit.source !== "web");
  return named.map((one, at) => {
    const { hit } = one;
    const { alias: _alias, about: _about, ...sent } = hit;
    const matchedName = one.alias ? hit.alias : undefined;
    const base: JudgedHit = { ...sent, ...(matchedName ? { matchedName } : {}) };
    if (!firstPage) return base;
    const same = one.title || one.alias;
    const doubts: Doubt[] = [];
    let confidence: Confidence;
    // Others by this name: of a fitting kind where the list says what it wants, of any kind where it does not.
    const namesakes = same && named.some((other, index) => index !== at && (other.title || other.alias) && (one.fits === true ? other.fits === true : true));
    if (hit.kind === "web") {
      confidence = "low";
      doubts.push("web");
    } else if (one.fits === false) {
      confidence = "low";
      doubts.push("otherKind");
      if (!same) doubts.push("otherName");
    } else if (same) {
      if (one.fits === undefined) doubts.push("noSection");
      if (namesakes) doubts.push("namesakes");
      confidence = doubts.length === 0 ? "high" : "medium";
    } else if (one.close && one.fits === true) {
      confidence = "medium";
      doubts.push("otherName");
    } else if (at === ownFirst && one.fits === true && otherScript(typed, [hit.title, hit.alias])) {
      // "Крёстный отец" on an English page: the section's own catalogue's first answer, by its English title.
      confidence = "medium";
      doubts.push("otherName");
    } else {
      confidence = "low";
      doubts.push("otherName");
      if (one.fits === undefined) doubts.push("noSection");
    }
    if (retried) {
      doubts.unshift("spelling");
      if (confidence === "high") confidence = "medium";
    }
    return { ...base, confidence, ...(doubts.length > 0 ? { doubts } : {}) };
  });
}

// The second attempt.

export type Retry = "trimmed" | "layout" | "spelling" | "latin";

/**
 * A word after a name that says what kind of thing is meant, and what a list then wants: "борщ блюдо",
 * "Dune film", "лиса животное" (25.11.2026). Cut off and used only by the second attempt, when the text as
 * typed found nothing by that name: "Squid Game" is a title and is found as one.
 */
const HINTS: readonly [Want, string][] = [
  [{ kind: "type", type: "food" }, "блюдо|блюда|еда|рецепт|страва|їжа|dish|food|recipe"],
  [{ kind: "scope", scope: "film_tv" }, "фильм|кино|сериал|фільм|серіал|film|movie|tv\\s+series|tv\\s+show"],
  [{ kind: "scope", scope: "games" }, "игра|видеоигра|гра|відеогра|video\\s*game|game"],
  [{ kind: "scope", scope: "anime" }, "аниме|аніме|anime"],
  [{ kind: "scope", scope: "music" }, "песня|пісня|альбом|группа|гурт|певец|певица|співак|співачка|song|album|band|singer"],
  [{ kind: "scope", scope: "books" }, "книга|роман|book|novel"],
  [{ kind: "scope", scope: "animals" }, "животное|зверь|птица|тварина|звір|птах|animal|bird"],
  [{ kind: "scope", scope: "people" }, "актер|актёр|актриса|актор|акторка|actor|actress"],
];

/** What the kind word at the end of [typed] says a list wants, or null when it ends in none. */
export function hintOf(typed: string): Want | null {
  for (const [want, words] of HINTS) if (new RegExp(`[\\s,.:;!|-]+(?:${words})\\s*$`, "iu").test(typed.trim())) return want;
  return null;
}

/** Words people add to a title that no catalogue holds: "смотреть онлайн", "8 сезон", "full movie"; and a kind word ("блюдо"). */
const TAIL = new RegExp(
  "(?:[\\s,.:;!|-]+|^)(?:" + [
    "watch(?:\\s+online)?(?:\\s+free)?", "online", "free", "full\\s+movie", "full\\s+hd", "hd", "\\d{3,4}p", "4k", "trailer", "download", "torrent",
    "all\\s+seasons", "season\\s*\\d+", "s\\d+e\\d+", "episode\\s*\\d+", "ep\\s*\\d+",
    "смотреть(?:\\s+онлайн)?", "онлайн", "бесплатно", "скачать", "торрент", "в\\s+хорошем\\s+качестве", "все\\s+серии", "все\\s+сезоны",
    "\\d+\\s+сезон", "сезон\\s*\\d+", "\\d+\\s+серия", "серия\\s*\\d+", "дивитис[ья](?:\\s+онлайн)?", "безкоштовно", "завантажити", "\\d+\\s+серія", "серія\\s*\\d+",
    ...HINTS.map(([, words]) => words),
  ].join("|") + ")\\s*$",
  "iu",
);

/** [typed] without the words people add after a title, or null when it has none. */
export function trimmedTail(typed: string): string | null {
  let text = typed.trim();
  for (let round = 0; round < 6; round++) {
    const cut = text.replace(TAIL, "").trim();
    if (cut === text) break;
    text = cut;
  }
  return text !== typed.trim() && [...text].length >= 2 ? text : null;
}

const RU_KEYS = "йцукенгшщзхъфывапролджэячсмитьбю";
const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
/** Ukrainian letters on the keys the Russian layout gives others. */
const UK_EXTRA: Record<string, string> = { і: "s", ї: "]", є: "'", ґ: "`", ё: "`" };

/**
 * [typed] as it was meant on the other keyboard layout: "Ьфекшч" is "Matrix" typed with Cyrillic keys.
 * Cyrillic becomes Latin always; Latin becomes Cyrillic only on a Russian or Ukrainian page, since an
 * English typo is no Russian word. Null when no letter changes or the result has no vowel.
 */
export function otherLayout(typed: string, language: string): string | null {
  const cyrillic = /\p{Script=Cyrillic}/u.test(typed);
  const latin = /\p{Script=Latin}/u.test(typed);
  if (cyrillic === latin) return null;
  let out = "";
  for (const char of typed) {
    const lower = char.toLowerCase();
    const upper = char !== lower;
    let mapped: string | undefined;
    if (cyrillic) {
      const at = RU_KEYS.indexOf(lower);
      mapped = at >= 0 ? EN_KEYS[at] : UK_EXTRA[lower];
    } else {
      const at = EN_KEYS.indexOf(lower);
      mapped = at >= 0 ? RU_KEYS[at] : undefined;
    }
    if (mapped === undefined) {
      if (/\p{L}/u.test(char)) return null;
      out += char;
    } else {
      out += upper ? mapped.toUpperCase() : mapped;
    }
  }
  if (!cyrillic && !["ru", "uk", "be"].includes(language.split("-")[0] ?? "")) return null;
  // Keys that are punctuation on the other layout ("х" is "[") make no letter there: they go.
  const result = out.replace(/[[\];',.`]/g, "").replace(/\s+/g, " ").trim();
  const vowels = cyrillic ? /[aeiouy]/i : /[аеёиоуыэюяіїє]/i;
  return result !== typed.trim() && vowels.test(result) && /\p{L}{2}/u.test(result) ? result : null;
}

/** Cyrillic letters in Latin, as names are written in English: "Лиза" is "Lisa", "Брюс" is "Brus". */
const CYRILLIC_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
};
const CYRILLIC_VOWELS = "аеёиоуыэюяіїє";

/**
 * A name typed in Cyrillic as its Latin original would be written, for a second attempt (26.11.2026,
 * Danylo's "лализа" for Lisa's "LALISA"): letter by letter, and "з" between vowels as "s", as English
 * writes that sound ("Лиза" Lisa, "Роза" Rosa, "Изабелла" Isabella). Null for a text with Latin letters
 * or none in Cyrillic, or one that comes out the same.
 */
export function latinOf(typed: string): string | null {
  const text = typed.trim();
  if (!/\p{Script=Cyrillic}/u.test(text) || /\p{Script=Latin}/u.test(text)) return null;
  const chars = [...text.toLowerCase()];
  let out = "";
  chars.forEach((char, at) => {
    const vowel = (one: string | undefined) => one !== undefined && CYRILLIC_VOWELS.includes(one);
    const vowelAround = vowel(chars[at - 1]) && vowel(chars[at + 1]);
    out += char === "з" && vowelAround ? "s" : CYRILLIC_LATIN[char] ?? char;
  });
  const result = out.replace(/\s+/g, " ").trim();
  return /[a-z]{2}/.test(result) ? result : null;
}

/**
 * Whether Wikipedia's spelling is a typo put right, not another word: at most one letter changed in a
 * short name, one in four in a longer one. "Intersteller" is "interstellar"; "лализа" is no "лариса"
 * (26.11.2026).
 */
export function nearSpelling(typed: string, text: string): boolean {
  const left = [...nameKey(typed)];
  const right = [...nameKey(text)];
  let row = Array.from({ length: right.length + 1 }, (_, at) => at);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[right.length]! <= Math.max(1, Math.floor(left.length / 4));
}

/** The Wikipedia whose spelling suggestions fit a search language. */
export function wikipediaOf(language: string): string {
  const base = (language.split("-")[0] ?? "en").toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

/** Wikipedia's "did you mean" from a `list=search&srinfo=suggestion` answer, or null. */
export function wikipediaSuggestion(body: unknown, typed: string): string | null {
  const suggestion = ((body as { query?: { searchinfo?: { suggestion?: unknown } } } | null)?.query?.searchinfo?.suggestion);
  if (typeof suggestion !== "string") return null;
  const text = suggestion.trim().slice(0, 100);
  return text.length >= 2 && nameKey(text) !== nameKey(typed) && keepsNumbers(typed, text) ? text : null;
}

/** Whether [text] holds the numbers [typed] holds, in order: a spelling fixes letters, never a year or a count. */
export function keepsNumbers(typed: string, text: string): boolean {
  const numbers = (value: string) => (value.match(/\p{N}+/gu) ?? []).join(" ");
  return numbers(typed) === numbers(text);
}
