/**
 * Sections: the places Community opens on. Nine are built in; the rest are
 * proposed by somebody and approved by a moderator, the way topics are. Pure,
 * like the rest of the deciding here; `community.ts` does the reads and writes.
 */
import { isHexColour, type ColourPair, type SectionColours } from "./sectionColours";
import { isPictureId } from "./safety";

/** Where anything without a better place goes, and the one section that is always last. */
export const OTHER = "other";

export interface BuiltInSection {
  id: string;
  name: string;
  /** The app's own labels for it, in every locale it ships. */
  names: Record<string, string>;
  icon: string;
  /** Stored exactly as the app draws them, never recomputed. */
  colours: SectionColours;
}

/** The nine the app shipped with, in the order it drew them. Their ids are what old lists carry. */
export const BUILT_IN_SECTIONS: readonly BuiltInSection[] = [
  {
    id: "anime",
    name: "Anime",
    names: { en: "Anime", uk: "Аніме", ru: "Аниме", es: "Anime", "pt-BR": "Anime", de: "Anime", fr: "Animé", pl: "Anime", tr: "Anime", ja: "アニメ", ar: "أنمي" },
    icon: "animation",
    colours: {
      tint: { light: "#7E4E74", dark: "#64405E" },
      topicBg: { light: "#DFD0DF", dark: "#322533" },
      topicIcon: { light: "#7E4E74", dark: "#E7B0DA" },
    },
  },
  {
    id: "film_tv",
    name: "Film & TV",
    names: { en: "Film & TV", uk: "Кіно і серіали", ru: "Кино и сериалы", es: "Cine y TV", "pt-BR": "Cinema e TV", de: "Film & TV", fr: "Cinéma et TV", pl: "Film i TV", tr: "Film ve Dizi", ja: "映画・ドラマ", ar: "أفلام ومسلسلات" },
    icon: "movie",
    colours: {
      tint: { light: "#3E4A6C", dark: "#343D58" },
      topicBg: { light: "#CECFDD", dark: "#1F2431" },
      topicIcon: { light: "#3E4A6C", dark: "#B4C3EC" },
    },
  },
  {
    id: "games",
    name: "Games",
    names: { en: "Games", uk: "Ігри", ru: "Игры", es: "Juegos", "pt-BR": "Jogos", de: "Spiele", fr: "Jeux", pl: "Gry", tr: "Oyunlar", ja: "ゲーム", ar: "ألعاب" },
    icon: "sports_esports",
    colours: {
      tint: { light: "#3D6B58", dark: "#345649" },
      topicBg: { light: "#CFD8D8", dark: "#202D2B" },
      topicIcon: { light: "#3D6B58", dark: "#A0D1BB" },
    },
  },
  {
    id: "music",
    name: "Music",
    names: { en: "Music", uk: "Музика", ru: "Музыка", es: "Música", "pt-BR": "Música", de: "Musik", fr: "Musique", pl: "Muzyka", tr: "Müzik", ja: "音楽", ar: "موسيقى" },
    icon: "music_note",
    colours: {
      tint: { light: "#62508A", dark: "#4F426F" },
      topicBg: { light: "#D7D1E5", dark: "#292539" },
      topicIcon: { light: "#62508A", dark: "#CAB8FA" },
    },
  },
  {
    id: "books",
    name: "Books",
    names: { en: "Books", uk: "Книги", ru: "Книги", es: "Libros", "pt-BR": "Livros", de: "Bücher", fr: "Livres", pl: "Książki", tr: "Kitaplar", ja: "本", ar: "كتب" },
    icon: "menu_book",
    colours: {
      tint: { light: "#7A5B3F", dark: "#614A37" },
      topicBg: { light: "#DED4D2", dark: "#302925" },
      topicIcon: { light: "#7A5B3F", dark: "#E0BD9E" },
    },
  },
  {
    id: "food",
    name: "Food",
    names: { en: "Food", uk: "Їжа", ru: "Еда", es: "Comida", "pt-BR": "Comida", de: "Essen", fr: "Cuisine", pl: "Jedzenie", tr: "Yemek", ja: "グルメ", ar: "طعام" },
    icon: "restaurant",
    colours: {
      tint: { light: "#9A5638", dark: "#794732" },
      topicBg: { light: "#E7D3D1", dark: "#3A2824" },
      topicIcon: { light: "#9A5638", dark: "#FBAF8F" },
    },
  },
  {
    id: "sport",
    name: "Sport",
    names: { en: "Sport", uk: "Спорт", ru: "Спорт", es: "Deporte", "pt-BR": "Esporte", de: "Sport", fr: "Sport", pl: "Sport", tr: "Spor", ja: "スポーツ", ar: "رياضة" },
    icon: "sports_soccer",
    colours: {
      tint: { light: "#2F6A76", dark: "#2A5560" },
      topicBg: { light: "#CDD7DF", dark: "#1D2D34" },
      topicIcon: { light: "#2F6A76", dark: "#94D0DD" },
    },
  },
  {
    id: "people",
    name: "People",
    names: { en: "People", uk: "Люди", ru: "Люди", es: "Personas", "pt-BR": "Pessoas", de: "Menschen", fr: "Personnes", pl: "Ludzie", tr: "Kişiler", ja: "人物", ar: "أشخاص" },
    icon: "person",
    colours: {
      tint: { light: "#76586A", dark: "#5E4857" },
      topicBg: { light: "#DDD3DC", dark: "#2F2830" },
      topicIcon: { light: "#76586A", dark: "#DBB9CD" },
    },
  },
  {
    id: OTHER,
    name: "Other",
    names: { en: "Other", uk: "Інше", ru: "Другое", es: "Otros", "pt-BR": "Outros", de: "Sonstiges", fr: "Autre", pl: "Inne", tr: "Diğer", ja: "その他", ar: "أخرى" },
    icon: "category",
    colours: {
      tint: { light: "#55566A", dark: "#454656" },
      topicBg: { light: "#D4D2DC", dark: "#262730" },
      topicIcon: { light: "#55566A", dark: "#C0C2D9" },
    },
  },
];

export const BUILT_IN_SECTION_IDS: readonly string[] = BUILT_IN_SECTIONS.map((one) => one.id);

/** What a section looks like before it has a picture of its own: Other's colours. */
export const NEUTRAL_COLOURS: SectionColours = BUILT_IN_SECTIONS[BUILT_IN_SECTIONS.length - 1].colours;

/** The Material Symbols a section may wear and a proposer may pick from, the built-ins' own first. */
export const SECTION_ICONS: readonly string[] = [
  "category",
  "movie",
  "animation",
  "sports_esports",
  "music_note",
  "menu_book",
  "restaurant",
  "sports_soccer",
  "person",
  "pets",
  "flight",
  "directions_car",
  "palette",
  "checkroom",
  "science",
  "computer",
  "local_cafe",
  "park",
  "theater_comedy",
  "mic",
  "photo_camera",
  "sports_basketball",
  "celebration",
  "star",
];

export const DEFAULT_ICON = "category";

/** The app's locales, the only keys a section's translations may have. */
export const SECTION_LOCALES = ["en", "uk", "ru", "es", "pt-BR", "de", "fr", "pl", "tr", "ja", "ar"] as const;

export const SECTION_STATUSES = ["approved", "pending", "declined", "merged"] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

export const MIN_SECTION_NAME_LENGTH = 2;
export const MAX_SECTION_NAME_LENGTH = 24;

/** Three, as for topics: one account cannot fill the queue while its first proposal is still being read. */
export const MAX_PENDING_SECTIONS_PER_ACCOUNT = 3;

/** However they ended, one account proposes at most ten sections a day. */
export const MAX_PROPOSALS_PER_DAY = 10;
export const PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MAX_DECLINE_NOTE_LENGTH = 300;

/** How many pictures a section's header collage takes, and how many it needs before it is drawn at all. */
export const COLLAGE_SIZE = 4;

/** A list's pictures speak for a section only once enough people have ranked it themselves. */
export const COLLAGE_MIN_RANKINGS = 5;

/** How far back "new this week" looks. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How far back the activity that orders sections looks. */
export const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How long the counts are kept before they are read again. */
export const SECTION_STATS_TTL_MS = 10 * 60 * 1000;

/** How long the set of approved sections is kept: short, so one approved elsewhere shows up soon. */
export const SECTIONS_TTL_MS = 2 * 60 * 1000;

export const MAX_SECTION_ID_LENGTH = 40;

/**
 * Words the paths under lists/sections already use, so no section can be
 * named into one of them. "lists" is stripped from every path by the router.
 */
export const RESERVED_SECTION_IDS: readonly string[] = ["queue", "proposals", "order", "name-check", "lists"];

/** A new id is a slug; the built-ins' underscore is older than the rule and is still read. */
const NEW_SECTION_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SECTION_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function isSectionId(value: unknown): value is string {
  return typeof value === "string" && SECTION_ID.test(value);
}

/** Approved and not hidden: a section new lists may be filed under. */
export function isOpen(section: Pick<SectionRecord, "status" | "hidden">): boolean {
  return section.status === "approved" && !section.hidden;
}

export function isSectionIcon(value: unknown): value is string {
  return typeof value === "string" && SECTION_ICONS.includes(value);
}

export interface SectionPicture {
  url: string;
  width: number;
  height: number;
}

/** A section as the deciding here sees it: the stored document with its times in milliseconds. */
export interface SectionRecord {
  id: string;
  name: string;
  names: Record<string, string>;
  icon: string;
  picture: SectionPicture | null;
  tint: ColourPair;
  topicBg: ColourPair;
  topicIcon: ColourPair;
  status: SectionStatus;
  builtIn: boolean;
  /** No tile and nothing new filed under it; its lists stay where links, search and its feed find them. */
  hidden: boolean;
  rank: number | null;
  fileUnder: string | null;
  mergedInto: string | null;
  proposerUid: string | null;
  proposerName: string | null;
  /** The private copy of the proposer's picture, and the unguessable address it is shown to them by. */
  proposalPicture: string | null;
  proposalPictureUrl: string | null;
  declineNote: string | null;
  /** The proposer has read the decline or the merge, so it no longer comes back to them. */
  dismissed: boolean;
  /** Taken back by its own proposer rather than declined by a moderator. */
  withdrawn: boolean;
  /** The owner chose this waiting section's tint, so approval keeps it rather than asking Vision. */
  tintChosen: boolean;
  /** The proposal picture's main colours, strongest first, for the moderator choosing a tint. */
  palette: string[];
  /** A decision is written but the lists it moves are not all moved yet; asking again finishes it. */
  unfinished: boolean;
  createdAtMs: number;
  approvedAtMs: number | null;
  decidedAtMs: number | null;
  decidedBy: string | null;
}

export function builtInRecord(builtIn: BuiltInSection): SectionRecord {
  return {
    id: builtIn.id,
    name: builtIn.name,
    names: { ...builtIn.names },
    icon: builtIn.icon,
    picture: null,
    ...builtIn.colours,
    status: "approved",
    builtIn: true,
    hidden: false,
    rank: null,
    fileUnder: null,
    mergedInto: null,
    proposerUid: null,
    proposerName: null,
    proposalPicture: null,
    proposalPictureUrl: null,
    declineNote: null,
    dismissed: false,
    withdrawn: false,
    tintChosen: false,
    palette: [],
    unfinished: false,
    createdAtMs: 0,
    // Approved at the beginning of time, so among themselves they keep their old order.
    approvedAtMs: 0,
    decidedAtMs: null,
    decidedBy: null,
  };
}

/** A section nobody has decided anything about yet, drawn in Other's colours until it has a picture. */
export function newSection(id: string, name: string, nowMs: number): SectionRecord {
  return {
    id,
    name,
    names: {},
    icon: DEFAULT_ICON,
    picture: null,
    ...NEUTRAL_COLOURS,
    status: "pending",
    builtIn: false,
    hidden: false,
    rank: null,
    fileUnder: null,
    mergedInto: null,
    proposerUid: null,
    proposerName: null,
    proposalPicture: null,
    proposalPictureUrl: null,
    declineNote: null,
    dismissed: false,
    withdrawn: false,
    tintChosen: false,
    palette: [],
    unfinished: false,
    createdAtMs: nowMs,
    approvedAtMs: null,
    decidedAtMs: null,
    decidedBy: null,
  };
}

/**
 * The text as it reads: compatibility forms folded (a full-width "ｆｏｏｄ" is
 * "food") and format characters taken out, so a zero-width space cannot make
 * two names that look the same into two sections.
 */
export function visibleText(value: string): string {
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/**
 * Collapsed and trimmed, two to twenty-four characters, and something in it
 * that is a letter or a digit. Characters, not UTF-16 units: an emoji is one.
 */
export function cleanSectionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = visibleText(value).replace(/\s+/g, " ").trim();
  const length = [...collapsed].length;
  if (length < MIN_SECTION_NAME_LENGTH || length > MAX_SECTION_NAME_LENGTH) return null;
  return /[\p{L}\p{N}]/u.test(collapsed) ? collapsed : null;
}

/** What two names are compared by: no case, no accents, single spaces. "Café" and "cafe" are one section. */
export function nameKey(name: string): string {
  return visibleText(name)
    .normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A moderator's translations: only the app's locales, each a proper name.
 * An empty one is dropped, which is how a translation is taken away.
 */
export function readNames(
  value: unknown,
  clean: (raw: unknown) => string | null = cleanSectionName,
): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const names: Record<string, string> = {};
  for (const [locale, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(SECTION_LOCALES as readonly string[]).includes(locale)) return null;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    const name = clean(raw);
    if (name === null) return null;
    names[locale] = name;
  }
  return names;
}

/**
 * The section, approved or waiting, that already goes by one of these names
 * in any language. Declined and merged ones have given their names up.
 */
export function findClash(names: readonly string[], sections: readonly SectionRecord[], except: string | null): string | null {
  const wanted = new Set(names.map(nameKey));
  const clash = sections.find(
    (one) =>
      one.id !== except &&
      (one.status === "approved" || one.status === "pending") &&
      [one.name, ...Object.values(one.names)].some((name) => wanted.has(nameKey(name))),
  );
  return clash?.id ?? null;
}

/** An ASCII slug of the name, or null when the name is in a script that leaves too little of one. */
export function slugOf(name: string): string | null {
  const slug = visibleText(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SECTION_ID_LENGTH)
    .replace(/-+$/, "");
  return NEW_SECTION_ID.test(slug) ? slug : null;
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Eight base36 characters from random bytes, for a name that gives no slug. */
export function base36Of(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 8)].map((byte) => BASE36[byte % 36]).join("");
}

/**
 * A new section's id, which never changes afterwards: the slug of its name,
 * with -2, -3 on a clash, or s- and eight random characters when the name
 * gives no slug. Reserved words count as taken.
 */
export function pickSectionId(name: string, taken: ReadonlySet<string>, random: () => string): string {
  const free = (id: string) => !taken.has(id) && !RESERVED_SECTION_IDS.includes(id);
  const base = slugOf(name);
  if (base === null) {
    for (;;) {
      const id = `s-${random()}`;
      if (free(id)) return id;
    }
  }
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_SECTION_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(id)) return id;
  }
}

export type ProposalRefusal =
  | { code: "BAD_NAME" }
  | { code: "NAME_TAKEN"; id: string }
  | { code: "BAD_ICON" }
  | { code: "BAD_FILE_UNDER" }
  | { code: "BAD_PICTURE"; why: "missing" }
  | { code: "TOO_MANY_PENDING" }
  | { code: "TOO_MANY_PROPOSALS" };

export type ProposalDecision =
  | { ok: true; name: string; icon: string; fileUnder: string; pictureId: string }
  | ({ ok: false } & ProposalRefusal);

export interface ProposalInput {
  body: unknown;
  callerUid: string;
  /** Every section there is, read fresh: a name is compared with all of them. */
  sections: readonly SectionRecord[];
}

/**
 * Everything about a proposal that can be judged without its picture. The
 * picture is read and measured afterwards, because that costs a download.
 */
export function decideProposal({ body, callerUid, sections }: ProposalInput): ProposalDecision {
  const source = (body ?? {}) as Record<string, unknown>;
  const name = cleanSectionName(source.name);
  if (name === null) return { ok: false, code: "BAD_NAME" };
  const clash = findClash([name], sections, null);
  if (clash !== null) return { ok: false, code: "NAME_TAKEN", id: clash };
  const icon = source.icon === undefined || source.icon === null ? DEFAULT_ICON : source.icon;
  if (!isSectionIcon(icon)) return { ok: false, code: "BAD_ICON" };
  const fileUnder = sections.find((one) => one.id === source.fileUnder && isOpen(one));
  if (!fileUnder) return { ok: false, code: "BAD_FILE_UNDER" };
  if (!isPictureId(source.pictureId)) return { ok: false, code: "BAD_PICTURE", why: "missing" };
  const pending = sections.filter((one) => one.proposerUid === callerUid && one.status === "pending").length;
  if (pending >= MAX_PENDING_SECTIONS_PER_ACCOUNT) return { ok: false, code: "TOO_MANY_PENDING" };
  return { ok: true, name, icon, fileUnder: fileUnder.id, pictureId: source.pictureId };
}

export interface SectionEdits {
  name?: string;
  names?: Record<string, string>;
  icon?: string;
  rank?: number | null;
  hidden?: boolean;
  pictureId?: string;
  /** A light tint the owner or a moderator chose; the rest is derived from it. */
  tint?: string;
}

export type EditField = keyof SectionEdits;

export type EditRefusal =
  | { code: "BAD_NAME" }
  | { code: "BAD_ICON" }
  | { code: "BAD_PICTURE"; why: "missing" }
  | { code: "INVALID"; detail: string };

/** What a moderator's call asks to change, each field only when it was sent and only when this call may change it. */
export function readSectionEdits(
  body: unknown,
  allowed: readonly EditField[],
): { ok: true; edits: SectionEdits } | ({ ok: false } & EditRefusal) {
  const source = (body ?? {}) as Record<string, unknown>;
  const sent = (field: string) => source[field] !== undefined;
  const edits: SectionEdits = {};

  if (allowed.includes("name") && sent("name")) {
    const name = cleanSectionName(source.name);
    if (name === null) return { ok: false, code: "BAD_NAME" };
    edits.name = name;
  }
  if (allowed.includes("names") && sent("names")) {
    const names = readNames(source.names);
    if (names === null) return { ok: false, code: "BAD_NAME" };
    edits.names = names;
  }
  if (allowed.includes("icon") && sent("icon")) {
    if (!isSectionIcon(source.icon)) return { ok: false, code: "BAD_ICON" };
    edits.icon = source.icon;
  }
  if (allowed.includes("rank") && sent("rank")) {
    if (source.rank !== null && !Number.isSafeInteger(source.rank)) {
      return { ok: false, code: "INVALID", detail: "A rank is a whole number, or null to unpin" };
    }
    edits.rank = source.rank as number | null;
  }
  if (allowed.includes("hidden") && sent("hidden")) {
    if (typeof source.hidden !== "boolean") return { ok: false, code: "INVALID", detail: "Hidden is true or false" };
    edits.hidden = source.hidden;
  }
  if (allowed.includes("pictureId") && sent("pictureId")) {
    if (!isPictureId(source.pictureId)) return { ok: false, code: "BAD_PICTURE", why: "missing" };
    edits.pictureId = source.pictureId;
  }
  if (allowed.includes("tint") && sent("tint")) {
    if (!isHexColour(source.tint)) return { ok: false, code: "INVALID", detail: "A tint is one hex colour, #RRGGBB" };
    edits.tint = source.tint.toUpperCase();
  }
  return { ok: true, edits };
}

/** What the owner may change on an approved section. */
export const APPROVED_EDIT_FIELDS: readonly EditField[] = ["name", "names", "icon", "rank", "hidden", "pictureId", "tint"];

/** What the owner may change on a proposal still waiting: how it reads and looks. Its place and visibility come with approval. */
export const PENDING_EDIT_FIELDS: readonly EditField[] = ["name", "names", "icon", "pictureId", "tint"];

/** A field sent for a waiting section that only an approved one has, if any. */
export function notYetEditable(status: SectionStatus, body: unknown): "rank" | "hidden" | null {
  if (status !== "pending") return null;
  const source = (body ?? {}) as Record<string, unknown>;
  if (source.rank !== undefined) return "rank";
  if (source.hidden !== undefined) return "hidden";
  return null;
}

/** The compared forms of the names a section stops going by, whose reservations it can let go. */
export function releasedNames(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after.map(nameKey));
  return [...new Set(before.map(nameKey))].filter((key) => !kept.has(key));
}

/** Every name a section would go by after these edits, for comparing with the others. */
export function namesAfter(current: Pick<SectionRecord, "name" | "names">, edits: SectionEdits): string[] {
  return [edits.name ?? current.name, ...Object.values(edits.names ?? current.names)];
}

export const SECTION_ACTIONS = ["approve", "decline", "merge"] as const;
export type SectionAction = (typeof SECTION_ACTIONS)[number];

export type SectionActionRefusal = "settled" | "built_in" | "no_target" | "itself" | "target_not_approved";

/** Field changes on the lists of one query: `null` clears a field. */
export type ListChange = Record<string, string | null>;

export type SectionOutcome =
  | {
      ok: true;
      /** The decision is already written; only its moves are left to finish. */
      resume: boolean;
      status: SectionStatus;
      mergedInto: string | null;
      /** What changes on the lists waiting for the section (`proposedSection == id`). */
      waiting: ListChange;
      /** What changes on the lists already in it (`category == id`); null when they stay. */
      filed: ListChange | null;
    }
  | { ok: false; reason: SectionActionRefusal };

const SETTLED_AS: Record<SectionAction, SectionStatus> = { approve: "approved", decline: "declined", merge: "merged" };

/** What a decision moves: the lists waiting for the section, and for a merge the lists already in it. */
function movesOf(action: SectionAction, sectionId: string, into: string | null): Pick<Extract<SectionOutcome, { ok: true }>, "waiting" | "filed"> {
  switch (action) {
    case "approve":
      return { waiting: { category: sectionId, proposedSection: null }, filed: null };
    case "decline":
      return { waiting: { proposedSection: null }, filed: null };
    case "merge":
      return { waiting: { category: into, proposedSection: null }, filed: { category: into } };
  }
}

/**
 * A moderator's word on a section, as data. Approving and declining are for
 * one still waiting; merging also for one already approved, into another
 * approved section. Built-ins are never declined or merged away. The same
 * word again on a section it left half done finishes moving its lists; any
 * other word on a decided section is too late.
 */
export function decideSectionAction(action: SectionAction, section: SectionRecord, into: SectionRecord | null): SectionOutcome {
  if (section.builtIn && action !== "approve") return { ok: false, reason: "built_in" };
  if (section.unfinished && section.status === SETTLED_AS[action]) {
    if (action === "merge" && section.mergedInto !== into?.id) return { ok: false, reason: "settled" };
    return { ok: true, resume: true, status: section.status, mergedInto: section.mergedInto, ...movesOf(action, section.id, section.mergedInto) };
  }
  switch (action) {
    case "approve":
    case "decline":
      if (section.status !== "pending") return { ok: false, reason: "settled" };
      return { ok: true, resume: false, status: SETTLED_AS[action], mergedInto: null, ...movesOf(action, section.id, null) };
    case "merge": {
      if (section.status !== "pending" && section.status !== "approved") return { ok: false, reason: "settled" };
      if (into === null) return { ok: false, reason: "no_target" };
      if (into.id === section.id) return { ok: false, reason: "itself" };
      if (into.status !== "approved") return { ok: false, reason: "target_not_approved" };
      return { ok: true, resume: false, status: "merged", mergedInto: into.id, ...movesOf(action, section.id, into.id) };
    }
  }
}

/** A proposer taking their proposal back: the lists stay where they were filed and stop waiting. */
export const WITHDRAWN_LISTS: ListChange = { proposedSection: null };

/** The times of an account's recent proposals, as stored, without anything older than a day or not a time. */
export function recentProposals(stored: unknown, nowMs: number): number[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((at): at is number => typeof at === "number" && nowMs - at < PROPOSAL_WINDOW_MS);
}

/** Whether an account may propose once more: three waiting at most, ten a day at most. */
export function decideProposalQuota(pending: number, recent: readonly number[]): "TOO_MANY_PENDING" | "TOO_MANY_PROPOSALS" | null {
  if (pending >= MAX_PENDING_SECTIONS_PER_ACCOUNT) return "TOO_MANY_PENDING";
  if (recent.length >= MAX_PROPOSALS_PER_DAY) return "TOO_MANY_PROPOSALS";
  return null;
}

/** A name held by a section, as its reservation says. */
export interface NameReservation {
  key: string;
  sectionId: string;
}

/**
 * Which section, other than `self`, already holds one of these names by
 * reservation. A reservation counts only while its section is approved or
 * waiting and still goes by that name: a declined, merged, renamed or deleted
 * section has given it up without anybody having to say so.
 */
export function reservationClash(
  names: readonly string[],
  reservations: readonly NameReservation[],
  holders: ReadonlyMap<string, SectionRecord>,
  self: string | null,
): string | null {
  const wanted = new Set(names.map(nameKey));
  for (const reservation of reservations) {
    if (!wanted.has(reservation.key) || reservation.sectionId === self) continue;
    const holder = holders.get(reservation.sectionId);
    if (holder && findClash([reservation.key], [holder], self) !== null) return holder.id;
  }
  return null;
}

export type Withdrawal = "missing" | "withdraw" | "dismiss" | "settled";

/**
 * What the proposer's DELETE does: takes back a proposal still waiting, puts
 * away a declined or merged one's notice, and nothing to an approved one.
 * Anybody else's proposal, or a built-in, is not there for them.
 */
export function decideWithdrawal(section: SectionRecord | null, callerUid: string): Withdrawal {
  if (section === null || section.builtIn || section.proposerUid !== callerUid) return "missing";
  if (section.status === "pending") return "withdraw";
  if (section.status === "declined" || section.status === "merged") return "dismiss";
  return "settled";
}

export type ReaderAnswer = "view" | "merged" | "missing";

/**
 * What one reader is told about one section. Approved sections are
 * everybody's; a proposal is its proposer's and the moderators'. A merged
 * section points onwards for everybody only if it was ever approved; one
 * merged while it was still a proposal was never public, so it stays theirs.
 */
export function answerFor(section: SectionRecord | null, viewer: Viewer): ReaderAnswer {
  if (section === null) return "missing";
  const mayKnow = viewer.moderator || (section.proposerUid !== null && section.proposerUid === viewer.uid);
  if (section.status === "merged") {
    if (section.mergedInto === null) return "missing";
    return section.approvedAtMs !== null || mayKnow ? "merged" : "missing";
  }
  if (section.status === "approved") return "view";
  return mayKnow ? "view" : "missing";
}

export type SectionChoice = { ok: true; category: string; proposedSection: string | null } | { ok: false };

/**
 * Where a published list goes. An open section takes it, and a list being
 * republished keeps its own section even once that is hidden; the
 * publisher's own proposal holds it in the section the proposal is filed
 * under until a moderator decides; a merged id is followed to where it went,
 * so a phone with an old list of sections still publishes somewhere real.
 */
export function decideSectionChoice(
  asked: string,
  known: ReadonlyMap<string, SectionRecord>,
  callerUid: string,
  keeping: string | null = null,
): SectionChoice {
  const section = known.get(asked);
  if (!section) return { ok: false };
  const kept = section.id === keeping && section.status === "approved";
  if (isOpen(section) || kept) return { ok: true, category: section.id, proposedSection: null };
  if (section.status === "pending" && section.proposerUid === callerUid) {
    const holder = section.fileUnder === null ? undefined : known.get(section.fileUnder);
    return { ok: true, category: holder && isOpen(holder) ? holder.id : OTHER, proposedSection: section.id };
  }
  if (section.status === "merged" && section.mergedInto !== null) {
    const target = known.get(section.mergedInto);
    if (target && isOpen(target)) return { ok: true, category: target.id, proposedSection: null };
  }
  return { ok: false };
}

export type Orderable = Pick<SectionRecord, "id" | "builtIn" | "rank" | "approvedAtMs">;

/**
 * The order every client draws: followed sections first, then pinned ones by
 * rank, then the busiest of the last thirty days, then the longest approved.
 * The built-ins were all approved at the start and keep their old order among
 * themselves. Other is always last, whatever else is true of it.
 */
export function orderSections<T extends Orderable>(
  sections: readonly T[],
  followed: ReadonlySet<string>,
  activity: (id: string) => number,
): T[] {
  const builtInAt = (id: string) => {
    const at = BUILT_IN_SECTION_IDS.indexOf(id);
    return at < 0 ? BUILT_IN_SECTION_IDS.length : at;
  };
  return [...sections].sort((left, right) => {
    const other = Number(left.id === OTHER) - Number(right.id === OTHER);
    if (other !== 0) return other;
    const follows = Number(followed.has(right.id)) - Number(followed.has(left.id));
    if (follows !== 0) return follows;
    const pinned = Number(right.rank !== null) - Number(left.rank !== null);
    if (pinned !== 0) return pinned;
    if (left.rank !== null && right.rank !== null && left.rank !== right.rank) return left.rank - right.rank;
    const busier = activity(right.id) - activity(left.id);
    if (busier !== 0) return busier;
    const older = (left.approvedAtMs ?? 0) - (right.approvedAtMs ?? 0);
    if (older !== 0) return older;
    return builtInAt(left.id) - builtInAt(right.id) || left.id.localeCompare(right.id);
  });
}

export interface OrderChange {
  id: string;
  fields: { rank?: number | null; hidden?: boolean };
}

/** Each a string, each once, each an approved section. */
function approvedIds(value: unknown, approved: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === "string" && approved.has(id))) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

/**
 * The owner's order screen saved in one go: the sections in `ids` ranked by
 * their place, every other one unpinned, and exactly the ones in `hidden`
 * hidden. Other is never hidden: lists fall back to it. Only what changes is
 * written.
 */
export function decideOrder(
  body: { ids?: unknown; hidden?: unknown },
  sections: readonly SectionRecord[],
): { ok: true; changes: OrderChange[] } | { ok: false } {
  const approved = new Set(sections.filter((one) => one.status === "approved").map((one) => one.id));
  const ids = approvedIds(body.ids, approved);
  const hidden = approvedIds(body.hidden ?? [], approved);
  if (ids === null || hidden === null || hidden.includes(OTHER)) return { ok: false };
  const place = new Map(ids.map((id, at) => [id, at]));
  const hide = new Set(hidden);
  const changes: OrderChange[] = [];
  for (const one of sections) {
    const fields: OrderChange["fields"] = {};
    const rank = place.get(one.id) ?? null;
    if (rank !== one.rank) fields.rank = rank;
    if (hide.has(one.id) !== one.hidden) fields.hidden = hide.has(one.id);
    if (Object.keys(fields).length > 0) changes.push({ id: one.id, fields });
  }
  return { ok: true, changes };
}

export type DeletionRefusal = "built_in" | "not_empty";

/** The topics that still hold a section: approved or waiting ones. Rejected and merged topics hold nothing. */
export function liveTopics(statuses: readonly unknown[]): number {
  return statuses.filter((status) => status === "approved" || status === "pending").length;
}

/** A section goes only when nothing is filed under it or waits for it, and never a built-in. */
export function decideDeletion(
  section: Pick<SectionRecord, "builtIn">,
  holding: { lists: number; topics: number },
): { ok: true } | { ok: false; reason: DeletionRefusal } {
  if (section.builtIn) return { ok: false, reason: "built_in" };
  if (holding.lists > 0 || holding.topics > 0) return { ok: false, reason: "not_empty" };
  return { ok: true };
}

export type NameCheck = { free: true } | { free: false; id: string } | { free: false; code: "BAD_NAME" };

/** The live answer while somebody types a name: the same rules and the same comparison as proposing. */
export function checkName(raw: unknown, sections: readonly SectionRecord[]): NameCheck {
  const name = cleanSectionName(raw);
  if (name === null) return { free: false, code: "BAD_NAME" };
  const clash = findClash([name], sections, null);
  return clash === null ? { free: true } : { free: false, id: clash };
}

export type Role = "owner" | "moderator";

/**
 * Who may do what. The owner is the configured person; a moderator is one
 * they appointed. Deciding a proposal and naming a topic are a moderator's
 * work; anything that reshapes the set of sections is the owner's.
 */
export const SECTION_CALLS = {
  queue: ["owner", "moderator"],
  approve: ["owner", "moderator"],
  decline: ["owner", "moderator"],
  createTopic: ["owner", "moderator"],
  merge: ["owner"],
  edit: ["owner"],
  order: ["owner"],
  delete: ["owner"],
  create: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type SectionCall = keyof typeof SECTION_CALLS;

export function mayCall(role: Role | null, call: SectionCall): boolean {
  return role !== null && (SECTION_CALLS[call] as readonly Role[]).includes(role);
}

export interface SectionStats {
  id: string;
  listCount: number;
  lists30d: number;
  newThisWeek: number;
  followerCount: number;
  collage: string[];
}

export function noStats(id: string): SectionStats {
  return { id, listCount: 0, lists30d: 0, newThisWeek: 0, followerCount: 0, collage: [] };
}

export interface Viewer {
  uid: string;
  moderator: boolean;
}

export interface SectionView {
  id: string;
  name: string;
  names: Record<string, string>;
  icon: string;
  pictureUrl: string | null;
  tint: ColourPair;
  topicBg: ColourPair;
  topicIcon: ColourPair;
  status: SectionStatus;
  builtIn: boolean;
  hidden: boolean;
  rank: number | null;
  approvedAt: number | null;
  listCount: number;
  lists30d: number;
  newThisWeek: number;
  followerCount: number;
  following: boolean;
  collage: string[];
  fileUnder?: string | null;
  proposerUid?: string | null;
  declineNote?: string | null;
  /** Lists already published into the proposal, waiting to move in. */
  waitingLists?: number;
  proposerName?: string | null;
  mergedInto?: string | null;
  palette?: string[];
  unfinished?: boolean;
  withdrawn?: boolean;
  createdAt?: number;
  decidedAt?: number | null;
  decidedBy?: string | null;
}

/**
 * One section as one reader is told it. Who proposed it, where its lists
 * wait and what became of it go only to the proposer, and only while it is
 * not approved; the moderators see all of it. A waiting picture's address is
 * unguessable and goes to the same people.
 */
export function sectionView(
  section: SectionRecord,
  viewer: Viewer,
  stats: SectionStats,
  following: boolean,
  waitingLists = 0,
): SectionView {
  const proposal = section.status !== "approved";
  const proposer = section.proposerUid !== null && section.proposerUid === viewer.uid;
  const mayKnow = proposer || viewer.moderator;
  const view: SectionView = {
    id: section.id,
    name: section.name,
    names: section.names,
    icon: section.icon,
    pictureUrl: section.builtIn
      ? null
      : section.status === "approved"
        ? section.picture?.url ?? null
        : mayKnow
          ? section.proposalPictureUrl
          : null,
    tint: section.tint,
    topicBg: section.topicBg,
    topicIcon: section.topicIcon,
    status: section.status,
    builtIn: section.builtIn,
    hidden: section.hidden,
    rank: section.rank,
    approvedAt: section.approvedAtMs,
    listCount: stats.listCount,
    lists30d: stats.lists30d,
    newThisWeek: stats.newThisWeek,
    followerCount: stats.followerCount,
    following,
    collage: stats.collage,
  };
  if (proposal && mayKnow) {
    view.fileUnder = section.fileUnder;
    view.proposerUid = section.proposerUid;
    view.declineNote = section.dismissed && !viewer.moderator ? null : section.declineNote;
    view.mergedInto = section.mergedInto;
    view.waitingLists = waitingLists;
  }
  if (viewer.moderator) {
    view.fileUnder = section.fileUnder;
    view.proposerUid = section.proposerUid;
    view.proposerName = section.proposerName;
    view.mergedInto = section.mergedInto;
    view.palette = section.palette;
    view.unfinished = section.unfinished;
    view.withdrawn = section.withdrawn;
    view.createdAt = section.createdAtMs;
    view.decidedAt = section.decidedAtMs;
    view.decidedBy = section.decidedBy;
  }
  return view;
}

/**
 * The caller's own proposals that still belong in their answer: waiting ones,
 * and declined or merged ones until they have read what became of them.
 * Oldest first.
 */
export function ownProposals(sections: readonly SectionRecord[], uid: string): SectionRecord[] {
  return sections
    .filter(
      (one) =>
        one.proposerUid === uid &&
        (one.status === "pending" || ((one.status === "declined" || one.status === "merged") && !one.dismissed)),
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/**
 * What one reader's list holds: the approved sections to be ordered as tiles,
 * and the proposals after them. Everybody gets the approved ones that are not
 * hidden and their own proposals; a moderator gets the hidden ones as well,
 * and every pending, declined and merged section, oldest first, for the history.
 */
export function sectionsListedFor(
  viewer: Viewer,
  approved: readonly SectionRecord[],
  others: readonly SectionRecord[],
): { tiles: SectionRecord[]; proposals: SectionRecord[] } {
  if (viewer.moderator) {
    return {
      tiles: [...approved],
      proposals: others.filter((one) => one.status !== "approved").sort((left, right) => left.createdAtMs - right.createdAtMs),
    };
  }
  return { tiles: approved.filter((one) => !one.hidden), proposals: ownProposals(others, viewer.uid) };
}

/**
 * What erasing an account does to a section it proposed: a proposal nobody
 * approved goes with the account, an approved or merged section stays and
 * only loses the name on it.
 */
export function proposalAfterErasure(status: SectionStatus): "remove" | "forget" {
  return status === "pending" || status === "declined" ? "remove" : "forget";
}

/** Deterministic, like a topic follow: following twice writes the same document. */
export function sectionFollowId(uid: string, section: string): string {
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

/** A count that cannot go below nothing, whatever two reads taken a moment apart say. */
export function countWithout(all: number, excluded: number): number {
  return Math.max(0, all - excluded);
}

/**
 * The sections a following feed reads from: all that are followed, or, when
 * the feed is narrowed to one section, that one if it is followed.
 */
export function followedSectionRun(followed: string[], narrowedTo: string | null): string[] {
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
  private generation = 0;

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
    const generation = this.generation;
    const reading = load()
      .then((fresh) => {
        // A read that began before somebody changed what it reads is not kept.
        if (generation === this.generation) {
          this.value = fresh;
          this.readAt = this.now();
        }
        return fresh;
      })
      .finally(() => {
        if (this.reading === reading) this.reading = null;
      });
    this.reading = reading;
    return reading;
  }

  /** Forget the value, after this instance changed what it was read from. */
  invalidate(): void {
    this.value = null;
    this.reading = null;
    this.generation += 1;
  }
}
