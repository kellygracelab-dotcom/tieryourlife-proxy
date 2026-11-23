/**
 * Usage statistics without people in them (20.11.2026, `_coordination/analytics-2026-11-20`).
 *
 * Pure rules: which counter a request adds to, how a search is cleaned before it is counted, what a
 * client's batch may say, and how the admin screen's numbers come out of daily sums. Nothing here
 * keeps a uid, a device id or an address; `stats.ts` does the storing.
 */

/** A UTC day, `YYYY-MM-DD`. */
export type Day = string;

export type Platform = "android" | "web" | "ios" | "other";
export const PLATFORMS: readonly Platform[] = ["android", "web", "ios", "other"];

export function dayOf(ms: number): Day {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isDay(value: unknown): value is Day {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayOf(Date.parse(`${value}T00:00:00Z`)) === value;
}

export function addDays(day: Day, days: number): Day {
  return dayOf(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);
}

export function daysBetween(from: Day, to: Day): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Every day from [from] to [to], both included. */
export function daysFrom(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The ISO week a day falls in, `YYYY-Www`: the cohort label of a first launch. */
export function weekOf(day: Day): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday a week label starts on. */
export function weekStart(week: string): Day | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = Date.UTC(year, 0, 4) - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
  const day = dayOf(monday + (number - 1) * 7 * 86_400_000);
  return weekOf(day) === week ? day : null;
}

/** Where `requireAppCheck` leaves the verified app id, read by the statistics after the answer. */
export const APP_ID_LOCAL = "appCheckAppId";

/** Which app asked, from the App Check token's app id (`1:<project>:android:<hash>`): no header needed. */
export function platformOfApp(appId: string | null | undefined): Platform | null {
  if (typeof appId !== "string") return null;
  if (appId.includes(":android:")) return "android";
  if (appId.includes(":web:")) return "web";
  if (appId.includes(":ios:")) return "ios";
  return "other";
}

/** What a client may say about itself in `X-TYL-Client` (`android/1.4.2`) and `X-TYL-Locale` (`ru-RU`). */
export interface ClientFacts {
  version: string | null;
  language: string | null;
  region: string | null;
}

export function clientFacts(client: unknown, locale: unknown): ClientFacts {
  const versionMatch = typeof client === "string" ? /^[a-z]+\/([0-9A-Za-z._-]{1,24})$/.exec(client.trim()) : null;
  const localeMatch = typeof locale === "string" ? /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}))?$/.exec(locale.trim()) : null;
  return {
    version: versionMatch ? versionMatch[1]! : null,
    language: localeMatch ? localeMatch[1]!.toLowerCase() : null,
    region: localeMatch && localeMatch[2] ? localeMatch[2].toUpperCase() : null,
  };
}

/** A counter's key: the event alone, or the event cut by one dimension (`list.view~p:android`). */
export function keysFor(event: string, platform: Platform | null, facts: ClientFacts): string[] {
  const keys = [event];
  if (platform) keys.push(`${event}~p:${platform}`);
  // A key that already carries a cut (a gap, a cohort) is cut by platform only: the rest would multiply it.
  if (event.includes("~")) return keys;
  if (facts.version) keys.push(`${event}~v:${platform ?? "other"}/${facts.version}`);
  if (facts.language) keys.push(`${event}~l:${facts.language}`);
  if (facts.region) keys.push(`${event}~r:${facts.region}`);
  return keys;
}

/** The value of one dimension in a key, or the event with no dimension. */
export function splitKey(key: string): { event: string; dimension: "p" | "v" | "l" | "r" | "g" | "w" | "d" | null; value: string | null; rest: string | null } {
  const [event, ...parts] = key.split("~");
  if (parts.length === 0) return { event: event!, dimension: null, value: null, rest: null };
  const [first, ...more] = parts;
  const colon = first!.indexOf(":");
  return {
    event: event!,
    dimension: first!.slice(0, colon) as "p",
    value: first!.slice(colon + 1),
    rest: more.length > 0 ? more.join("~") : null,
  };
}

// ---------------------------------------------------------------- server-side events

/** The events the Proxy counts by itself, stage 1. */
export const SERVER_EVENTS = [
  "list.view",
  "list.take",
  "list.publish",
  "list.republish",
  "author.follow",
  "topic.follow",
  "topic.open",
  "section.open",
  "home.fresh",
  "search.pictures",
  "search.pictures.miss",
  "search.lists",
  "search.lists.miss",
  "account.erased",
  "server.5xx",
  "server.appCheckRefused",
  "server.searchLimit",
  "server.sourceBusy",
  "server.sourcesDown",
] as const;

export interface RequestFacts {
  fn: "lists" | "boards";
  method: string;
  segments: readonly string[];
  query: Record<string, unknown>;
  status: number;
  /** The JSON the request answered with, read for how many results there were; never kept. */
  body: unknown;
  /** The `code` of a refusal, when the body had one. */
  code: string | null;
}

export interface Tally {
  events: string[];
  /** Per-thing counters: [kind, id, field, fields to keep beside the count]. */
  things: { kind: TopKind; id: string; field: string; keep?: Record<string, string> }[];
}

export type TopKind = "lists" | "topics" | "sections" | "pictureSearch" | "listSearch" | "crashes" | "referrers";
/** The kinds whose ids are words people typed: kept 90 days, shown only at three or more. */
export const SEARCH_KINDS: readonly TopKind[] = ["pictureSearch", "listSearch"];
export const SEARCH_KEEP_DAYS = 90;
export const SEARCH_SHOWN_FROM = 3;

const LIST_ID = /^[A-Za-z0-9]{20}$/;

function single(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function resultCount(body: unknown, field: string): number | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  return Array.isArray(value) ? value.length : null;
}

/**
 * A typed search, cleaned for counting: lower case, single spaces, at most 60 characters. Null for one
 * that looks like an e-mail address, a phone number or a long number: those name a person, not a topic.
 */
export function countableSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  if (/@/.test(text) && /\S+@\S+\.\S+/.test(text)) return null;
  if (/\d[\d\s().+-]{6,}\d/.test(text)) return null;
  if (/\d{6,}/.test(text)) return null;
  return [...text].slice(0, 60).join("");
}

/** What one finished request adds to the day's counters. */
export function tallyOf(facts: RequestFacts): Tally {
  const tally: Tally = { events: [], things: [] };
  const { method, segments, query, status, body, code } = facts;
  if (code === "APP_UNVERIFIED") tally.events.push("server.appCheckRefused");
  if (status >= 500) tally.events.push("server.5xx");
  if (code === "SEARCH_LIMIT") tally.events.push("server.searchLimit");
  if (code === "SOURCE_BUSY") tally.events.push("server.sourceBusy");
  if (code === "SOURCES_DOWN") tally.events.push("server.sourcesDown");
  if (facts.fn === "boards") {
    if (method === "DELETE" && segments.length === 1 && segments[0] === "account" && status === 204) tally.events.push("account.erased");
    return tally;
  }
  const ok = status >= 200 && status < 300;
  if (!ok) return tally;
  const [first, second, third] = segments;
  if (method === "GET" && segments.length === 0) {
    // The row of new lists is shown from two (23.11.2026): an answer with fewer showed nothing.
    if (query.fresh === "1") {
      if ((resultCount(body, "lists") ?? 0) >= 2) tally.events.push("home.fresh");
      return tally;
    }
    const page = single(query.after) === null;
    const typed = countableSearch(query.q);
    if (page && typed !== null) {
      const found = resultCount(body, "lists");
      tally.events.push("search.lists");
      tally.things.push({ kind: "listSearch", id: typed, field: "n", keep: { q: typed } });
      if (found === 0) {
        tally.events.push("search.lists.miss");
        tally.things.push({ kind: "listSearch", id: typed, field: "miss", keep: { q: typed } });
      }
    }
    const topic = single(query.topic);
    if (page && topic !== null && LIST_ID.test(topic)) {
      tally.events.push("topic.open");
      tally.things.push({ kind: "topics", id: topic, field: "opens" });
    }
    const category = single(query.category);
    if (page && category !== null && /^[a-z0-9_]{1,40}$/.test(category)) {
      tally.events.push("section.open");
      tally.things.push({ kind: "sections", id: category, field: "opens" });
    }
    return tally;
  }
  if (method === "GET" && segments.length === 1 && first && LIST_ID.test(first)) {
    tally.events.push("list.view");
    tally.things.push({ kind: "lists", id: first, field: "views" });
    return tally;
  }
  if (method === "POST" && segments.length === 2 && second === "taken" && first && LIST_ID.test(first)) {
    tally.events.push("list.take");
    tally.things.push({ kind: "lists", id: first, field: "takes" });
    return tally;
  }
  if (method === "POST" && segments.length === 0) {
    tally.events.push("list.publish");
    return tally;
  }
  if (method === "POST" && segments.length === 1 && first && LIST_ID.test(first)) {
    tally.events.push("list.republish");
    return tally;
  }
  if (method === "POST" && first === "follow" && segments.length === 2) {
    tally.events.push("author.follow");
    return tally;
  }
  if (method === "POST" && first === "topics" && third === "follow" && second && segments.length === 3) {
    tally.events.push("topic.follow");
    tally.things.push({ kind: "topics", id: second, field: "follows" });
    return tally;
  }
  if (method === "GET" && first === "pictures" && segments.length === 1) {
    const typed = countableSearch(query.q);
    const pageOne = (Number.parseInt(String(query.page ?? "1"), 10) || 1) === 1;
    if (typed === null || !pageOne) return tally;
    const section = single(query.section) ?? single(query.topic) ?? "";
    const id = `${section}|${typed}`;
    const keep = { q: typed, section: /^[A-Za-z0-9_-]{0,40}$/.test(section) ? section : "" };
    // The quick part and a whole answer begin a search; the rest part and a whole answer end it.
    if (query.part !== "rest") {
      tally.events.push("search.pictures");
      tally.things.push({ kind: "pictureSearch", id, field: "n", keep });
    }
    if (query.part !== "quick" && resultCount(body, "items") === 0) {
      tally.events.push("search.pictures.miss");
      tally.things.push({ kind: "pictureSearch", id, field: "miss", keep });
    }
    return tally;
  }
  return tally;
}

// ---------------------------------------------------------------- client batches (stage 2)

/** The steps of a newcomer's first days, each sent once per install. */
export const STEPS = ["first_launch", "open_list", "first_board", "first_card", "full_list", "first_game", "shared", "signed_in", "published"] as const;
export type Step = (typeof STEPS)[number];

/** What clients may count. Anything else in a batch is ignored. */
export const FEATURES = [
  "session",
  "game.smart.start", "game.smart.done",
  "game.king.start", "game.king.done",
  "game.bracket.start", "game.bracket.done",
  "game.losers.start", "game.losers.done",
  "share.image", "share.link",
  "picture.own", "picture.link",
  "picture.pick.commons", "picture.pick.tmdb", "picture.pick.igdb", "picture.pick.inaturalist", "picture.pick.wikidata",
  "picture.pick.deezer", "picture.pick.anilist", "picture.pick.openlibrary", "picture.pick.web", "picture.pick.other",
  "picture.pos.1", "picture.pos.2-3", "picture.pos.4-10", "picture.pos.11+",
  "board.tier", "board.ranked",
] as const;
export type Feature = (typeof FEATURES)[number];

/** The longest gap, in days, a client reports exactly; longer, or a first ever day, is sent as this. */
export const GAP_CAP = 31;
/** Days since the first launch reported exactly for retention. */
export const SINCE_FIRST_CAP = 30;
export const MAX_CRASHES_PER_BATCH = 5;
export const MAX_FEATURE_COUNT = 200;
/** Batches one account may send from one platform in a day; more are refused. */
export const MAX_BATCHES_PER_DAY = 50;

export interface ClientBatch {
  version: string | null;
  language: string | null;
  region: string | null;
  /** Present on the first batch of the device's day. */
  active: { gap: number; sinceFirst: number; firstWeek: string } | null;
  steps: Step[];
  features: Partial<Record<Feature, number>>;
  sessions: number;
  crashedSessions: number;
  crashes: { type: string; place: string }[];
  referrer: { domain: string; utm: string } | null;
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f]/g, "").trim();
  return text === "" ? null : [...text].slice(0, max).join("");
}

/** A client's batch as the server will count it, or null when it is not one. Unknown fields are dropped. */
export function readBatch(raw: unknown): ClientBatch | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const facts = clientFacts(typeof body.version === "string" ? `x/${body.version}` : null, body.locale);
  let active: ClientBatch["active"] = null;
  if (body.active !== undefined && body.active !== null) {
    const a = body.active as Record<string, unknown>;
    const gap = intIn(a.gap, 1, GAP_CAP);
    const sinceFirst = intIn(a.sinceFirst, 0, 100_000);
    const firstWeek = typeof a.firstWeek === "string" && weekStart(a.firstWeek) !== null ? a.firstWeek : null;
    if (gap === null || sinceFirst === null || firstWeek === null) return null;
    active = { gap, sinceFirst, firstWeek };
  }
  const steps = Array.isArray(body.steps) ? [...new Set(body.steps.filter((step): step is Step => (STEPS as readonly string[]).includes(step as string)))] : [];
  const features: Partial<Record<Feature, number>> = {};
  if (body.features && typeof body.features === "object" && !Array.isArray(body.features)) {
    for (const [name, count] of Object.entries(body.features as Record<string, unknown>)) {
      const n = intIn(count, 1, MAX_FEATURE_COUNT);
      if (n !== null && (FEATURES as readonly string[]).includes(name)) features[name as Feature] = n;
    }
  }
  const sessions = intIn(body.sessions, 0, 100) ?? 0;
  const crashedSessions = Math.min(sessions, intIn(body.crashedSessions, 0, 100) ?? 0);
  const crashes = Array.isArray(body.crashes)
    ? body.crashes
        .slice(0, MAX_CRASHES_PER_BATCH)
        .map((crash) => ({ type: cleanLabel((crash as Record<string, unknown>)?.type, 80), place: cleanLabel((crash as Record<string, unknown>)?.place, 120) ?? "" }))
        .filter((crash): crash is { type: string; place: string } => crash.type !== null)
    : [];
  let referrer: ClientBatch["referrer"] = null;
  if (body.referrer && typeof body.referrer === "object") {
    const r = body.referrer as Record<string, unknown>;
    const domain = typeof r.domain === "string" ? r.domain.trim().toLowerCase().replace(/^www\./, "") : "";
    const utm = typeof r.utm === "string" ? r.utm.trim().toLowerCase() : "";
    const domainOk = domain === "" || /^(?=.{1,80}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain);
    const utmOk = utm === "" || /^[a-z0-9_.-]{1,40}$/.test(utm);
    if (domainOk && utmOk && (domain !== "" || utm !== "")) referrer = { domain, utm };
  }
  return { version: facts.version, language: facts.language, region: facts.region, active, steps, features, sessions, crashedSessions, crashes, referrer };
}

/**
 * What a batch adds, once the gate has said which of it is new today for this account on this platform:
 * [firstToday] counts the device active, [newSteps] are the steps not yet counted today, [firstCrashToday]
 * counts the device among those that crashed.
 */
export function tallyOfBatch(batch: ClientBatch, today: Day, gate: { firstToday: boolean; newSteps: Step[]; firstCrashToday: boolean }): Tally {
  const tally: Tally = { events: [], things: [] };
  if (batch.active && gate.firstToday) {
    tally.events.push("active", `active.gap~g:${batch.active.gap}`);
    if (batch.active.sinceFirst <= SINCE_FIRST_CAP) tally.events.push(`ret~w:${batch.active.firstWeek}~d:${batch.active.sinceFirst}`);
  }
  for (const step of gate.newSteps) {
    tally.events.push(`step.${step}`);
    if (batch.active) tally.events.push(`step.${step}~w:${batch.active.firstWeek}`);
    else tally.events.push(`step.${step}~w:${weekOf(today)}`);
  }
  for (const [name, count] of Object.entries(batch.features)) {
    for (let i = 0; i < (count ?? 0); i++) tally.events.push(`f.${name}`);
  }
  for (let i = 0; i < batch.sessions; i++) tally.events.push("sessions");
  for (let i = 0; i < batch.crashedSessions; i++) tally.events.push("sessions.crashed");
  if (gate.firstCrashToday) tally.events.push("active.crashed");
  for (const crash of batch.crashes) {
    tally.events.push("crash");
    tally.things.push({ kind: "crashes", id: `${batch.version ?? ""}|${crash.type}|${crash.place}`, field: "n", keep: { type: crash.type, place: crash.place, version: batch.version ?? "" } });
  }
  if (batch.referrer) {
    tally.events.push("referred");
    tally.things.push({ kind: "referrers", id: `${batch.referrer.domain}|${batch.referrer.utm}`, field: "n", keep: { domain: batch.referrer.domain, utm: batch.referrer.utm } });
  }
  return tally;
}

// ---------------------------------------------------------------- reading the sums back

/** Sums kept for one day: counter key to count. */
export type DaySums = Record<string, number>;

/** One event's count over [days], for one platform or all. */
export function total(sums: Map<Day, DaySums>, days: readonly Day[], event: string, platform: Platform | "all"): number {
  const key = platform === "all" ? event : `${event}~p:${platform}`;
  let n = 0;
  for (const day of days) n += sums.get(day)?.[key] ?? 0;
  return n;
}

/**
 * Distinct devices active in the [window] days ending [to], from the gap each first-of-day ping carries:
 * a device is counted on its first active day inside the window, the one whose gap reaches before it.
 * Exact while clients report their gap honestly; a device with statistics turned off is not counted.
 */
export function activeInWindow(sums: Map<Day, DaySums>, to: Day, window: number, platform: Platform | "all"): number {
  const from = addDays(to, 1 - window);
  let n = 0;
  for (const day of daysFrom(from, to)) {
    const daySums = sums.get(day);
    if (!daySums) continue;
    const reach = daysBetween(from, day);
    for (let gap = reach + 1; gap <= GAP_CAP; gap++) {
      const key = platform === "all" ? `active.gap~g:${gap}` : `active.gap~g:${gap}~p:${platform}`;
      n += daySums[key] ?? 0;
    }
  }
  return n;
}

/** Retention of each first-launch week that began in [weeks]: devices back on day 1, 7 and 30, of those launched. */
export function retention(sums: Map<Day, DaySums>, weeks: readonly string[], platform: Platform | "all", today: Day): { week: string; size: number; d1: number | null; d7: number | null; d30: number | null }[] {
  const all = [...sums.keys()];
  return weeks.map((week) => {
    const start = weekStart(week)!;
    const suffix = platform === "all" ? "" : `~p:${platform}`;
    const size = all.reduce((n, day) => n + (sums.get(day)?.[`step.first_launch~w:${week}${suffix}`] ?? 0), 0);
    const back = (d: number): number | null => {
      // Only once the whole week has had its day d.
      if (addDays(start, 6 + d) > today) return null;
      const n = all.reduce((sum, day) => sum + (sums.get(day)?.[`ret~w:${week}~d:${d}${suffix}`] ?? 0), 0);
      return size === 0 ? null : n / size;
    };
    return { week, size, d1: back(1), d7: back(7), d30: back(30) };
  });
}

/** One dimension of an event over [days]: value to count, the biggest first. */
export function cutBy(sums: Map<Day, DaySums>, days: readonly Day[], event: string, dimension: "v" | "l" | "r"): { value: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const day of days) {
    for (const [key, n] of Object.entries(sums.get(day) ?? {})) {
      const parts = splitKey(key);
      if (parts.event === event && parts.dimension === dimension && parts.rest === null) counts.set(parts.value!, (counts.get(parts.value!) ?? 0) + n);
    }
  }
  return [...counts.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** CSV with a header row; every cell quoted when it needs to be. */
export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[]): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n") + "\r\n";
}
