import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  activeInWindow,
  addDays,
  APP_ID_LOCAL,
  cutBy,
  dayOf,
  daysBetween,
  daysFrom,
  isDay,
  keysFor,
  platformOfApp,
  MAX_BATCHES_PER_DAY,
  readBatch,
  retention,
  SEARCH_KEEP_DAYS,
  SEARCH_KINDS,
  SEARCH_SHOWN_FROM,
  splitKey,
  STEPS,
  tallyOf,
  tallyOfBatch,
  toCsv,
  weekOf,
  weekStart,
  clientFacts,
  total,
  type ClientFacts,
  type Day,
  type DaySums,
  type Platform,
  type Step,
  type Tally,
  type TopKind,
} from "./statsKeys";

/**
 * Usage statistics kept as daily sums (20.11.2026). See `statsKeys.ts` for the rules and CONTRACT.md
 * "Usage statistics" for what the clients and the admin screen see.
 *
 * Storage:
 * - `statsDays/{day}_{shard}`: `{day, c: {key: count}}`, one of SHARDS documents a day so no one of them
 *   is written more than about once a second;
 * - `statsTop/{day}/{kind}/{hash}`: one document per list, topic, section, search, crash or referrer
 *   counted that day, with the count fields and the label to show;
 * - `statsGate/{day}/accounts/{hash}`: the anti-abuse gate for client batches, keyed by a one-way hash
 *   of the day, the platform and the account, removed by the nightly sweep the next day;
 * - `statsAccounts/{day}`: the nightly count of accounts from Firebase Auth (`sweepGuests`).
 */

export const STATS_DAYS = "statsDays";
export const STATS_TOP = "statsTop";
export const STATS_GATE = "statsGate";
export const STATS_ACCOUNTS = "statsAccounts";
export const SHARDS = 8;
/** How long an instance holds its counts before writing them. */
export const FLUSH_EVERY_MS = 30_000;
const FLUSH_AT_ENTRIES = 400;

// ---------------------------------------------------------------- the buffer

interface TopEntry {
  day: Day;
  kind: TopKind;
  id: string;
  keep: Record<string, string>;
  inc: Record<string, number>;
}

let counters = new Map<Day, Map<string, number>>();
let tops = new Map<string, TopEntry>();
let lastFlushMs = Date.now();
let flushing: Promise<void> | null = null;

function entries(): number {
  let n = tops.size;
  for (const day of counters.values()) n += day.size;
  return n;
}

export function topDocId(kind: TopKind, id: string): string {
  return kind === "lists" || kind === "topics" || kind === "sections" ? id : createHash("sha1").update(id).digest("hex").slice(0, 32);
}

/** Adds what one request or batch counted to this instance's buffer. */
export function record(tally: Tally, platform: Platform | null, facts: ClientFacts, nowMs = Date.now()): void {
  const day = dayOf(nowMs);
  let dayCounters = counters.get(day);
  if (!dayCounters) counters.set(day, (dayCounters = new Map()));
  for (const event of tally.events) {
    for (const key of keysFor(event, platform, facts)) dayCounters.set(key, (dayCounters.get(key) ?? 0) + 1);
  }
  for (const thing of tally.things) {
    const docId = topDocId(thing.kind, thing.id);
    const path = `${day}/${thing.kind}/${docId}`;
    const entry = tops.get(path) ?? { day, kind: thing.kind, id: thing.id, keep: {}, inc: {} };
    Object.assign(entry.keep, thing.keep ?? {});
    entry.inc[thing.field] = (entry.inc[thing.field] ?? 0) + 1;
    tops.set(path, entry);
  }
  if (entries() >= FLUSH_AT_ENTRIES) void flushStats();
}

/** Writes what this instance holds, at most one flush at a time. A failed write is dropped, not retried: these are statistics. */
export function flushStats(): Promise<void> {
  if (flushing) return flushing;
  if (counters.size === 0 && tops.size === 0) return Promise.resolve();
  const heldCounters = counters;
  const heldTops = tops;
  counters = new Map();
  tops = new Map();
  lastFlushMs = Date.now();
  flushing = writeHeld(heldCounters, heldTops)
    .catch((error) => console.warn("Statistics not written", error))
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/** Called as each request begins: writes the held counts once they are old enough. */
export function flushStatsIfDue(nowMs = Date.now()): void {
  if (nowMs - lastFlushMs >= FLUSH_EVERY_MS) void flushStats();
}

async function writeHeld(heldCounters: Map<Day, Map<string, number>>, heldTops: Map<string, TopEntry>): Promise<void> {
  const db = getFirestore();
  const writes: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }[] = [];
  const shard = Math.floor(Math.random() * SHARDS);
  for (const [day, keys] of heldCounters) {
    const c: Record<string, FirebaseFirestore.FieldValue> = {};
    for (const [key, n] of keys) c[key] = FieldValue.increment(n);
    writes.push({ ref: db.collection(STATS_DAYS).doc(`${day}_${shard}`), data: { day, c } });
  }
  for (const entry of heldTops.values()) {
    const data: Record<string, unknown> = { id: entry.id, ...entry.keep };
    for (const [field, n] of Object.entries(entry.inc)) data[field] = FieldValue.increment(n);
    writes.push({ ref: db.collection(STATS_TOP).doc(entry.day).collection(entry.kind).doc(topDocId(entry.kind, entry.id)), data });
  }
  for (let from = 0; from < writes.length; from += 400) {
    const batch = db.batch();
    for (const write of writes.slice(from, from + 400)) batch.set(write.ref, write.data, { merge: true });
    await batch.commit();
  }
}

let stopping = false;
/** An instance told to stop writes what it holds first (Cloud Run gives it ten seconds). */
export function flushOnStop(): void {
  if (stopping) return;
  stopping = true;
  process.once("SIGTERM", () => void flushStats());
}

/** Only for tests: what the buffer holds, and a clean start. */
export function heldForTests(): { counters: Map<Day, Map<string, number>>; tops: Map<string, TopEntry> } {
  return { counters, tops };
}
export function resetForTests(): void {
  counters = new Map();
  tops = new Map();
  lastFlushMs = Date.now();
  flushing = null;
}

// ---------------------------------------------------------------- watching requests (stage 1)

export function platformOf(response: Response): Platform | null {
  return platformOfApp(response.locals?.[APP_ID_LOCAL] as string | undefined);
}

/**
 * Counts one request once it is answered: what it was for, how it ended and, for a search, whether it
 * found anything. The answer is read for its size and refusal code and then let go. Nothing about who
 * asked is kept.
 */
export function watchRequest(fn: "lists" | "boards", request: Request, response: Response, segments: readonly string[]): void {
  flushOnStop();
  flushStatsIfDue();
  let body: unknown = null;
  const json = response.json.bind(response);
  response.json = ((value: unknown) => {
    body = value;
    return json(value);
  }) as Response["json"];
  response.once("finish", () => {
    try {
      const code = body !== null && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null;
      const tally = tallyOf({ fn, method: request.method, segments, query: request.query as Record<string, unknown>, status: response.statusCode, body, code });
      body = null;
      if (tally.events.length > 0 || tally.things.length > 0) record(tally, platformOf(response), clientFacts(request.header("X-TYL-Client"), request.header("X-TYL-Locale")));
    } catch (error) {
      console.warn("Statistics not counted", error);
    }
  });
}

// ---------------------------------------------------------------- client batches (stage 2)

export function gateId(day: Day, platform: Platform, uid: string): string {
  return createHash("sha256").update(`${day}|${platform}|${uid}`).digest("hex");
}

/**
 * `POST /lists/stats`: a client's batch. 204 when counted; 400 when it is not a batch; 429 past
 * MAX_BATCHES_PER_DAY from one account on one platform in a day.
 */
export async function routeClientStats(body: unknown, response: Response, uid: string, platform: Platform | null, nowMs = Date.now()): Promise<void> {
  const batch = readBatch(body);
  if (batch === null) {
    response.status(400).json({ error: "Not a statistics batch", code: "INVALID" });
    return;
  }
  const today = dayOf(nowMs);
  const where = platform ?? "other";
  const ref = getFirestore().collection(STATS_GATE).doc(today).collection("accounts").doc(gateId(today, where, uid));
  const gate = await getFirestore().runTransaction(async (transaction) => {
    const seen = await transaction.get(ref);
    const batches = Number(seen.get("batches") ?? 0);
    if (batches >= MAX_BATCHES_PER_DAY) return null;
    const counted = new Set<string>((seen.get("steps") as string[] | undefined) ?? []);
    const wasActive = seen.get("active") === true;
    const hadCrash = seen.get("crashed") === true;
    const newSteps = batch.steps.filter((step) => !counted.has(step));
    const firstToday = batch.active !== null && !wasActive;
    const firstCrashToday = batch.crashedSessions > 0 && !hadCrash;
    transaction.set(ref, {
      batches: batches + 1,
      steps: [...counted, ...newSteps],
      active: wasActive || firstToday,
      crashed: hadCrash || firstCrashToday,
    });
    return { firstToday, newSteps: newSteps as Step[], firstCrashToday };
  });
  if (gate === null) {
    response.status(429).json({ error: "Enough statistics for today", code: "TOO_MANY" });
    return;
  }
  record(tallyOfBatch(batch, today, gate), platform, { version: batch.version, language: batch.language, region: batch.region }, nowMs);
  response.status(204).send();
}

// ---------------------------------------------------------------- the nightly housekeeping

export interface AccountCounts {
  total: number;
  new1: number;
  active1: number;
  active7: number;
  active30: number;
}

export function emptyAccounts(): AccountCounts {
  return { total: 0, new1: 0, active1: 0, active7: 0, active30: 0 };
}

/** Adds one Auth account to the night's counts: a guest has no provider. Its last token refresh is its last use. */
export function countAccount(into: { guests: AccountCounts; google: AccountCounts }, user: { providerCount: number; createdMs: number; lastUsedMs: number }, nowMs: number): void {
  const counts = user.providerCount === 0 ? into.guests : into.google;
  const day = 86_400_000;
  counts.total++;
  if (nowMs - user.createdMs < day) counts.new1++;
  if (nowMs - user.lastUsedMs < day) counts.active1++;
  if (nowMs - user.lastUsedMs < 7 * day) counts.active7++;
  if (nowMs - user.lastUsedMs < 30 * day) counts.active30++;
}

export async function saveAccountCounts(counts: { guests: AccountCounts; google: AccountCounts }, complete: boolean, nowMs: number): Promise<void> {
  await getFirestore().collection(STATS_ACCOUNTS).doc(dayOf(nowMs)).set({ asOf: new Date(nowMs).toISOString(), complete, ...counts });
}

/** Removes yesterday's gates and searches older than SEARCH_KEEP_DAYS. */
export async function sweepStats(nowMs: number): Promise<{ gates: number; searchDays: number }> {
  const db = getFirestore();
  const today = dayOf(nowMs);
  const oldestSearch = addDays(today, -SEARCH_KEEP_DAYS + 1);
  let gates = 0;
  let searchDays = 0;
  for (const ref of await db.collection(STATS_GATE).listDocuments()) {
    if (ref.id < today) {
      await db.recursiveDelete(ref);
      gates++;
    }
  }
  for (const ref of await db.collection(STATS_TOP).listDocuments()) {
    if (ref.id >= oldestSearch) continue;
    for (const kind of SEARCH_KINDS) await db.recursiveDelete(ref.collection(kind));
    searchDays++;
  }
  return { gates, searchDays };
}

// ---------------------------------------------------------------- the admin screen

export const CRASHLYTICS_URL = "https://console.firebase.google.com/project/tieryourlife/crashlytics";
export const PLAY_CONSOLE_URL = "https://play.google.com/console/developers";
export const SEARCH_CONSOLE_URL = "https://search.google.com/search-console";
const MAX_SPAN_DAYS = 366;
const TOP_PER_DAY = 100;
const TOP_SHOWN = 100;
const TOP_DAYS = 90;

export type PlatformFilter = Platform | "all";

export interface StatsPeriod {
  from: Day;
  to: Day;
  platform: PlatformFilter;
  compare: boolean;
}

/** The period asked for, or why not: `from`/`to` are UTC days, at most a year apart, not after today. */
export function periodOf(query: Record<string, unknown>, nowMs: number): StatsPeriod | string {
  const today = dayOf(nowMs);
  const to = query.to === undefined ? today : query.to;
  const from = query.from === undefined ? addDays(typeof to === "string" && isDay(to) ? to : today, -6) : query.from;
  if (!isDay(from) || !isDay(to)) return "from and to are days, YYYY-MM-DD";
  if (from > to) return "from is after to";
  if (to > today) return "to is after today";
  if (daysBetween(from, to) + 1 > MAX_SPAN_DAYS) return `at most ${MAX_SPAN_DAYS} days`;
  const platform = query.platform === undefined || query.platform === "all" ? "all" : query.platform;
  if (platform !== "all" && !["android", "web", "ios", "other"].includes(platform as string)) return "platform is all, android, web, ios or other";
  return { from, to, platform: platform as PlatformFilter, compare: query.compare === "1" || query.compare === "true" };
}

async function readSums(from: Day, to: Day): Promise<Map<Day, DaySums>> {
  const snapshot = await getFirestore().collection(STATS_DAYS).where("day", ">=", from).where("day", "<=", to).get();
  const sums = new Map<Day, DaySums>();
  for (const doc of snapshot.docs) {
    const day = doc.get("day") as Day;
    const into = sums.get(day) ?? {};
    for (const [key, n] of Object.entries((doc.get("c") as Record<string, number> | undefined) ?? {})) into[key] = (into[key] ?? 0) + Number(n);
    sums.set(day, into);
  }
  return sums;
}

const TOP_ORDER: Record<TopKind, string[]> = {
  lists: ["views", "takes"],
  topics: ["opens", "follows"],
  sections: ["opens"],
  pictureSearch: ["n", "miss"],
  listSearch: ["n", "miss"],
  crashes: ["n"],
  referrers: ["n"],
};

async function readTop(kind: TopKind, days: readonly Day[]): Promise<Map<string, Record<string, unknown>>> {
  const db = getFirestore();
  const merged = new Map<string, Record<string, unknown>>();
  const reads = days.flatMap((day) =>
    TOP_ORDER[kind].map((field) => db.collection(STATS_TOP).doc(day).collection(kind).orderBy(field, "desc").limit(TOP_PER_DAY).get().then((snapshot) => ({ day, snapshot }))),
  );
  const seen = new Set<string>();
  for (const { day, snapshot } of await Promise.all(reads)) {
    for (const doc of snapshot.docs) {
      const once = `${day}/${doc.id}`;
      if (seen.has(once)) continue;
      seen.add(once);
      const data = doc.data();
      const row = merged.get(doc.id) ?? { first: day, last: day };
      for (const [field, value] of Object.entries(data)) {
        if (typeof value === "number") row[field] = (Number(row[field] ?? 0)) + value;
        else row[field] = value;
      }
      if (day < String(row.first)) row.first = day;
      if (day > String(row.last)) row.last = day;
      merged.set(doc.id, row);
    }
  }
  return merged;
}

function ranked(rows: Iterable<Record<string, unknown>>, field: string, atLeast = 1): Record<string, unknown>[] {
  return [...rows]
    .filter((row) => Number(row[field] ?? 0) >= atLeast)
    .sort((a, b) => Number(b[field] ?? 0) - Number(a[field] ?? 0))
    .slice(0, TOP_SHOWN);
}

function change(now: number | null, before: number | null): number | null {
  return now === null || before === null || before === 0 ? null : (now - before) / before;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

interface Tiles {
  mau: number;
  dauAverage: number | null;
  newcomers: number;
  d7: number | null;
  published: number;
  crashFreeUsers: number | null;
  crashFreeSessions: number | null;
}

function tilesOf(sums: Map<Day, DaySums>, days: readonly Day[], platform: PlatformFilter, today: Day): Tiles {
  const active = total(sums, days, "active", platform);
  const weeks = [...new Set(days.map(weekOf))];
  const kept = retention(sums, weeks, platform, today).filter((row) => row.d7 !== null);
  const size = kept.reduce((n, row) => n + row.size, 0);
  return {
    mau: activeInWindow(sums, days[days.length - 1]!, 30, platform),
    dauAverage: days.length === 0 ? null : active / days.length,
    newcomers: total(sums, days, "step.first_launch", platform),
    d7: size === 0 ? null : kept.reduce((n, row) => n + row.d7! * row.size, 0) / size,
    published: total(sums, days, "list.publish", platform),
    crashFreeUsers: active === 0 ? null : 1 - total(sums, days, "active.crashed", platform) / active,
    crashFreeSessions: ratio(total(sums, days, "sessions", platform) - total(sums, days, "sessions.crashed", platform), total(sums, days, "sessions", platform)),
  };
}

const DAILY_EVENTS = ["active", "step.first_launch", "sessions", "sessions.crashed", "list.view", "list.take", "list.publish", "search.pictures", "search.pictures.miss", "search.lists", "search.lists.miss", "account.erased", "server.5xx", "server.appCheckRefused", "server.searchLimit"] as const;

export async function readStatsAnswer(period: StatsPeriod, nowMs: number): Promise<Record<string, unknown>> {
  const today = dayOf(nowMs);
  const days = daysFrom(period.from, period.to);
  const span = days.length;
  const previous = period.compare ? { from: addDays(period.from, -span), to: addDays(period.from, -1) } : null;
  const previousDays = previous ? daysFrom(previous.from, previous.to) : [];
  // Back far enough for a month of activity before either period's end, on far enough for day 30 of its cohorts.
  const readFrom = [period.from, addDays(period.to, -29), ...(previous ? [previous.from, addDays(previous.to, -29)] : [])].sort()[0]!;
  const readTo = addDays(period.to, 37) > today ? today : addDays(period.to, 37);
  const [sums, accounts, ...tops] = await Promise.all([
    readSums(readFrom, readTo),
    getFirestore().collection(STATS_ACCOUNTS).where("asOf", "<=", `${period.to}T23:59:59.999Z`).orderBy("asOf", "desc").limit(1).get(),
    // The top blocks read a query per day and kind, so they cover the period's last TOP_DAYS days at most.
    ...(["lists", "topics", "sections", "pictureSearch", "listSearch", "crashes", "referrers"] as TopKind[]).map((kind) =>
      readTop(kind, days.slice(-TOP_DAYS).filter((day) => !SEARCH_KINDS.includes(kind) || day >= addDays(today, -SEARCH_KEEP_DAYS + 1))),
    ),
  ]);
  const [lists, topics, sections, pictureSearch, listSearch, crashes, referrers] = tops as Map<string, Record<string, unknown>>[];
  const p = period.platform;
  const tiles = tilesOf(sums, days, p, today);
  const before = previous ? tilesOf(sums, previousDays, p, today) : null;
  const totals = (ofDays: readonly Day[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const day of ofDays) {
      for (const [key, n] of Object.entries(sums.get(day) ?? {})) {
        const parts = splitKey(key);
        const plain = p === "all" ? parts.dimension === null : parts.dimension === "p" && parts.value === p && parts.rest === null;
        if (plain && !parts.event.startsWith("active.gap") && !parts.event.startsWith("ret")) out[parts.event] = (out[parts.event] ?? 0) + n;
      }
    }
    return out;
  };
  const listRows = ranked(lists!.values(), "views");
  const titles = await titlesOf(listRows.slice(0, 50).map((row) => String(row.id)), "publishedLists", "title");
  const topicRows = ranked(topics!.values(), "opens");
  const topicNames = await titlesOf(topicRows.slice(0, 50).map((row) => String(row.id)), "topics", "name");
  const cohortWeeks = [...new Set(days.map(weekOf))].filter((week) => weekStart(week)! >= addDays(period.from, -6));
  return {
    period: { from: period.from, to: period.to, days: span, todayIsPartial: period.to === today, platform: p },
    previous,
    tiles: Object.fromEntries(Object.entries(tiles).map(([name, value]) => [name, { value, previous: before ? before[name as keyof Tiles] : null, change: before ? change(value as number | null, before[name as keyof Tiles] as number | null) : null }])),
    daily: days.map((day) => ({
      day,
      ...Object.fromEntries(DAILY_EVENTS.map((event) => [event, total(sums, [day], event, p)])),
      ...(p === "all" ? Object.fromEntries((["android", "web"] as Platform[]).map((one) => [`active.${one}`, total(sums, [day], "active", one)])) : {}),
    })),
    totals: totals(days),
    previousTotals: previous ? totals(previousDays) : null,
    funnel: STEPS.map((step) => ({ step, n: total(sums, days, `step.${step}`, p) })),
    retention: retention(sums, cohortWeeks, p, today),
    rolling: { asOf: period.to, dau: total(sums, [period.to], "active", p), wau: activeInWindow(sums, period.to, 7, p), mau: activeInWindow(sums, period.to, 30, p) },
    audience: {
      versions: cutBy(sums, days, "active", "v"),
      languages: cutBy(sums, days, "active", "l"),
      regions: cutBy(sums, days, "active", "r"),
      accounts: accounts.empty ? null : accounts.docs[0]!.data(),
    },
    top: {
      lists: listRows.map((row) => ({ id: row.id, title: titles.get(String(row.id)) ?? null, views: row.views ?? 0, takes: row.takes ?? 0 })),
      topics: topicRows.map((row) => ({ id: row.id, name: topicNames.get(String(row.id)) ?? null, opens: row.opens ?? 0, follows: row.follows ?? 0 })),
      sections: ranked(sections!.values(), "opens").map((row) => ({ id: row.id, opens: row.opens ?? 0 })),
      pictureSearch: ranked(pictureSearch!.values(), "n", SEARCH_SHOWN_FROM).map((row) => ({ q: row.q, section: row.section ?? "", n: row.n ?? 0, miss: row.miss ?? 0 })),
      pictureMisses: ranked(pictureSearch!.values(), "miss", SEARCH_SHOWN_FROM).map((row) => ({ q: row.q, section: row.section ?? "", n: row.n ?? 0, miss: row.miss ?? 0 })),
      listSearch: ranked(listSearch!.values(), "n", SEARCH_SHOWN_FROM).map((row) => ({ q: row.q, n: row.n ?? 0, miss: row.miss ?? 0 })),
      listMisses: ranked(listSearch!.values(), "miss", SEARCH_SHOWN_FROM).map((row) => ({ q: row.q, n: row.n ?? 0, miss: row.miss ?? 0 })),
      crashes: ranked(crashes!.values(), "n").map((row) => ({ type: row.type, place: row.place, version: row.version, n: row.n ?? 0, first: row.first, last: row.last })),
      referrers: ranked(referrers!.values(), "n").map((row) => ({ domain: row.domain, utm: row.utm, n: row.n ?? 0 })),
    },
    links: { crashlytics: CRASHLYTICS_URL, playConsole: PLAY_CONSOLE_URL, searchConsole: SEARCH_CONSOLE_URL },
  };
}

async function titlesOf(ids: string[], collection: string, field: string): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = getFirestore();
  const docs = await db.getAll(...ids.map((id) => db.collection(collection).doc(id)));
  const out = new Map<string, string>();
  for (const doc of docs) {
    const value = doc.get(field);
    if (typeof value === "string") out.set(doc.id, value);
    else if (value && typeof value === "object") {
      const first = Object.values(value as Record<string, unknown>).find((one) => typeof one === "string");
      if (typeof first === "string") out.set(doc.id, first);
    }
  }
  return out;
}

export const CSV_BLOCKS = ["daily", "totals", "funnel", "retention", "lists", "topics", "sections", "pictureSearch", "pictureMisses", "listSearch", "listMisses", "crashes", "referrers", "versions", "languages", "regions"] as const;

/** One block of an answer as CSV, or null for a block that is not one. */
export function csvOf(answer: Record<string, unknown>, block: string): string | null {
  const a = answer as { daily: Record<string, unknown>[]; totals: Record<string, number>; previousTotals: Record<string, number> | null; funnel: Record<string, unknown>[]; retention: Record<string, unknown>[]; top: Record<string, Record<string, unknown>[]>; audience: Record<string, { value: string; n: number }[]> };
  const rowsWithColumns = (rows: Record<string, unknown>[]): string => toCsv(rows, rows.length > 0 ? Object.keys(rows[0]!) : ["empty"]);
  switch (block) {
    case "daily":
      return rowsWithColumns(a.daily);
    case "totals":
      return toCsv(Object.entries(a.totals).sort().map(([event, n]) => ({ event, n, previous: a.previousTotals?.[event] ?? "" })), ["event", "n", "previous"]);
    case "funnel":
      return toCsv(a.funnel, ["step", "n"]);
    case "retention":
      return toCsv(a.retention, ["week", "size", "d1", "d7", "d30"]);
    case "versions":
    case "languages":
    case "regions":
      return toCsv(a.audience[block] ?? [], ["value", "n"]);
    default:
      return (CSV_BLOCKS as readonly string[]).includes(block) ? rowsWithColumns(a.top[block] ?? []) : null;
  }
}

/** `GET /lists/admin/stats`: the owner only. */
export async function routeAdminStats(query: Record<string, unknown>, response: Response, isOwner: boolean, nowMs = Date.now()): Promise<void> {
  if (!isOwner) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const period = periodOf(query, nowMs);
  if (typeof period === "string") {
    response.status(400).json({ error: period, code: "INVALID" });
    return;
  }
  const answer = await readStatsAnswer(period, nowMs);
  response.setHeader("Cache-Control", "private, no-store");
  if (query.format === "csv") {
    const block = typeof query.block === "string" ? query.block : "";
    const csv = csvOf(answer, block);
    if (csv === null) {
      response.status(400).json({ error: `block is one of ${CSV_BLOCKS.join(", ")}`, code: "INVALID" });
      return;
    }
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="tieryourlife-${block}-${period.from}-${period.to}.csv"`);
    response.status(200).send(csv);
    return;
  }
  response.status(200).json(answer);
}
