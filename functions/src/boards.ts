import { onRequest } from "firebase-functions/v2/https";
import { FieldPath, FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { requireUser, type Identity } from "./auth";
import {
  BOARD_PAGE_SIZE,
  MAX_BOARDS_PER_ACCOUNT,
  cleanDeviceName,
  decideStore,
  decideWrite,
  type StoreRejection,
  type StoredBoard,
} from "./sync";

/**
 * The copy of someone's boards that outlives their phone.
 *
 * Written here rather than by the app talking to Firestore directly, which
 * would mean opening a hole in `firestore.rules`. The rules deny everything on
 * purpose -- a client that can write one collection is a client whose writes
 * have to be argued about -- and boards are not worth being the first
 * exception.
 *
 *   accounts/{uid}/boards/{boardUid}
 *
 * The board's uid is the device's own, so the same board written from two
 * phones lands on one document instead of two.
 */

const ACCOUNTS = "accounts";
const BOARDS = "boards";

interface BoardDocument extends Partial<StoredBoard> {
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

function toFullBoard(id: string, data: BoardDocument) {
  return {
    uid: id,
    revision: data.revision,
    updatedAt: data.updatedAt?.toMillis() ?? 0,
    deviceName: data.deviceName ?? null,
    deleted: data.deleted === true,
    fingerprint: data.fingerprint ?? null,
    title: data.title ?? "",
    displayMode: data.displayMode ?? "WRAP",
    category: data.category ?? null,
    coverImageUrl: data.coverImageUrl ?? null,
    authorName: data.authorName ?? null,
    publishedId: data.publishedId ?? null,
    deletedAt: data.deletedAt ?? null,
    tiers: data.tiers ?? [],
    items: data.items ?? [],
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
    const identity = await requireUser(request, response);
    if (!identity) {
      return;
    }

    // Everything after /boards is at most one board's uid. There are no verbs
    // here: a board is read, written whole, or thrown away.
    const segments = request.path
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((part) => part !== "boards" && part.length > 0);
    if (segments.length > 1) {
      return void response.status(404).json({ error: "No such address" });
    }
    const id = segments[0] ?? "";
    const hasId = id.length > 0;

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
  const snapshot = await boardsOf(identity.uid).doc(id).get();
  if (!snapshot.exists) {
    return void response.status(404).json({ error: "No such board", code: "NOT_FOUND" });
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json(toFullBoard(snapshot.id, snapshot.data() as BoardDocument));
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
  const existing = await ref.get();

  const decision = decideStore({
    body,
    isAnonymous: identity.isAnonymous,
    // A board that is already here is not another board.
    boardsAlreadyKept: existing.exists ? kept - 1 : kept,
  });
  if (!decision.ok) {
    return void refuse(response, decision);
  }

  const stored = existing.exists ? (existing.data() as BoardDocument) : null;
  const verdict = decideWrite(stored ? stored.revision : null, source.basedOn);
  if (verdict === "conflict") {
    // Both versions are somebody's afternoon. The device keeps its own and
    // takes this one as a second board, which is why the whole thing is here
    // and not just the revision number.
    return void response.status(409).json({
      error: "That board moved on somewhere else",
      code: "CONFLICT",
      board: toFullBoard(existing.id, stored as BoardDocument),
    });
  }

  const revision = (stored?.revision ?? 0) + 1;
  await ref.set({
    ...decision.board,
    revision,
    deviceName: cleanDeviceName(source.deviceName),
    deleted: false,
    updatedAt: FieldValue.serverTimestamp(),
  });

  response.status(200).json({ uid: id, revision });
}

/**
 * Throwing a board away leaves a marker rather than nothing.
 *
 * Without one the account forgets the board, the other phone still has it, and
 * the next sync puts it back -- the delete that will not stick, which reads as
 * the app ignoring you.
 */
async function forget(response: Response, identity: Identity, id: string): Promise<void> {
  if (identity.isAnonymous) {
    return void response.status(403).json({ error: "Sign in to keep your boards", code: "NOT_SIGNED_IN" });
  }

  const ref = boardsOf(identity.uid).doc(id);
  const existing = await ref.get();
  if (!existing.exists) {
    return void response.status(204).send();
  }

  const stored = existing.data() as BoardDocument;
  await ref.set({
    revision: (stored.revision ?? 0) + 1,
    deviceName: stored.deviceName ?? null,
    deleted: true,
    updatedAt: FieldValue.serverTimestamp(),
  });

  response.status(204).send();
}
