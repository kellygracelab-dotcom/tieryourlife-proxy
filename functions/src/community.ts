import { defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { FieldPath, FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { requireUser, type Identity } from "./auth";
import { type Ban, type BanLength, banFrom, isBanLength, isBanned, noticeFor } from "./bans";
import { decideHide, groupReports, REPORT_REASONS, type QueuedReport } from "./moderation";
import {
  decideWordingConcern,
  ENOUGH_TO_JUDGE,
  realModeration,
  wordsOf,
  type WordingConcern,
} from "./wording";
import { isPictureId } from "./safety";
import {
  chunked,
  cursorOf,
  decideFollow,
  followId,
  isUid,
  MAX_FOLLOWING,
  mergePages,
  readCursor,
  sortOrder,
  type Cursor,
  type Sort,
} from "./follows";
import {
  copyAsFace,
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
const FOLLOWS = "follows";
const TAKES = "takes";
const BANS = "bans";
const VERBS = ["report", "takedown", "dismiss", "taken"];

/** Not a list at all: turning one of your own pictures into a face. */
const FACE = "face";

/** Nor is this one: following an author, or stopping. */
const FOLLOW = "follow";

/**
 * How many authors the empty following screen offers, and how many lists are
 * read to find them. Read wider than offered because the lists people have
 * taken most are not by that many different people.
 */
const SUGGESTIONS = 12;
const SUGGESTIONS_READ = 60;

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
  /**
   * How many people have taken this list to rank for themselves. Written as
   * zero at publication rather than left absent: Firestore leaves documents
   * without the field out of an ordering on it entirely, and a list nobody has
   * taken yet still belongs at the bottom of "most taken" rather than nowhere.
   */
  takeCount?: number;
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
    takeCount: data.takeCount ?? 0,
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
    const makingAFace = !verb && segments[0] === FACE;
    const aboutAnAuthor = !verb && segments[0] === FOLLOW;
    const authorUid = segments[1] ?? "";
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
          if (aboutAnAuthor) {
            return authorUid
              ? await readFollowState(response, identity, authorUid)
              : await readSuggestedAuthors(response, identity);
          }
          return hasId
            ? await readOne(response, identity, id)
            : await readFeed(response, identity, {
                category: categoryFilter(request.query.category),
                author: singleParam(request.query.author),
                query: searchTerm(request.query.q),
                after: singleParam(request.query.after),
                sort: sortOrder(request.query.sort),
                following: request.query.following === "1",
              });
        case "POST":
          if (makingAFace) {
            return await makeFace(response, identity, segments[1] ?? "");
          }
          if (aboutAnAuthor) {
            return await follow(response, identity, authorUid);
          }
          if (verb) {
            if (!hasId) {
              return void response.status(400).json({ error: "Which list?" });
            }
            if (verb === "report") {
              return await report(response, identity, id, request.body);
            }
            if (verb === "taken") {
              return await recordTake(response, identity, id);
            }
            // The ban travels with the takedown rather than as a call of its
            // own: one decision, one request, and no window in which a list
            // is gone but its author is not yet answered for.
            const asked = (request.body as { ban?: unknown } | null)?.ban;
            return await settleReports(
              response,
              identity,
              id,
              verb === "takedown",
              isBanLength(asked) ? asked : null,
            );
          }
          return await publish(response, identity, request.body, hasId ? id : null);
        case "PATCH":
          return await refreshAuthor(response, identity);
        case "DELETE":
          if (aboutAnAuthor) {
            return await unfollow(response, identity, authorUid);
          }
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

/**
 * Turns one of this person's own pictures into a face the community can see.
 *
 * Their pictures live in a folder only they may read, so a face has to be a
 * copy somewhere everybody may -- the same as a board's pictures when it is
 * published, and looked at by Vision on the same terms. Catalogue art needs
 * none of this: it already has an address of its own.
 */
async function makeFace(response: Response, identity: Identity, pictureId: string): Promise<void> {
  if (!isPictureId(pictureId)) {
    response.status(400).json({ error: "Which picture?", code: "INVALID" });
    return;
  }
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return;
  }

  const address = await copyAsFace(identity.uid, pictureId);
  if (address === null) {
    response.status(422).json({ error: "That picture cannot be a face", code: "PICTURE_REFUSED" });
    return;
  }
  response.status(200).json({ url: address });
}

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
  /**
   * Id of the last list on the page before, or null for the first page. The
   * feed of people you follow carries a pair of values here instead -- see
   * `cursorOf` for why one document cannot resume several queries.
   */
  after: string | null;
  sort: Sort;
  /** Only from the authors this person follows. */
  following: boolean;
}

/**
 * A short page is the last one. A full page might be, and costs one empty
 * fetch to find out -- cheaper than counting the collection every time.
 */
export function nextCursor(pageIds: string[], pageSize: number = FEED_PAGE_SIZE): string | null {
  return pageIds.length === pageSize ? pageIds[pageIds.length - 1] : null;
}

async function readFeed(response: Response, identity: Identity, filters: FeedFilters): Promise<void> {
  if (filters.following) {
    return await readFollowingFeed(response, identity, filters);
  }
  const collection = getFirestore().collection(PUBLISHED);
  let query: FirebaseFirestore.Query = collection;
  if (filters.category) {
    query = query.where("category", "==", filters.category);
  }
  if (filters.author) {
    query = query.where("authorUid", "==", filters.author);
  }

  // A range has to be ordered by the field it ranges over, so a search orders
  // by title whatever was asked for, and everything else by what was asked.
  let ordered = filters.query
    ? query
        .where("titleLower", ">=", filters.query)
        .where("titleLower", "<=", `${filters.query}`)
        .orderBy("titleLower")
    : query.orderBy(filters.sort === "popular" ? "takeCount" : "updatedAt", "desc");

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
 * The feed of the people somebody follows.
 *
 * Firestore answers `in` with at most thirty values, so this is several
 * queries merged rather than one. That is also why the cursor here is a pair
 * of values rather than a document: the list that ended the page belongs to
 * one of the runs and means nothing to the others, so every run has to be
 * resumed from the same place instead.
 */
async function readFollowingFeed(response: Response, identity: Identity, filters: FeedFilters): Promise<void> {
  const authors = await followedBy(identity.uid);
  if (authors.length === 0) {
    // Not an error and not an empty feed: an answer the screen can say
    // something useful about, which "no lists" on its own cannot.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ lists: [], nextCursor: null, followingNobody: true });
    return;
  }

  const cursor = readCursor(filters.after);
  const runs = await Promise.all(chunked(authors).map((run) => followedRun(run, filters, cursor)));
  const page = mergePages(runs, filters.sort, FEED_PAGE_SIZE);

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: page.map((one) => one.summary),
    nextCursor: cursorOf(page, FEED_PAGE_SIZE, filters.sort),
  });
}

interface FeedRow {
  id: string;
  updatedAt: number;
  takeCount: number;
  summary: ReturnType<typeof toSummary>;
}

/** One run of up to thirty authors, ordered the way the whole page will be. */
async function followedRun(authors: string[], filters: FeedFilters, cursor: Cursor | null): Promise<FeedRow[]> {
  let query: FirebaseFirestore.Query = getFirestore()
    .collection(PUBLISHED)
    .where("authorUid", "in", authors);
  if (filters.category) {
    query = query.where("category", "==", filters.category);
  }

  const by = filters.sort === "popular" ? "takeCount" : "updatedAt";
  // Ties break on the document id, so two lists saved in the same millisecond
  // always come back in the same order. A page boundary that wobbles repeats a
  // list or skips one.
  let ordered = query.orderBy(by, "desc").orderBy(FieldPath.documentId());
  if (cursor) {
    const value = by === "updatedAt" ? Timestamp.fromMillis(cursor.value) : cursor.value;
    ordered = ordered.startAfter(value, cursor.id);
  }

  const snapshot = await ordered.limit(FEED_PAGE_SIZE).get();
  return snapshot.docs
    .filter((doc) => (doc.data() as StoredList).underReview !== true)
    .map((doc) => {
      const data = doc.data() as StoredList;
      return {
        id: doc.id,
        updatedAt: data.updatedAt?.toMillis() ?? 0,
        takeCount: data.takeCount ?? 0,
        summary: toSummary(doc.id, data),
      };
    });
}

/** Whom this person follows, at most as many as one page will draw from. */
async function followedBy(uid: string): Promise<string[]> {
  const snapshot = await getFirestore()
    .collection(FOLLOWS)
    .where("follower", "==", uid)
    .limit(MAX_FOLLOWING)
    .get();
  return snapshot.docs.map((doc) => doc.get("author") as string);
}

/**
 * Whether this person follows that author, and how many people do.
 *
 * The count is read here rather than kept on the author, because there is no
 * author document: an author is whoever published something, and their name
 * and face travel on each list. Counting costs one aggregation query, and the
 * screen that asks is one somebody opened deliberately.
 */
async function readFollowState(response: Response, identity: Identity, authorUid: string): Promise<void> {
  if (!isUid(authorUid)) {
    response.status(400).json({ error: "Which author?", code: "INVALID" });
    return;
  }
  const collection = getFirestore().collection(FOLLOWS);
  const [mine, followers] = await Promise.all([
    collection.doc(followId(identity.uid, authorUid)).get(),
    collection.where("author", "==", authorUid).count().get(),
  ]);

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ following: mine.exists, followers: followers.data().count });
}

/**
 * Authors worth following, for somebody who follows nobody yet.
 *
 * Taken from the lists people have taken most, because that is the only
 * standing anybody has here -- there is no author document to rank and no
 * editorial list to keep. Read wide and thinned to one entry per author, so
 * that one person with four popular lists does not become the whole answer.
 *
 * Whoever is already followed is left out, and so is the reader: a screen that
 * opens on "follow yourself" has answered the wrong question.
 */
async function readSuggestedAuthors(response: Response, identity: Identity): Promise<void> {
  const [popular, already] = await Promise.all([
    getFirestore()
      .collection(PUBLISHED)
      .orderBy("takeCount", "desc")
      .limit(SUGGESTIONS_READ)
      .get(),
    followedBy(identity.uid),
  ]);

  const skip = new Set([...already, identity.uid]);
  const authors = new Map<string, { uid: string; name: string; photoUrl: string | null; takeCount: number }>();
  for (const doc of popular.docs) {
    const data = doc.data() as StoredList;
    if (data.underReview === true || skip.has(data.authorUid) || authors.has(data.authorUid)) {
      continue;
    }
    authors.set(data.authorUid, {
      uid: data.authorUid,
      name: data.authorName,
      photoUrl: data.authorPhotoUrl ?? null,
      takeCount: data.takeCount ?? 0,
    });
    if (authors.size === SUGGESTIONS) {
      break;
    }
  }

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ authors: [...authors.values()] });
}

async function follow(response: Response, identity: Identity, authorUid: string): Promise<void> {
  const collection = getFirestore().collection(FOLLOWS);
  // Counted before deciding rather than after, so the ceiling is the real one
  // and not one this request has already stepped over.
  const already = await collection.where("follower", "==", identity.uid).count().get();
  const decision = decideFollow(
    { uid: identity.uid, isAnonymous: identity.isAnonymous, following: already.data().count },
    authorUid,
  );
  if (!decision.ok) {
    return void refuseFollow(response, decision.reason);
  }

  // A deterministic id, so following twice writes the same document rather
  // than leaving two rows that say the same thing.
  await collection.doc(followId(identity.uid, authorUid)).set({
    follower: identity.uid,
    author: authorUid,
    createdAt: FieldValue.serverTimestamp(),
  });
  response.status(200).json({ following: true });
}

async function unfollow(response: Response, identity: Identity, authorUid: string): Promise<void> {
  if (!isUid(authorUid)) {
    response.status(400).json({ error: "Which author?", code: "INVALID" });
    return;
  }
  // Deleting what is not there is what the caller asked for either way.
  await getFirestore().collection(FOLLOWS).doc(followId(identity.uid, authorUid)).delete();
  response.status(200).json({ following: false });
}

function refuseFollow(response: Response, reason: string): void {
  switch (reason) {
    case "not_signed_in":
      response.status(403).json({ error: "Sign in to follow", code: "NOT_SIGNED_IN" });
      return;
    case "yourself":
      response.status(409).json({ error: "You already have your own lists", code: "YOURSELF" });
      return;
    case "too_many":
      response.status(409).json({ error: "Following too many people", code: "TOO_MANY_FOLLOWING" });
      return;
    default:
      response.status(400).json({ error: "Which author?", code: "INVALID" });
  }
}

/**
 * Somebody took this list to rank for themselves, which is the only thing the
 * popular ordering counts.
 *
 * Counted once per person and written down as a document rather than trusted
 * to the caller: without that, one phone tapping the same list all afternoon
 * would decide what everybody else sees. Taking your own list back does not
 * count either, because an author cannot vote for themselves.
 */
async function recordTake(response: Response, identity: Identity, listId: string): Promise<void> {
  const db = getFirestore();
  const list = db.collection(PUBLISHED).doc(listId);
  const snapshot = await list.get();
  if (!snapshot.exists) {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  if ((snapshot.data() as StoredList).authorUid === identity.uid) {
    response.status(200).json({ counted: false });
    return;
  }

  const take = db.collection(TAKES).doc(`${listId}_${identity.uid}`);
  const counted = await db.runTransaction(async (transaction) => {
    if ((await transaction.get(take)).exists) {
      return false;
    }
    transaction.set(take, { listId, taker: identity.uid, createdAt: FieldValue.serverTimestamp() });
    transaction.update(list, { takeCount: FieldValue.increment(1) });
    return true;
  });
  response.status(200).json({ counted });
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
      return [doc.id, {
        hidden: data.underReview === true,
        reviewed: data.reviewed === true,
        // The list's own cover if it has one, and the first card's picture
        // otherwise -- the feed shows the same thing, so this is what the
        // person complaining was looking at.
        coverImageUrl: data.coverImageUrl ?? data.previewImages?.[0] ?? null,
        authorUid: data.authorUid ?? null,
        authorPhotoUrl: data.authorPhotoUrl ?? null,
      }];
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
  banLength: BanLength | null,
): Promise<void> {
  if (!isModerator(identity)) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }

  const db = getFirestore();
  const filed = await db.collection(REPORTS).where("listId", "==", listId).get();
  // Read before the batch deletes them: the author is on the complaint, and
  // after the batch there is nothing left to ask.
  const authorUid = filed.docs.map((doc) => doc.data().authorUid as string).find(Boolean) ?? null;
  // What they were reported for, kept on the ban so the moderator's own
  // memory of why is not the only record of it.
  const reasonForBan = filed.docs.map((doc) => doc.data().reason as string).find(Boolean) ?? null;
  const batch = db.batch();
  filed.docs.forEach((doc) => batch.delete(doc.ref));
  if (takeDown) {
    batch.delete(db.collection(PUBLISHED).doc(listId));
    // Only with a takedown. Putting a list back and banning its author in one
    // gesture would be two opposite judgements at once.
    if (banLength !== null && authorUid !== null) {
      batch.set(db.collection(BANS).doc(authorUid), banFrom(banLength, Date.now(), reasonForBan));
    }
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

  // Before anything is read or written: somebody who may not publish may not
  // replace what they published either, or a ban would last exactly as long
  // as it took them to edit an old list.
  const ban = await readBan(identity.uid);
  if (isBanned(ban, Date.now())) {
    response.status(403).json({ error: "You cannot publish at the moment", ...noticeFor(ban) });
    return;
  }

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

  // Asked before the pictures, because it costs one call and no bytes.
  // Answered after the board is stored, because the answer is a report about
  // a list and there has to be a list to report.
  const words = wordsOf(decision.draft);
  const wording = words.length >= ENOUGH_TO_JUDGE ? await realModeration(words) : null;
  const concern = wording === null ? "none" : decideWordingConcern(wording);

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
    await noteWordingConcern(existingId, document.title, identity, concern);
    // The board was edited for a month; the copies it no longer names are
    // nobody's, because the snapshot that pointed at them has been replaced.
    await discardUnusedPublished(existingId, [...addresses.keys()]);
    response.status(200).json({ id: existingId });
    return;
  }

  // Only on a new list. Republishing merges, and a count written here would
  // reset it: an author who fixes a typo would lose everybody who had taken
  // their list, which is a strange thing to charge for an edit. Taking is
  // about the list, not about the snapshot -- unlike being reviewed, which is
  // about exactly this snapshot and is cleared above.
  await collection.doc(target).set({
    ...document,
    publishedAt: FieldValue.serverTimestamp(),
    takeCount: 0,
  });
  await noteWordingConcern(target, document.title, identity, concern);
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

/** The ban on somebody, or nothing at all. Expiry is judged where it is read. */
async function readBan(uid: string): Promise<Ban | null> {
  const doc = await getFirestore().collection(BANS).doc(uid).get();
  return doc.exists ? (doc.data() as Ban) : null;
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

/**
 * Puts a board the classifier was unsure about in front of the person who
 * reads the queue, and takes it out of the feed if it was more than unsure.
 *
 * Filed as a report like anybody else's, under a reporter id nobody can hold,
 * so it groups with the human ones and is settled by the same two buttons. A
 * separate mechanism would have meant a second queue to remember to look at.
 *
 * Never blocks the publication. The classifier cannot tell a film list about
 * sex scenes from a list of pornography -- measured, not guessed -- so it is
 * allowed to raise a hand and not to refuse.
 */
async function noteWordingConcern(
  listId: string,
  listTitle: string,
  identity: Identity,
  concern: WordingConcern,
): Promise<void> {
  if (concern === "none") return;

  const db = getFirestore();
  await db.collection(REPORTS).doc(`${listId}_${WATCHER}`).set({
    listId,
    listTitle,
    authorUid: identity.uid,
    authorName: identity.name ?? "Anonymous",
    reporterUid: WATCHER,
    reason: "sexual",
    note: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  if (concern === "hide") {
    await db.collection(PUBLISHED).doc(listId).set({ underReview: true }, { merge: true });
  }
}

/**
 * The reporter id the classifier files under. Not a uid anybody can be issued,
 * so it can never collide with a person, and one per list like everybody else
 * -- republishing replaces its report rather than stacking a second one.
 */
const WATCHER = "__wording__";
