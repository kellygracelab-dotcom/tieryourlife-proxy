import { defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { requireUser, type Identity } from "./auth";
import { decideHide, groupReports, REPORT_REASONS, type QueuedReport } from "./moderation";
import {
  copyForPublication,
  discardPublished,
  discardUnusedPublished,
} from "./publishedPictures";
import {
  CATEGORIES,
  FEED_PAGE_SIZE,
  REPORT_PAGE_SIZE,
  MAX_TITLE_LENGTH,
  decidePublish,
  picturesWanted,
  settle,
  type Category,
  type PublishDecision,
} from "./publishing";

const PUBLISHED = "publishedLists";
const REPORTS = "reports";
const VERBS = ["report", "takedown", "dismiss"];

/**
 * Whoever reads the reports. One person, named by configuration rather than
 * by a role in the database: there is no second moderator to add, and a
 * flag on a document is a flag that can be written.
 */
const moderatorUid = defineString("MODERATOR_UID");
const moderatorEmail = defineString("MODERATOR_EMAIL");

/**
 * Two keys to one door, and the second is why: an account can be lost, and its
 * uid dies with it, while the address survives and can be signed in with
 * again. Naming only the uid means one lost password locks the moderator out
 * of their own queue until somebody redeploys.
 *
 * The address is only ever the one the provider verified -- [Identity] drops
 * unverified ones -- so this cannot be claimed by asserting it.
 */
export function isModerator(
  identity: Pick<Identity, "uid" | "email">,
  configuredUid: string = moderatorUid.value(),
  configuredEmail: string = moderatorEmail.value(),
): boolean {
  // An unset moderator makes nobody one. The other way round would hand the
  // takedown button to everybody the first time the parameter went missing.
  const byUid = configuredUid.length > 0 && configuredUid === identity.uid;
  const byEmail =
    configuredEmail.length > 0 &&
    identity.email !== null &&
    configuredEmail.trim().toLowerCase() === identity.email;
  return byUid || byEmail;
}
const MAX_NOTE_LENGTH = 500;


interface StoredList {
  authorUid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  title: string;
  titleLower: string;
  category: Category;
  tiers: unknown[];
  items: unknown[];
  itemCount: number;
  coverImageUrl: string | null;
  previewImages: string[];
  tierColors: string[];
  updatedAt?: FirebaseFirestore.Timestamp;
  /**
   * Out of the feed while somebody looks at it. Set by enough complaints,
   * cleared by the person who reads them. Absent on every list published
   * before any of this existed, which reads as false and is correct.
   */
  underReview?: boolean;
  /**
   * Somebody looked at this snapshot and left it up, so complaints about it no
   * longer take it out of the feed. Per snapshot: republishing makes a new one.
   */
  reviewed?: boolean;
}

function refuse(response: Response, decision: Exclude<PublishDecision, { ok: true }>): void {
  switch (decision.reason) {
    case "not_signed_in":
      response.status(403).json({ error: "Sign in to publish", code: "NOT_SIGNED_IN" });
      return;
    case "too_many_lists":
      response.status(409).json({ error: "Too many published lists", code: "TOO_MANY_LISTS" });
      return;
    // Its own status so the app can name the limit instead of saying
    // "something went wrong" to someone with three hundred cards.
    case "too_large":
      response.status(413).json({ error: decision.detail, code: "TOO_LARGE" });
      return;
    case "invalid":
      response.status(400).json({ error: decision.detail, code: "INVALID" });
      return;
  }
}

function toSummary(id: string, data: StoredList) {
  return {
    id,
    title: data.title,
    authorUid: data.authorUid,
    authorName: data.authorName,
    authorPhotoUrl: data.authorPhotoUrl ?? null,
    category: data.category ?? "other",
    itemCount: data.itemCount,
    coverImageUrl: data.coverImageUrl ?? null,
    previewImages: data.previewImages ?? [],
    tierColors: data.tierColors ?? [],
    updatedAt: data.updatedAt?.toMillis() ?? 0,
  };
}

export const lists = onRequest(
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

    // Everything after /lists: nothing for the feed, an id for one list, an
    // id plus a verb for something done to it, and "reports" or "mine" for the
    // two listings that are not a list. Firestore ids are twenty characters,
    // so none of these words can be one.
    const segments = request.path.replace(/^\/+|\/+$/g, "").split("/").filter((part) => part !== "lists");
    const last = segments[segments.length - 1] ?? "";
    const verb = VERBS.includes(last) ? last : null;
    const id = (verb ? segments[segments.length - 2] : last) ?? "";
    const hasId = id.length > 0;
    const listingReports = !verb && id === "reports";
    const listingMine = !verb && id === "mine";

    try {
      switch (request.method) {
        case "GET":
          if (listingReports) {
            return await readReports(response, identity);
          }
          if (listingMine) {
            return await readMine(response, identity);
          }
          return hasId
            ? await readOne(response, identity, id)
            : await readFeed(response, {
                category: categoryFilter(request.query.category),
                author: singleParam(request.query.author),
                query: searchTerm(request.query.q),
                after: singleParam(request.query.after),
              });
        case "POST":
          if (verb) {
            if (!hasId) {
              return void response.status(400).json({ error: "Which list?" });
            }
            if (verb === "report") {
              return await report(response, identity, id, request.body);
            }
            return await settleReports(response, identity, id, verb === "takedown");
          }
          return await publish(response, identity, request.body, hasId ? id : null);
        case "PATCH":
          return await refreshAuthor(response, identity);
        case "DELETE":
          return hasId
            ? await unpublish(response, identity, id)
            : void response.status(400).json({ error: "Which list?" });
        default:
          return void response.status(405).json({ error: "Use GET, POST, PATCH or DELETE" });
      }
    } catch (error) {
      console.error("Community request failed", error);
      response.status(503).json({ error: "Unavailable", code: "UNAVAILABLE" });
    }
  },
);

/** Anything that is not one of the eight means "no filter", not an error. */
function categoryFilter(raw: unknown): Category | null {
  return CATEGORIES.find((known) => known === raw) ?? null;
}

function singleParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Firestore has no full-text search, so this is a prefix match on the
 * lower-cased title. Enough to find a list you half-remember the name of, and
 * honest about being no more than that.
 */
function searchTerm(raw: unknown): string | null {
  const trimmed = singleParam(raw);
  return trimmed ? trimmed.toLowerCase().slice(0, MAX_TITLE_LENGTH) : null;
}

interface FeedFilters {
  category: Category | null;
  author: string | null;
  query: string | null;
  /** Id of the last list on the page before, or null for the first page. */
  after: string | null;
}

/**
 * A short page is the last one. A full page might be, and costs one empty
 * fetch to find out -- cheaper than counting the collection every time.
 */
export function nextCursor(pageIds: string[], pageSize: number = FEED_PAGE_SIZE): string | null {
  return pageIds.length === pageSize ? pageIds[pageIds.length - 1] : null;
}

async function readFeed(response: Response, filters: FeedFilters): Promise<void> {
  const collection = getFirestore().collection(PUBLISHED);
  let query: FirebaseFirestore.Query = collection;
  if (filters.category) {
    query = query.where("category", "==", filters.category);
  }
  if (filters.author) {
    query = query.where("authorUid", "==", filters.author);
  }

  // A range has to be ordered by the field it ranges over, so a search orders
  // by title and everything else by recency.
  let ordered = filters.query
    ? query
        .where("titleLower", ">=", filters.query)
        .where("titleLower", "<=", `${filters.query}`)
        .orderBy("titleLower")
    : query.orderBy("updatedAt", "desc");

  // The cursor is the last id of the page before. Reading that document
  // back costs one read and lets Firestore resume from it under either
  // ordering, ties included, which a bare field value cannot do.
  if (filters.after) {
    const previous = await collection.doc(filters.after).get();
    if (!previous.exists) {
      // Taken down between pages. Saying so beats silently starting again
      // from the top and repeating everything the reader has seen.
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }

  const snapshot = await ordered.limit(FEED_PAGE_SIZE).get();
  // Filtered here rather than in the query. A `where` on this would need a
  // composite index for every combination of category, author and ordering the
  // feed already supports, and the whole cost of doing it in code is that a
  // page carrying a hidden list comes back one short -- which nobody scrolling
  // an endless feed can see.
  const lists = snapshot.docs
    .filter((doc) => (doc.data() as StoredList).underReview !== true)
    .map((doc) => toSummary(doc.id, doc.data() as StoredList));

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists,
    nextCursor: nextCursor(snapshot.docs.map((doc) => doc.id)),
  });
}

/**
 * What this person has in the community, straight from the collection
 * rather than from their phone. A list published from a device they no
 * longer have -- or one whose local copy is gone -- is still theirs, and
 * this is the only place it can be seen or taken down.
 */
async function readMine(response: Response, identity: Identity): Promise<void> {
  const snapshot = await getFirestore()
    .collection(PUBLISHED)
    .where("authorUid", "==", identity.uid)
    .orderBy("updatedAt", "desc")
    .get();

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: snapshot.docs.map((doc) => toSummary(doc.id, doc.data() as StoredList)),
  });
}

/**
 * The queue, newest first. Reports are per reporter, so several people
 * complaining about one list arrive as several rows; grouping them here
 * would hide how many there were, which is the useful part.
 */
async function readReports(response: Response, identity: Identity): Promise<void> {
  if (!isModerator(identity)) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }

  const db = getFirestore();
  const snapshot = await db
    .collection(REPORTS)
    .orderBy("createdAt", "desc")
    .limit(REPORT_PAGE_SIZE)
    .get();

  const filed: QueuedReport[] = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      listId: data.listId,
      listTitle: data.listTitle,
      authorName: data.authorName,
      reason: data.reason,
      note: data.note ?? null,
      createdAtMs: data.createdAt?.toMillis?.() ?? 0,
    };
  });

  // Whether each one is out of the feed, and whether it has already been kept
  // once. Read here rather than copied onto every report, because a report is
  // a thing somebody said and does not change when the list's standing does.
  const listIds = [...new Set(filed.map((one) => one.listId))];
  const lists = listIds.length > 0 ? await db.getAll(
    ...listIds.map((id) => db.collection(PUBLISHED).doc(id)),
  ) : [];
  const state = new Map(
    lists.map((doc) => {
      const data = (doc.data() ?? {}) as StoredList;
      return [doc.id, { hidden: data.underReview === true, reviewed: data.reviewed === true }];
    }),
  );

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ reports: groupReports(filed, state) });
}

/**
 * Ends a complaint one way or the other. Taking the list down removes it
 * for everyone; dismissing leaves it and only clears the queue. Both drop
 * the reports, because a complaint that has been answered is not pending.
 */
async function settleReports(
  response: Response,
  identity: Identity,
  listId: string,
  takeDown: boolean,
): Promise<void> {
  if (!isModerator(identity)) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }

  const db = getFirestore();
  const filed = await db.collection(REPORTS).where("listId", "==", listId).get();
  const batch = db.batch();
  filed.docs.forEach((doc) => batch.delete(doc.ref));
  if (takeDown) {
    batch.delete(db.collection(PUBLISHED).doc(listId));
  } else {
    // Back into the feed, and marked so that the next three complaints cannot
    // take it out again. Somebody looked; that is what looking is for.
    batch.set(
      db.collection(PUBLISHED).doc(listId),
      { underReview: false, reviewed: true },
      { merge: true },
    );
  }
  await batch.commit();
  if (takeDown) {
    await discardPublished(listId);
  }

  response.status(204).send();
}

async function readOne(response: Response, identity: Identity, id: string): Promise<void> {
  const doc = await getFirestore().collection(PUBLISHED).doc(id).get();
  if (!doc.exists) {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  const data = doc.data() as StoredList;
  // Hiding it from the feed and leaving it open to anyone holding the address
  // would hide it from nobody. The moderator is the exception, because the
  // queue sends them here: hidden from the feed is not hidden from the person
  // who has to decide whether it should be.
  if (data.underReview === true && !isModerator(identity)) {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    ...toSummary(doc.id, data),
    tiers: data.tiers,
    items: data.items,
  });
}

async function publish(
  response: Response,
  identity: Identity,
  body: unknown,
  existingId: string | null,
): Promise<void> {
  const db = getFirestore();
  const collection = db.collection(PUBLISHED);

  // Replacing a list the author already published does not add to their count.
  const alreadyPublished = existingId
    ? 0
    : (await collection.where("authorUid", "==", identity.uid).count().get()).data().count;

  const decision = decidePublish({
    body,
    isAnonymous: identity.isAnonymous,
    listsAlreadyPublished: alreadyPublished,
  });
  if (!decision.ok) {
    refuse(response, decision);
    return;
  }

  // Whose list this is, settled before any picture is read: replacing somebody
  // else's list should cost nothing and reach nothing.
  if (existingId) {
    const existing = await collection.doc(existingId).get();
    if (!existing.exists) {
      response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
      return;
    }
    if ((existing.data() as StoredList).authorUid !== identity.uid) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
      return;
    }
  }

  // A new list is named before it is written. The pictures have to be copied
  // somewhere, and that somewhere is the list's own folder.
  const target = existingId ?? collection.doc().id;

  const outcomes = await copyForPublication(
    identity.uid,
    target,
    picturesWanted(decision.draft),
  );
  const refused = outcomes.find(
    (one): one is Extract<typeof one, { ok: false }> => !one.ok && one.because !== "missing",
  );
  if (refused) {
    response.status(422).json({
      error: "That picture cannot go in the feed",
      code: "PICTURE_REFUSED",
      because: refused.because,
    });
    return;
  }

  const addresses = new Map(
    outcomes.filter((one) => one.ok).map((one) => [one.id, (one as { address: string }).address]),
  );
  const list = settle(decision.draft, addresses);

  const document = {
    authorUid: identity.uid,
    authorName: identity.name ?? "Anonymous",
    authorPhotoUrl: identity.picture,
    title: list.title,
    titleLower: list.titleLower,
    category: list.category,
    tiers: list.tiers,
    items: list.items,
    itemCount: list.items.length,
    coverImageUrl: list.coverImageUrl,
    previewImages: list.previewImages,
    tierColors: list.tierColors,
    updatedAt: FieldValue.serverTimestamp(),
    // Replacing the contents replaces the snapshot, so it has not been looked
    // at -- whatever was true of the one it replaced. Merging without these
    // left the shield in place: publish something harmless, wait to be kept,
    // then put anything at all behind a mark that complaints cannot lift.
    underReview: false,
    reviewed: false,
  };

  if (existingId) {
    await collection.doc(existingId).set(document, { merge: true });
    // The board was edited for a month; the copies it no longer names are
    // nobody's, because the snapshot that pointed at them has been replaced.
    await discardUnusedPublished(existingId, [...addresses.keys()]);
    response.status(200).json({ id: existingId });
    return;
  }

  await collection.doc(target).set({ ...document, publishedAt: FieldValue.serverTimestamp() });
  response.status(201).json({ id: target });
}

/**
 * A name and a face belong to a person, not to a snapshot. Changing either
 * would otherwise leave every list they had already published showing whoever
 * they used to be.
 */
async function refreshAuthor(response: Response, identity: Identity): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return;
  }

  const db = getFirestore();
  const mine = await db.collection(PUBLISHED).where("authorUid", "==", identity.uid).get();
  if (mine.empty) {
    response.status(200).json({ updated: 0 });
    return;
  }

  const batch = db.batch();
  for (const doc of mine.docs) {
    batch.update(doc.ref, {
      authorName: identity.name ?? "Anonymous",
      authorPhotoUrl: identity.picture,
    });
  }
  await batch.commit();
  response.status(200).json({ updated: mine.size });
}

/**
 * A complaint, kept for a person to read. Nothing is taken down automatically:
 * there is one pair of eyes behind this and the app says so rather than
 * implying a moderation team.
 */
async function report(
  response: Response,
  identity: Identity,
  listId: string,
  body: unknown,
): Promise<void> {
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = REPORT_REASONS.find((known) => known === source.reason);
  if (!reason) {
    response.status(400).json({ error: "Pick a reason", code: "INVALID" });
    return;
  }

  const db = getFirestore();
  const list = await db.collection(PUBLISHED).doc(listId).get();
  if (!list.exists) {
    // Already gone is the outcome they wanted; saying so beats an error.
    response.status(204).send();
    return;
  }
  const stored = list.data() as StoredList;

  // One report per person per list: a second is the same complaint, not a
  // stronger one.
  await db.collection(REPORTS).doc(`${listId}_${identity.uid}`).set({
    listId,
    listTitle: stored.title,
    authorUid: stored.authorUid,
    authorName: stored.authorName,
    reporterUid: identity.uid,
    reason,
    note: typeof source.note === "string" ? source.note.trim().slice(0, MAX_NOTE_LENGTH) : null,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Read back rather than counted up: reports are one per person, and a second
  // one from the same person replaced the first rather than adding to it.
  const filed = await db.collection(REPORTS).where("listId", "==", listId).get();
  const reasons = filed.docs.map((doc) => doc.data().reason as typeof reason);
  if (decideHide({ reasons, reviewed: stored.reviewed === true })) {
    await list.ref.set({ underReview: true }, { merge: true });
  }

  response.status(204).send();
}

async function unpublish(response: Response, identity: Identity, id: string): Promise<void> {
  const doc = getFirestore().collection(PUBLISHED).doc(id);
  const existing = await doc.get();
  if (!existing.exists) {
    response.status(204).send();
    return;
  }
  if ((existing.data() as StoredList).authorUid !== identity.uid) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  await doc.delete();
  await discardPublished(id);
  response.status(204).send();
}
