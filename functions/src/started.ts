/**
 * Somebody else's lists an account began to place, kept with the account so
 * "Continue" is the same on the phone and the website (Danylo, 18.11.2026;
 * `_coordination/shared-continue-2026-11-18/SPEC.md`, its contract section).
 * One document per list at `accounts/{uid}/started/{listId}`: the placing,
 * what Continue names it by, and a game saved over it, stored the way a
 * board's game is. A list taken out of Continue leaves a mark with a reason,
 * so every device takes it out; Undo writes it back based on that mark.
 * Whoever changed it later on their device wins a disagreement, and the other
 * is handed what the account keeps rather than losing it silently.
 */
import { getFirestore, type DocumentReference } from "firebase-admin/firestore";
import type { Response } from "express";
import { ERASED_ACCOUNTS, type Identity } from "./auth";
import {
  livePlay,
  MAX_BOARD_BYTES,
  MAX_ITEMS_PER_BOARD,
  MAX_TIERS_PER_BOARD,
  MAX_URL_LENGTH,
  PLAY_LIFETIME_MS,
  playFromDocument,
  playToDocument,
  readPlay,
  type Play,
} from "./sync";

export const STARTED_PATH = "started";
export const MAX_STARTED_PER_ACCOUNT = 50;
export const MAX_STARTED_TITLE_LENGTH = 200;
export const MAX_STARTED_CATEGORY_LENGTH = 64;
export const MAX_STARTED_LABEL_LENGTH = 60;
export const MAX_STARTED_PICTURES = 3;
/** A device clock this far ahead of the server's is taken as the server's. */
export const CLOCK_AHEAD_MS = 5 * 60 * 1000;
/** A removal mark is kept as long as a saved game would be: every device has synced by then or starts afresh. */
export const STARTED_MARK_LIFETIME_MS = PLAY_LIFETIME_MS;

export const REMOVAL_REASONS = ["discard", "saved", "done"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number] | "evicted";

/** What a device sends for one begun list, checked. */
export interface StartedContent {
  listVersion: number;
  itemCount: number;
  tierCount: number;
  title: string;
  picture: string | null;
  pictures: string[];
  category: string | null;
  rows: number[][];
  labels?: (string | null)[];
  poolOrder?: number[];
  play: Play | null;
}

export type StartedBody =
  | { ok: true; basedOn: number | null; changedAt: number; content: StartedContent }
  | { ok: false; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const isPictureUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_URL_LENGTH && /^https:\/\/\S+$/.test(value);

export function readListId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

/** A device's time of change, at most a little ahead of the server's. */
export function changedAtOf(value: unknown, nowMs: number): number | null {
  if (!isWhole(value, 1, Number.MAX_SAFE_INTEGER)) return null;
  return value > nowMs + CLOCK_AHEAD_MS ? nowMs : value;
}

/** Card numbers below [count], none twice across [lists]; null when any is not. */
function distinctIndexes(lists: unknown[], count: number, seen = new Set<number>()): number[][] | null {
  const read: number[][] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) return null;
    for (const index of list) {
      if (!isWhole(index, 0, count - 1) || seen.has(index)) return null;
      seen.add(index);
    }
    read.push([...(list as number[])]);
  }
  return read;
}

/**
 * A game over a list names its cards by their places in it ("0", "17") and
 * its tiers by theirs, the pool as "pool": the shared form both devices read.
 */
function listPlay(value: unknown, itemCount: number, tierCount: number): Play | null | "invalid" {
  if (value === undefined || value === null) return null;
  const play = readPlay(value);
  if (play === null) return "invalid";
  const place = (id: string, below: number) => /^(0|[1-9]\d*)$/.test(id) && Number(id) < below;
  if (!play.ids.every((id) => place(id, itemCount))) return "invalid";
  if (play.scope !== undefined && !play.scope.every((tier) => tier === "pool" || place(tier, tierCount))) return "invalid";
  return play;
}

/** A PUT's body, read strictly: anything not as the contract says is refused by the field's name. */
export function readStartedBody(body: unknown, nowMs: number): StartedBody {
  if (!isRecord(body)) return { ok: false, detail: "body" };
  const basedOn = body.basedOn === undefined || body.basedOn === null ? null : body.basedOn;
  if (basedOn !== null && !isWhole(basedOn, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, detail: "basedOn" };
  const changedAt = changedAtOf(body.changedAt, nowMs);
  if (changedAt === null) return { ok: false, detail: "changedAt" };
  if (!isWhole(body.listVersion, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, detail: "listVersion" };
  if (!isWhole(body.itemCount, 1, MAX_ITEMS_PER_BOARD)) return { ok: false, detail: "itemCount" };
  if (!isWhole(body.tierCount, 1, MAX_TIERS_PER_BOARD)) return { ok: false, detail: "tierCount" };
  const { itemCount, tierCount } = body;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 1 || title.length > MAX_STARTED_TITLE_LENGTH) return { ok: false, detail: "title" };
  const picture = body.picture === undefined || body.picture === null ? null : body.picture;
  if (picture !== null && !isPictureUrl(picture)) return { ok: false, detail: "picture" };
  const pictures = body.pictures === undefined || body.pictures === null ? [] : body.pictures;
  if (!Array.isArray(pictures) || pictures.length > MAX_STARTED_PICTURES || !pictures.every(isPictureUrl)) {
    return { ok: false, detail: "pictures" };
  }
  const category = body.category === undefined || body.category === null ? null : body.category;
  if (category !== null && (typeof category !== "string" || category.length < 1 || category.length > MAX_STARTED_CATEGORY_LENGTH)) {
    return { ok: false, detail: "category" };
  }
  if (!Array.isArray(body.rows) || body.rows.length !== tierCount) return { ok: false, detail: "rows" };
  const placed = new Set<number>();
  const rows = distinctIndexes(body.rows, itemCount, placed);
  if (rows === null) return { ok: false, detail: "rows" };
  let labels: (string | null)[] | undefined;
  if (body.labels !== undefined && body.labels !== null) {
    if (!Array.isArray(body.labels) || body.labels.length !== tierCount) return { ok: false, detail: "labels" };
    labels = [];
    for (const label of body.labels) {
      if (label === null) labels.push(null);
      else if (typeof label === "string" && label.length <= MAX_STARTED_LABEL_LENGTH) labels.push(label.trim() === "" ? null : label);
      else return { ok: false, detail: "labels" };
    }
  }
  let poolOrder: number[] | undefined;
  if (body.poolOrder !== undefined && body.poolOrder !== null) {
    const read = Array.isArray(body.poolOrder) ? distinctIndexes([body.poolOrder], itemCount) : null;
    if (read === null) return { ok: false, detail: "poolOrder" };
    poolOrder = read[0];
  }
  const play = listPlay(body.play, itemCount, tierCount);
  if (play === "invalid") return { ok: false, detail: "play" };
  return {
    ok: true,
    basedOn,
    changedAt,
    content: {
      listVersion: body.listVersion,
      itemCount,
      tierCount,
      title,
      picture,
      pictures: [...(pictures as string[])],
      category,
      rows,
      ...(labels === undefined ? {} : { labels }),
      ...(poolOrder === undefined ? {} : { poolOrder }),
      play,
    },
  };
}

/** What is known of a stored entry to settle a write: its version and when its device changed it. */
export interface Settled {
  updatedAt: number;
  changedAt: number;
}

/**
 * Whether a write lands. Nothing stored, or the version the device started
 * from, lands; so does a change made later on its device than the stored one
 * was (two devices apart, or a guest's placing brought in at sign-in).
 */
export function decideStartedWrite(stored: Settled | null, basedOn: number | null, changedAt: number): "write" | "conflict" {
  if (stored === null) return "write";
  if (basedOn !== null && basedOn === stored.updatedAt) return "write";
  return changedAt > stored.changedAt ? "write" : "conflict";
}

/** A removal lands the same way; one already removed is answered with its mark. */
export function decideRemoval(
  stored: (Settled & { removed?: RemovalReason | null }) | null,
  basedOn: number | null,
  changedAt: number,
): "write" | "already" | "conflict" {
  if (stored !== null && stored.removed) return "already";
  if (stored === null) return "write";
  if (basedOn !== null && basedOn === stored.updatedAt) return "write";
  return changedAt >= stored.changedAt ? "write" : "conflict";
}

/** A version that only grows: the server's time, or one past the last when the clock has not moved on. */
export function nextVersion(previous: number | null, nowMs: number): number {
  return previous === null ? nowMs : Math.max(nowMs, previous + 1);
}

/**
 * The begun lists a new one pushes out: with [incoming] added, the oldest by
 * their device's time beyond [max], never [incoming] itself.
 */
export function evicted(live: readonly { listId: string; changedAt: number }[], incoming: string, max = MAX_STARTED_PER_ACCOUNT): string[] {
  const others = live.filter((one) => one.listId !== incoming);
  const over = others.length + 1 - max;
  if (over <= 0) return [];
  return [...others].sort((a, b) => a.changedAt - b.changedAt || a.listId.localeCompare(b.listId)).slice(0, over).map((one) => one.listId);
}

export const placedOf = (rows: readonly (readonly number[])[]): number => rows.reduce((sum, row) => sum + row.length, 0);

/** Firestore keeps no array inside an array: each row is kept as `{c: [...]}`. */
export interface StartedDocument {
  updatedAt: number;
  changedAt: number;
  /** null while the list is in Continue, so the live ones can be counted by a query. */
  removed: RemovalReason | null;
  listVersion?: number;
  itemCount?: number;
  tierCount?: number;
  title?: string;
  picture?: string | null;
  pictures?: string[];
  category?: string | null;
  rows?: { c: number[] }[];
  labels?: (string | null)[];
  poolOrder?: number[];
  play?: unknown;
}

export function toStartedDocument(content: StartedContent, updatedAt: number, changedAt: number, nowMs: number): StartedDocument {
  const { rows, play, labels, poolOrder, ...rest } = content;
  return {
    updatedAt,
    changedAt,
    removed: null,
    ...rest,
    rows: rows.map((c) => ({ c })),
    ...(labels === undefined ? {} : { labels }),
    ...(poolOrder === undefined ? {} : { poolOrder }),
    play: play === null ? null : playToDocument(play, nowMs),
  };
}

export const removalDocument = (reason: RemovalReason, updatedAt: number, changedAt: number): StartedDocument => ({ updatedAt, changedAt, removed: reason });

export type StartedWire =
  | ({ listId: string; updatedAt: number; changedAt: number; placed: number; play: Play | null } & Omit<StartedContent, "play">)
  | { listId: string; updatedAt: number; changedAt: number; removed: RemovalReason };

/** An entry as a device is told it: rows unpacked, a game a month untouched no longer there. */
export function toStartedWire(listId: string, stored: StartedDocument, nowMs: number): StartedWire {
  if (stored.removed) return { listId, updatedAt: stored.updatedAt, changedAt: stored.changedAt, removed: stored.removed };
  const rows = (stored.rows ?? []).map((row) => [...(row.c ?? [])]);
  return {
    listId,
    updatedAt: stored.updatedAt,
    changedAt: stored.changedAt,
    listVersion: stored.listVersion ?? 0,
    itemCount: stored.itemCount ?? 0,
    tierCount: stored.tierCount ?? rows.length,
    title: stored.title ?? "",
    picture: stored.picture ?? null,
    pictures: stored.pictures ?? [],
    category: stored.category ?? null,
    rows,
    ...(stored.labels === undefined ? {} : { labels: stored.labels }),
    ...(stored.poolOrder === undefined ? {} : { poolOrder: stored.poolOrder }),
    placed: placedOf(rows),
    play: livePlay(playFromDocument(stored.play), nowMs),
  };
}

export function readRemovalReason(value: unknown): (typeof REMOVAL_REASONS)[number] | null {
  return REMOVAL_REASONS.find((reason) => reason === value) ?? null;
}

const single = (raw: unknown): string | null =>
  typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;

const startedOf = (uid: string) => getFirestore().collection("accounts").doc(uid).collection(STARTED_PATH);

/** Everything under /boards/started, the caller's own begun lists only. */
export async function startedRoute(
  request: { method: string; body: unknown; query: Record<string, unknown> },
  response: Response,
  identity: Identity,
  segments: readonly string[],
): Promise<void> {
  if (identity.isAnonymous) {
    return void response.status(403).json({ error: "Sign in to keep begun lists with your account", code: "NOT_SIGNED_IN" });
  }
  if (segments.length > 2) return void response.status(404).json({ error: "No such address", code: "NOT_FOUND" });
  const listId = segments.length === 2 ? readListId(segments[1]) : null;
  if (segments.length === 2 && listId === null) return void response.status(400).json({ error: "Which list?", code: "INVALID", detail: "listId" });

  if (listId === null) {
    if (request.method !== "GET") return void response.status(405).json({ error: "Use GET" });
    return await readAll(response, identity, single(request.query.since));
  }
  switch (request.method) {
    case "GET":
      return await readOne(response, identity, listId);
    case "PUT":
      return await writeOne(response, identity, listId, request.body);
    case "DELETE":
      return await removeOne(response, identity, listId, request.query);
    default:
      return void response.status(405).json({ error: "Use GET, PUT or DELETE" });
  }
}

async function readAll(response: Response, identity: Identity, sinceRaw: string | null): Promise<void> {
  let since: number | null = null;
  if (sinceRaw !== null) {
    if (!/^\d{1,16}$/.test(sinceRaw)) return void response.status(400).json({ error: "since is a version", code: "INVALID", detail: "since" });
    since = Number(sinceRaw);
  }
  const now = Date.now();
  const collection = startedOf(identity.uid);
  const snapshot = since === null ? await collection.get() : await collection.where("updatedAt", ">", since).get();
  const started: StartedWire[] = [];
  const removed: StartedWire[] = [];
  const outdated: DocumentReference[] = [];
  for (const doc of snapshot.docs) {
    const stored = doc.data() as StartedDocument;
    if (stored.removed && now - stored.updatedAt > STARTED_MARK_LIFETIME_MS) {
      outdated.push(doc.ref);
      continue;
    }
    (stored.removed ? removed : started).push(toStartedWire(doc.id, stored, now));
  }
  // Marks a month old have done their work; they go as they are read.
  if (outdated.length > 0) {
    const batch = getFirestore().batch();
    outdated.slice(0, 400).forEach((ref) => batch.delete(ref));
    await batch.commit().catch((error) => console.warn("Old begun-list marks not removed", error));
  }
  const newestFirst = (a: StartedWire, b: StartedWire) => b.changedAt - a.changedAt;
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ started: started.sort(newestFirst), removed: removed.sort(newestFirst), now });
}

async function readOne(response: Response, identity: Identity, listId: string): Promise<void> {
  const doc = await startedOf(identity.uid).doc(listId).get();
  response.setHeader("Cache-Control", "no-store");
  if (!doc.exists) return void response.status(404).json({ error: "No such begun list", code: "NOT_FOUND" });
  response.status(200).json(toStartedWire(listId, doc.data() as StartedDocument, Date.now()));
}

type Answer = { status: number; body: object };

const erasedAnswer: Answer = { status: 401, body: { error: "This account was deleted", code: "ACCOUNT_ERASED" } };

async function writeOne(response: Response, identity: Identity, listId: string, body: unknown): Promise<void> {
  const now = Date.now();
  const read = readStartedBody(body, now);
  if (!read.ok) return void response.status(400).json({ error: "That is not a begun list", code: "INVALID", detail: read.detail });
  const db = getFirestore();
  const collection = startedOf(identity.uid);
  const ref = collection.doc(listId);
  const answer = await db.runTransaction(async (transaction): Promise<Answer> => {
    if ((await transaction.get(db.collection(ERASED_ACCOUNTS).doc(identity.uid))).exists) return erasedAnswer;
    const existing = await transaction.get(ref);
    const stored = existing.exists ? (existing.data() as StartedDocument) : null;
    if (decideStartedWrite(stored, read.basedOn, read.changedAt) === "conflict") {
      return { status: 409, body: { error: "This list moved on on another device", code: "CONFLICT", started: toStartedWire(listId, stored!, now) } };
    }
    const updatedAt = nextVersion(stored?.updatedAt ?? null, now);
    const document = toStartedDocument(read.content, updatedAt, read.changedAt, now);
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_BOARD_BYTES) {
      return { status: 413, body: { error: "This begun list is too large to keep", code: "TOO_LARGE" } };
    }
    // A list coming back into Continue counts against the fifty; the oldest beyond them go, as marks.
    if (stored === null || stored.removed) {
      const live = await transaction.get(collection.where("removed", "==", null).select("changedAt", "updatedAt"));
      const versionOf = new Map(live.docs.map((doc) => [doc.id, doc.get("updatedAt") as number]));
      const pushedOut = evicted(live.docs.map((doc) => ({ listId: doc.id, changedAt: doc.get("changedAt") as number })), listId);
      for (const id of pushedOut) {
        transaction.set(collection.doc(id), removalDocument("evicted", nextVersion(versionOf.get(id) ?? null, now), now));
      }
    }
    transaction.set(ref, document);
    return { status: 200, body: { listId, updatedAt, placed: placedOf(read.content.rows) } };
  });
  response.status(answer.status).json(answer.body);
}

async function removeOne(response: Response, identity: Identity, listId: string, query: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const reason = readRemovalReason(single(query.reason));
  if (reason === null) return void response.status(400).json({ error: "reason is discard, saved or done", code: "INVALID", detail: "reason" });
  const basedOnRaw = single(query.basedOn);
  if (basedOnRaw !== null && !/^\d{1,16}$/.test(basedOnRaw)) return void response.status(400).json({ error: "basedOn is a version", code: "INVALID", detail: "basedOn" });
  const changedRaw = single(query.changedAt);
  const changedAt = changedRaw === null ? now : /^\d{1,16}$/.test(changedRaw) ? changedAtOf(Number(changedRaw), now) : null;
  if (changedAt === null) return void response.status(400).json({ error: "changedAt is a time in milliseconds", code: "INVALID", detail: "changedAt" });
  const basedOn = basedOnRaw === null ? null : Number(basedOnRaw);
  const db = getFirestore();
  const ref = startedOf(identity.uid).doc(listId);
  const answer = await db.runTransaction(async (transaction): Promise<Answer> => {
    if ((await transaction.get(db.collection(ERASED_ACCOUNTS).doc(identity.uid))).exists) return erasedAnswer;
    const existing = await transaction.get(ref);
    const stored = existing.exists ? (existing.data() as StartedDocument) : null;
    const verdict = decideRemoval(stored, basedOn, changedAt);
    if (verdict === "already") return { status: 200, body: { listId, updatedAt: stored!.updatedAt, removed: stored!.removed } };
    if (verdict === "conflict") {
      return { status: 409, body: { error: "This list moved on on another device", code: "CONFLICT", started: toStartedWire(listId, stored!, now) } };
    }
    const updatedAt = nextVersion(stored?.updatedAt ?? null, now);
    transaction.set(ref, removalDocument(reason, updatedAt, changedAt));
    return { status: 200, body: { listId, updatedAt, removed: reason } };
  });
  response.status(answer.status).json(answer.body);
}
