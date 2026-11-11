import { onRequest } from "firebase-functions/v2/https";
import { FieldPath, FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { ERASED_ACCOUNTS, requireUser, type Identity } from "./auth";
import { eraseAccount } from "./erase";
import {
  BOARD_PAGE_SIZE,
  MAX_BOARDS_PER_ACCOUNT,
  MAX_BOARD_BYTES,
  cleanDeviceName,
  decideStore,
  decideWrite,
  displayModeOf,
  livePlay,
  playFromDocument,
  playToDocument,
  playAfterWrite,
  preservedPlayFingerprint,
  type StoreRejection,
  type StoredBoard,
  type StoredPlay,
} from "./sync";

/**
 * The copy of someone's boards that outlives their phone, written here rather
 * than by the app talking to Firestore: `firestore.rules` deny everything on
 * purpose.
 *
 *   accounts/{uid}/boards/{boardUid}
 *
 * The board's uid is the device's own, so the same board from two phones
 * lands on one document.
 */

const ACCOUNTS = "accounts";
const BOARDS = "boards";

/** Not a board: the whole account, and everything this service holds about it. */
const ACCOUNT = "account";

interface BoardDocument extends Partial<Omit<StoredBoard, "play">> {
  /** A game under way, its answers stored flat; see `playToDocument`. */
  play?: StoredPlay;
  /** Only a large game's storage changes; the public/private API shape does not. */
  separatePlay?: true;
  /** Bumped by this file on every accepted write. Never sent by a device. */
  revision: number;
  updatedAt?: Timestamp;
  /** What the last device to write it called itself. */
  deviceName: string | null;
  /** True on a board the account has thrown away; nothing else is left. */
  deleted: boolean;
}

function refuse(response: Response, rejection: StoreRejection): void {
  switch (rejection.reason) {
    case "not_signed_in":
      response.status(403).json({ error: "Sign in to keep your boards", code: "NOT_SIGNED_IN" });
      return;
    case "too_many_boards":
      response
        .status(409)
        .json({ error: `An account keeps up to ${MAX_BOARDS_PER_ACCOUNT} boards`, code: "TOO_MANY_BOARDS" });
      return;
    case "too_large":
      response.status(413).json({ error: rejection.detail, code: "TOO_LARGE" });
      return;
    case "invalid":
      response.status(400).json({ error: rejection.detail, code: "INVALID" });
      return;
  }
}

function boardsOf(uid: string): FirebaseFirestore.CollectionReference {
  return getFirestore().collection(ACCOUNTS).doc(uid).collection(BOARDS);
}

/** The board as a device receives it. A game a month old or more is left out, as if there were none. */
export function toFullBoard(id: string, data: BoardDocument, nowMs: number = Date.now()) {
  const play = livePlay(playFromDocument(data.play), nowMs);
  return {
    uid: id,
    revision: data.revision,
    updatedAt: data.updatedAt?.toMillis() ?? 0,
    deviceName: data.deviceName ?? null,
    deleted: data.deleted === true,
    fingerprint: data.fingerprint ?? null,
    title: data.title ?? "",
    displayMode: displayModeOf(data.displayMode),
    category: data.category ?? null,
    coverImageUrl: data.coverImageUrl ?? null,
    coverImageUrls: data.coverImageUrls ?? [],
    authorName: data.authorName ?? null,
    publishedId: data.publishedId ?? null,
    deletedAt: data.deletedAt ?? null,
    tiers: data.tiers ?? [],
    items: data.items ?? [],
    ...(data.anonymous === true ? { anonymous: true } : {}),
    ...(data.coverPictureId ? { coverPictureId: data.coverPictureId } : {}),
    ...(play === null ? {} : { play }),
  };
}

/**
 * What the index names. Enough for a device to decide whether it needs the
 * board itself: which boards exist, and how far along each one is. Downloading
 * two hundred boards to find that none of them changed is the thing this
 * avoids.
 */
function toIndexEntry(id: string, data: BoardDocument) {
  return {
    uid: id,
    revision: data.revision,
    updatedAt: data.updatedAt?.toMillis() ?? 0,
    deviceName: data.deviceName ?? null,
    deleted: data.deleted === true,
    fingerprint: data.fingerprint ?? null,
    title: data.title ?? "",
    itemCount: data.items?.filter((item) => item.deletedAt === null).length ?? 0,
  };
}

export const boards = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
  },
  async (request, response) => {
    if (!(await requireAppCheck(request, response))) {
      return;
    }

    // Everything after /boards is at most one board's uid. There are no verbs
    // here: a board is read, written whole, or thrown away.
    const segments = request.path
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((part) => part !== "boards" && part.length > 0);
    const id = segments[0] ?? "";
    const hasId = id.length > 0;
    // Board ids are Firestore's twenty characters, so this word can never be
    // one, the same way "face" and "follow" cannot be a list id.
    const aboutTheAccount = id === ACCOUNT;

    const identity = await requireUser(request, response, { evenIfErased: erasesTheAccount(request.method, segments) });
    if (!identity) {
      return;
    }
    if (segments.length > 1) {
      return void response.status(404).json({ error: "No such address" });
    }

    try {
      switch (request.method) {
        case "GET":
          return hasId
            ? await readOne(response, identity, id)
            : await readIndex(response, identity, singleParam(request.query.after));
        case "PUT":
          return hasId
            ? await write(response, identity, id, request.body)
            : void response.status(400).json({ error: "Which board?" });
        case "DELETE":
          if (aboutTheAccount) {
            return await erase(response, identity);
          }
          return hasId
            ? await forget(response, identity, id)
            : void response.status(400).json({ error: "Which board?" });
        default:
          return void response.status(405).json({ error: "Use GET, PUT or DELETE" });
      }
    } catch (error) {
      console.error("Board request failed", error);
      response.status(503).json({ error: "Unavailable", code: "UNAVAILABLE" });
    }
  },
);

/** `DELETE /boards/account` and nothing else: the one write an erased account's token may still make, to finish erasing. */
export function erasesTheAccount(method: string, segments: readonly string[]): boolean {
  return method === "DELETE" && segments.length === 1 && segments[0] === ACCOUNT;
}

/**
 * Offered inside the app because Google requires an app that creates
 * accounts to let somebody end one from the same place. Refused for a guest:
 * the sweep takes an abandoned guest away by itself.
 */
async function erase(response: Response, identity: Identity): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return;
  }
  await eraseAccount(identity.uid);
  response.status(204).send();
}

function singleParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * A short page is the last one. A full page might be, and costs one empty
 * fetch to find out.
 */
export function nextCursor(pageIds: string[], pageSize: number = BOARD_PAGE_SIZE): string | null {
  return pageIds.length === pageSize ? pageIds[pageIds.length - 1] : null;
}

async function readIndex(response: Response, identity: Identity, after: string | null): Promise<void> {
  // A guest has nothing here and never will, so this is an empty answer rather
  // than a refusal: asking is what the app does on every start, and a 403 on
  // every start is an error where there is no error.
  if (identity.isAnonymous) {
    response.setHeader("Cache-Control", "no-store");
    return void response.status(200).json({ boards: [], next: null });
  }

  const collection = boardsOf(identity.uid);
  let query: FirebaseFirestore.Query = collection.orderBy(FieldPath.documentId());
  if (after) {
    query = query.startAfter(after);
  }

  const snapshot = await query.limit(BOARD_PAGE_SIZE).get();
  const entries = snapshot.docs.map((doc) => toIndexEntry(doc.id, doc.data() as BoardDocument));

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    boards: entries,
    next: nextCursor(entries.map((entry) => entry.uid)),
  });
}

async function readOne(response: Response, identity: Identity, id: string): Promise<void> {
  const board = await fullBoard(boardsOf(identity.uid).doc(id));
  if (board === null) {
    return void response.status(404).json({ error: "No such board", code: "NOT_FOUND" });
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json(board);
}

/** Read board and auxiliary game in one consistent snapshot, never quietly lose the game. */
async function fullBoard(ref: FirebaseFirestore.DocumentReference) {
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() as BoardDocument;
    return toFullBoard(snapshot.id, { ...data, play: await storedGame(transaction, ref, data) });
  });
}

async function storedGame(transaction: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference, data: BoardDocument) {
  if (!data.separatePlay) return data.play;
  const game = await transaction.get(ref.parent.parent!.collection("plays").doc(ref.id));
  if (!game.exists || game.get("revision") !== data.revision || playFromDocument(game.get("play")) === null) {
    throw new Error("The board's saved game is unavailable");
  }
  return game.get("play") as StoredPlay;
}

async function write(
  response: Response,
  identity: Identity,
  id: string,
  body: unknown,
): Promise<void> {
  const source = (body ?? {}) as Record<string, unknown>;
  const ref = boardsOf(identity.uid).doc(id);

  // Counted outside the transaction: it is a limit on hoarding, not an
  // invariant, and reading two hundred documents inside every write to
  // enforce it exactly would cost more than the hoarding it prevents.
  const kept = identity.isAnonymous
    ? 0
    : (await boardsOf(identity.uid).where("deleted", "==", false).count().get()).data().count;
  const now = Date.now();
  type Answer = { rejection: StoreRejection } | { status: number; body: object };
  const answer: Answer = await getFirestore().runTransaction(async (transaction): Promise<Answer> => {
    const erased = await transaction.get(getFirestore().collection(ERASED_ACCOUNTS).doc(identity.uid));
    if (erased.exists) return { status: 401, body: { error: "This account was deleted", code: "ACCOUNT_ERASED" } };
    const existing = await transaction.get(ref);
    const stored = existing.exists ? existing.data() as BoardDocument : null;
    const previous = stored ? await storedGame(transaction, ref, stored) : undefined;
    const decision = decideStore({ body, nowMs: now, storedCoverPictureId: stored?.coverPictureId ?? null,
      isAnonymous: identity.isAnonymous, boardsAlreadyKept: existing.exists ? kept - 1 : kept });
    if (!decision.ok) return { rejection: decision };
    if (source.play !== undefined && source.play !== null && decision.board.play === undefined) {
      return { rejection: { reason: "invalid", detail: "The saved game is invalid" } };
    }
    const before = livePlay(playFromDocument(previous), now);
    const play = playAfterWrite(source, before);
    const changedGame = JSON.stringify(before) !== JSON.stringify(play);
    const fingerprint = preservedPlayFingerprint(source, decision.board, play);
    const verdict = decideWrite(stored ? { revision: stored.revision, fingerprint: stored.fingerprint ?? null } : null,
      source.basedOn, changedGame ? null : fingerprint);
    if (verdict === "already") return { status: 200, body: { uid: id, revision: stored!.revision } };
    if (verdict === "conflict") return { status: 409, body: {
      error: "That board moved on somewhere else", code: "CONFLICT",
      board: toFullBoard(id, { ...stored!, play: previous }),
    } };
    const revision = (stored?.revision ?? 0) + 1;
    const { play: _sentPlay, ...board } = decision.board;
    const game = play === null ? null : playToDocument({ ...play, startedAt: Math.min(play.startedAt, now) }, now);
    const separate = game !== null && Buffer.byteLength(JSON.stringify({ ...board, play: game }), "utf8") > MAX_BOARD_BYTES;
    if (game !== null && Buffer.byteLength(JSON.stringify(game), "utf8") > MAX_BOARD_BYTES) {
      return { rejection: { reason: "too_large", detail: "The game is too heavy to keep" } };
    }
    transaction.set(ref, { ...board, fingerprint,
      ...(game === null ? {} : separate ? { separatePlay: true } : { play: game }),
      revision, deviceName: cleanDeviceName(source.deviceName), deleted: false, updatedAt: FieldValue.serverTimestamp() });
    const gameRef = ref.parent.parent!.collection("plays").doc(id);
    if (separate) transaction.set(gameRef, { revision, play: game });
    else if (stored?.separatePlay) transaction.delete(gameRef);
    return { status: 200, body: { uid: id, revision } };
  });
  if ("rejection" in answer) refuse(response, answer.rejection);
  else response.status(answer.status).json(answer.body);
}

/**
 * A marker rather than nothing: otherwise the other phone still has the board
 * and the next sync puts it back.
 */
async function forget(response: Response, identity: Identity, id: string): Promise<void> {
  if (identity.isAnonymous) {
    return void response.status(403).json({ error: "Sign in to keep your boards", code: "NOT_SIGNED_IN" });
  }

  const ref = boardsOf(identity.uid).doc(id);
  const erased = await getFirestore().runTransaction(async (transaction) => {
    const erased = await transaction.get(getFirestore().collection(ERASED_ACCOUNTS).doc(identity.uid));
    if (erased.exists) return true;
    const existing = await transaction.get(ref);
    if (!existing.exists) {
      transaction.delete(ref.parent.parent!.collection("plays").doc(id));
      return false;
    }
    const stored = existing.data() as BoardDocument;
    transaction.set(ref, {
      revision: (stored.revision ?? 0) + 1,
      deviceName: stored.deviceName ?? null,
      deleted: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.delete(ref.parent.parent!.collection("plays").doc(id));
    return false;
  });

  if (erased) return void response.status(401).json({ error: "This account was deleted", code: "ACCOUNT_ERASED" });

  response.status(204).send();
}
