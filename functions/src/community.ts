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
  followedAuthors,
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
import {
  arrangementOver,
  decidePublication,
  mineFirst,
  RANKINGS_PAGE_SIZE,
  readTakenFrom,
  type BasedOn,
  type Card,
  type PlacedCard,
  type Publication,
} from "./rankings";
import {
  countWithout,
  followedSectionRun,
  isSectionId,
  NEW_WINDOW_MS,
  pickCollage,
  sectionFollowId,
  SECTION_IDS,
  SECTION_STATS_TTL_MS,
  TimedCache,
  withFollowing,
  type CollageCandidate,
  type SectionStats,
} from "./sections";
import {
  decideAttachment,
  decideTopicAction,
  isTopicId,
  orderMine,
  readTopicRequest,
  similarTopics,
  SIMILAR_TOPICS,
  topicsPageSize,
  TOPIC_ACTIONS,
  type Attachment,
  type KnownTopic,
  type Topic,
  type TopicAction,
  type TopicRequest,
  type TopicStatus,
} from "./topics";

const PUBLISHED = "publishedLists";
const REPORTS = "reports";
const FOLLOWS = "follows";
const TAKES = "takes";
const BANS = "bans";
const TOPICS = "topics";
const TOPIC_FOLLOWS = "topicFollows";
const ROLES = "roles";
const RANKINGS = "rankings";
const SECTION_FOLLOWS = "sectionFollows";
const VERBS = ["report", "takedown", "dismiss", "taken", "move"];

/** Paths that are not about one list: topics and the people who may decide them. */
const TOPICS_PATH = "topics";
const MODERATORS_PATH = "moderators";
const RANKINGS_PATH = "rankings";
const SECTIONS_PATH = "sections";

/** How many of a section's most taken lists are read to find four pictures for its collage. */
const COLLAGE_READ = 24;

/** Firestore takes five hundred writes in a batch; a topic's lists are rewritten in parts under that. */
const WRITES_PER_BATCH = 400;

/** How many of somebody's own topics, or of the queue, one answer carries. */
const TOPICS_READ = 100;

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
 * Two keys to one door: a uid dies with a lost account, while the address
 * survives and can be signed in with again. The address is only ever the one
 * the provider verified, so this cannot be claimed by asserting it.
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

/**
 * The configured person, and whoever they have appointed since: a role in
 * the database, written only by these functions on the owner's word. The
 * owner alone appoints, so the door is still one person's to open.
 */
async function isModeratorNow(identity: Identity): Promise<boolean> {
  if (isModerator(identity)) return true;
  const role = await getFirestore().collection(ROLES).doc(identity.uid).get();
  return role.exists && role.get("moderator") === true;
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
  /** The topic this list carries, if any; the name is copied so a card needs no second read. */
  topicId?: string | null;
  topicName?: string | null;
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
   * Written as zero at publication rather than left absent: Firestore leaves
   * documents without the field out of an ordering on it entirely.
   */
  takeCount?: number;
  /** How many readers have placed this list's cards their own way. Zero at publication, like takeCount. */
  rankingCount?: number;
  /** The list this one was made from, when a reader changed the cards rather than only placing them. */
  basedOn?: BasedOn | null;
}

interface StoredRanking {
  listId: string;
  uid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  arrangement: (number | null)[];
  tierLabels: string[];
  updatedAt?: FirebaseFirestore.Timestamp;
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
    topicId: data.topicId ?? null,
    topicName: data.topicName ?? null,
    updatedAt: data.updatedAt?.toMillis() ?? 0,
    takeCount: data.takeCount ?? 0,
    rankingCount: data.rankingCount ?? 0,
    basedOn: data.basedOn ?? null,
  };
}

interface StoredTopic {
  name: string;
  nameLower: string;
  section: Category | null;
  status: TopicStatus;
  /** The section the proposer wanted; the moderator's hint, not the answer. */
  requestedSection: Category | null;
  createdBy: string;
  proposerName: string;
  createdAt?: FirebaseFirestore.Timestamp;
  decidedAt?: FirebaseFirestore.Timestamp | null;
  decidedBy?: string | null;
  listCount?: number;
  followerCount?: number;
  mergedInto?: string | null;
}

function knownTopic(id: string, data: StoredTopic): KnownTopic {
  return {
    id,
    name: data.name,
    nameLower: data.nameLower,
    status: data.status,
    section: data.section ?? null,
    createdBy: data.createdBy,
  };
}

function toTopic(id: string, data: StoredTopic, following: boolean): Topic {
  return {
    id,
    name: data.name,
    section: data.section ?? null,
    status: data.status,
    listCount: data.listCount ?? 0,
    followerCount: data.followerCount ?? 0,
    following,
    createdBy: data.createdBy,
    mergedInto: data.mergedInto ?? null,
  };
}

export const lists = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
    // One copy kept warm: a cold start cost 2-5 s on every first open of
    // Community, a face or a publish. About three dollars a month at this size.
    minInstances: 1,
  },
  async (request, response) => {
    if (!(await requireAppCheck(request, response))) {
      return;
    }
    const identity = await requireUser(request, response);
    if (!identity) {
      return;
    }

    // Everything after /lists: nothing, an id, an id plus a verb, or "reports"
    // and "mine". Firestore ids are twenty characters, so no word can be one.
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
    const listingFollowing = !verb && id === "following";
    const query = request.query as Record<string, unknown>;

    try {
      // Topics and moderators have their own small trees of paths.
      if (segments[0] === TOPICS_PATH) {
        return await routeTopics(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[0] === MODERATORS_PATH) {
        return await routeModerators(request.method, segments[1] ?? "", request.body, response, identity);
      }
      if (segments[0] === SECTIONS_PATH) {
        return await routeSections(request.method, segments.slice(1), response, identity);
      }
      if (segments[1] === RANKINGS_PATH && segments[0]) {
        return await routeRankings(request.method, segments[0], segments[2] ?? "", query, response, identity);
      }

      switch (request.method) {
        case "GET":
          if (listingReports) {
            return await readReports(response, identity);
          }
          if (listingMine) {
            return await readMine(response, identity);
          }
          if (listingFollowing) {
            return await readFollowing(response, identity);
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
                topic: isTopicId(request.query.topic) ? request.query.topic : null,
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
            if (verb === "move") {
              return await moveList(response, identity, id, request.body);
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
 * Their pictures live in a folder only they may read, so a face is a copy
 * somewhere everybody may, looked at by Vision on the same terms as a
 * published board. Catalogue art already has an address of its own.
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
  /** One topic's lists, in whatever section the topic has put them. */
  topic: string | null;
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
  if (filters.topic) {
    query = query.where("topicId", "==", filters.topic);
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
  // Filtered here rather than in the query: a `where` would need a composite
  // index for every combination of category, author and ordering, and a page
  // one short is invisible to somebody scrolling an endless feed.
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
 * Firestore answers `in` with at most thirty values, so this is several
 * queries merged, and the cursor is a pair of values rather than a document:
 * every run has to be resumed from the same place.
 */
async function readFollowingFeed(response: Response, identity: Identity, filters: FeedFilters): Promise<void> {
  const [authors, topics, sections] = await Promise.all([
    followedBy(identity.uid),
    followedTopicIds(identity.uid),
    followedSectionIds(identity.uid),
  ]);
  if (authors.length === 0 && topics.length === 0 && sections.length === 0) {
    // Not an error and not an empty feed: an answer the screen can say
    // something useful about, which "no lists" on its own cannot.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ lists: [], nextCursor: null, followingNobody: true });
    return;
  }

  const cursor = readCursor(filters.after);
  // People, topics and sections are sets of runs over the same page; a list
  // reached more than one way comes out once.
  const sectionRun = followedSectionRun(sections, filters.category);
  const runs = await Promise.all([
    ...chunked(authors).map((run) => followedRun("authorUid", run, filters, cursor)),
    ...chunked(topics).map((run) => followedRun("topicId", run, filters, cursor)),
    ...(sectionRun.length > 0 ? [followedRun("category", sectionRun, filters, cursor)] : []),
  ]);
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

/**
 * One run of up to thirty authors or topics, ordered the way the whole page
 * will be. A topic run narrows by category after reading: the index for that
 * combination was not worth keeping for a filter nobody has asked for yet.
 */
async function followedRun(
  field: "authorUid" | "topicId" | "category",
  values: string[],
  filters: FeedFilters,
  cursor: Cursor | null,
): Promise<FeedRow[]> {
  let query: FirebaseFirestore.Query = getFirestore()
    .collection(PUBLISHED)
    .where(field, "in", values);
  if (filters.category && field === "authorUid") {
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
    .filter((doc) => {
      const data = doc.data() as StoredList;
      const inCategory = filters.category === null || field !== "topicId" || data.category === filters.category;
      return data.underReview !== true && inCategory;
    })
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

/** The topics this person follows, at most as many as one page will draw from. */
async function followedTopicIds(uid: string): Promise<string[]> {
  const snapshot = await getFirestore()
    .collection(TOPIC_FOLLOWS)
    .where("follower", "==", uid)
    .limit(MAX_FOLLOWING)
    .get();
  return snapshot.docs.map((doc) => doc.get("topicId") as string);
}

/** The sections this person follows, in the order the app draws them. */
async function followedSectionIds(uid: string): Promise<Category[]> {
  const snapshot = await getFirestore().collection(SECTION_FOLLOWS).where("follower", "==", uid).get();
  const followed = new Set(snapshot.docs.map((doc) => doc.get("section") as string));
  return SECTION_IDS.filter((id) => followed.has(id));
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
 * Whom this person follows, each with the name and face their newest list
 * carries. Read wide on purpose: a manage screen is opened rarely, and an
 * author whose lists are all old must still come back with a name.
 */
async function readFollowing(response: Response, identity: Identity): Promise<void> {
  const db = getFirestore();
  const [followed, topicIds, sectionIds] = await Promise.all([
    followedBy(identity.uid),
    followedTopicIds(identity.uid),
    followedSectionIds(identity.uid),
  ]);
  const [pages, topicDocs, sectionCounts] = await Promise.all([
    Promise.all(
      chunked(followed).map((authors) =>
        db.collection(PUBLISHED).where("authorUid", "in", authors).orderBy("updatedAt", "desc").limit(MAX_FOLLOWING).get(),
      ),
    ),
    topicIds.length > 0 ? db.getAll(...topicIds.map((id) => db.collection(TOPICS).doc(id))) : Promise.resolve([]),
    Promise.all(sectionIds.map((id) => db.collection(SECTION_FOLLOWS).where("section", "==", id).count().get())),
  ]);
  const lists = pages.flatMap((page) => page.docs.map((doc) => doc.data() as StoredList));
  const topics = topicDocs
    .filter((doc) => doc.exists)
    .map((doc) => toTopic(doc.id, doc.data() as StoredTopic, true));
  const sections = sectionIds.map((id, at) => ({ id, followerCount: sectionCounts[at].data().count }));
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ authors: followedAuthors(followed, lists), topics, sections });
}

/** Paths under lists/sections: the nine with their counts, and following one. */
async function routeSections(method: string, rest: string[], response: Response, identity: Identity): Promise<void> {
  const [id = "", action = ""] = rest;
  if (id === "" && method === "GET") {
    return await readSections(response, identity);
  }
  if (action === FOLLOW && (method === "POST" || method === "DELETE")) {
    if (!isSectionId(id)) {
      response.status(404).json({ error: "No such section", code: "NOT_FOUND" });
      return;
    }
    return method === "POST" ? await followSection(response, identity, id) : await unfollowSection(response, identity, id);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

/** Counts change slowly and every reader asks for the same nine, so they are read once in a while, not per request. */
const sectionStats = new TimedCache<SectionStats[]>(SECTION_STATS_TTL_MS);

async function readSections(response: Response, identity: Identity): Promise<void> {
  const [stats, followed] = await Promise.all([
    sectionStats.get(readSectionStats),
    followedSectionIds(identity.uid),
  ]);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ sections: withFollowing(stats, new Set(followed)) });
}

async function readSectionStats(): Promise<SectionStats[]> {
  return await Promise.all(SECTION_IDS.map((id) => readOneSection(id)));
}

/**
 * One section's numbers. A list under review is subtracted rather than
 * filtered: Firestore cannot count "not true" over documents that lack the
 * field, and nearly every list lacks it.
 */
async function readOneSection(id: Category): Promise<SectionStats> {
  const db = getFirestore();
  const lists = db.collection(PUBLISHED).where("category", "==", id);
  const since = Timestamp.fromMillis(Date.now() - NEW_WINDOW_MS);
  const [all, hidden, recent, recentHidden, followers, collage] = await Promise.all([
    lists.count().get(),
    lists.where("underReview", "==", true).count().get(),
    lists.where("updatedAt", ">=", since).count().get(),
    lists.where("underReview", "==", true).where("updatedAt", ">=", since).count().get(),
    db.collection(SECTION_FOLLOWS).where("section", "==", id).count().get(),
    readCollage(id),
  ]);
  return {
    id,
    listCount: countWithout(all.data().count, hidden.data().count),
    followerCount: followers.data().count,
    newThisWeek: countWithout(recent.data().count, recentHidden.data().count),
    collage,
  };
}

/** The pictures of a section's most taken lists that may speak for it; see `pickCollage`. */
async function readCollage(id: Category): Promise<string[]> {
  const db = getFirestore();
  const top = await db
    .collection(PUBLISHED)
    .where("category", "==", id)
    .orderBy("takeCount", "desc")
    .limit(COLLAGE_READ)
    .get();
  const candidates: CollageCandidate[] = top.docs.map((doc) => {
    const data = doc.data() as StoredList;
    return {
      id: doc.id,
      rankingCount: data.rankingCount ?? 0,
      underReview: data.underReview === true,
      coverImageUrl: data.coverImageUrl ?? null,
      previewImages: data.previewImages ?? [],
    };
  });
  const eligible = candidates.filter((one) => !one.underReview && one.rankingCount > 0);
  const open = await Promise.all(
    eligible.map((one) => db.collection(REPORTS).where("listId", "==", one.id).limit(1).get()),
  );
  const reported = new Set(eligible.filter((_, at) => !open[at].empty).map((one) => one.id));
  return pickCollage(candidates, reported);
}

/** Following a section is open to anybody signed in; there are only nine, so no ceiling is needed. */
async function followSection(response: Response, identity: Identity, section: Category): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in to follow", code: "NOT_SIGNED_IN" });
    return;
  }
  await getFirestore()
    .collection(SECTION_FOLLOWS)
    .doc(sectionFollowId(identity.uid, section))
    .set({ follower: identity.uid, section, createdAt: FieldValue.serverTimestamp() });
  response.status(200).json({ following: true });
}

async function unfollowSection(response: Response, identity: Identity, section: Category): Promise<void> {
  await getFirestore().collection(SECTION_FOLLOWS).doc(sectionFollowId(identity.uid, section)).delete();
  response.status(200).json({ following: false });
}

/**
 * The count is read here rather than kept on the author, because there is no
 * author document: an author is whoever published something.
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
 * Authors worth following, taken from the lists people have taken most --
 * the only standing anybody has here. Read wide and thinned to one entry per
 * author; whoever is already followed is left out, and so is the reader.
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
 * The only thing the popular ordering counts. Once per person and written
 * down as a document, or one phone tapping all afternoon would decide what
 * everybody sees. Taking your own list back does not count either.
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
 * Straight from the collection rather than from the phone: a list published
 * from a device they no longer have is still theirs, and this is the only
 * place it can be seen or taken down.
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
  if (!(await isModeratorNow(identity))) {
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
  if (!(await isModeratorNow(identity))) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }

  const db = getFirestore();
  const [filed, listDoc] = await Promise.all([
    db.collection(REPORTS).where("listId", "==", listId).get(),
    db.collection(PUBLISHED).doc(listId).get(),
  ]);
  // The topic's count of lists comes down with the list; read before the batch removes it.
  const topicId = listDoc.exists ? (listDoc.data() as StoredList).topicId ?? null : null;
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
    if (topicId !== null) {
      batch.update(db.collection(TOPICS).doc(topicId), { listCount: FieldValue.increment(-1) });
    }
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
  // Hidden from the feed but open to anyone holding the address would hide it
  // from nobody. The moderator is the exception: the queue sends them here.
  if (data.underReview === true && !(await isModeratorNow(identity))) {
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
  let previous: StoredList | null = null;
  if (existingId) {
    const existing = await collection.doc(existingId).get();
    if (!existing.exists) {
      response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
      return;
    }
    previous = existing.data() as StoredList;
    if (previous.authorUid !== identity.uid) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
      return;
    }
  }

  // Where the board came from, settled before the pictures: the same cards
  // make this a ranking of that list, which copies nothing and names no topic.
  // A list of the author's own being replaced is a republish whatever it says.
  const source = body as Record<string, unknown>;
  const publication = existingId
    ? ({ kind: "list", basedOn: null } as Publication)
    : await resolvePublication(identity, readTakenFrom(source.takenFrom), decision.draft.items);
  if (publication.kind === "ranking") {
    return await rank(response, identity, publication.listId, decision.draft);
  }

  // Which topic, settled before the pictures as well: a refused topic should
  // cost nothing either.
  const asked = readTopicRequest(source.topicId, source.newTopic);
  if (!asked.ok) {
    refuseTopicRequest(response, asked.reason);
    return;
  }
  const attachment = await resolveAttachment(identity, asked.request, decision.draft.category);
  if (attachment.kind === "refuse") {
    refuseAttachment(response, attachment.reason);
    return;
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

  // A new topic is named here, with the list, so the two are written together.
  const topicRef = attachment.kind === "create" ? db.collection(TOPICS).doc() : null;
  const topicId = attachment.kind === "attach" ? attachment.topic.id : topicRef?.id ?? null;
  const topicName = attachment.kind === "attach" ? attachment.topic.name : attachment.kind === "create" ? attachment.name : null;

  const document = {
    authorUid: identity.uid,
    authorName: identity.name ?? "Anonymous",
    authorPhotoUrl: identity.picture,
    title: list.title,
    titleLower: list.titleLower,
    // A topic decides the section: an approved one brings its own, a waiting
    // one holds the list under "other" until somebody has looked.
    category: attachment.kind === "none" ? list.category : attachment.category,
    topicId,
    topicName,
    tiers: list.tiers,
    items: list.items,
    itemCount: list.items.length,
    coverImageUrl: list.coverImageUrl,
    previewImages: list.previewImages,
    tierColors: list.tierColors,
    basedOn: publication.basedOn,
    updatedAt: FieldValue.serverTimestamp(),
    // Replacing the contents replaces the snapshot, so it has not been looked
    // at. Merging without these left a shield for anything published behind it.
    underReview: false,
    reviewed: false,
  };

  const batch = db.batch();
  // The topics' counts of lists follow the list: off the one it leaves, onto
  // the one it joins, and a new topic starts at one.
  const previousTopic = previous?.topicId ?? null;
  if (previousTopic !== null && previousTopic !== topicId) {
    batch.update(db.collection(TOPICS).doc(previousTopic), { listCount: FieldValue.increment(-1) });
  }
  if (topicRef !== null && attachment.kind === "create") {
    batch.set(topicRef, {
      name: attachment.name,
      nameLower: attachment.nameLower,
      section: null,
      status: "pending",
      requestedSection: attachment.requestedSection,
      createdBy: identity.uid,
      proposerName: identity.name ?? "Anonymous",
      createdAt: FieldValue.serverTimestamp(),
      decidedAt: null,
      decidedBy: null,
      listCount: 1,
      followerCount: 0,
      mergedInto: null,
    });
  } else if (topicId !== null && topicId !== previousTopic) {
    batch.update(db.collection(TOPICS).doc(topicId), { listCount: FieldValue.increment(1) });
  }

  if (existingId) {
    batch.set(collection.doc(existingId), document, { merge: true });
    await batch.commit();
    await noteWordingConcern(existingId, document.title, identity, concern);
    // The board was edited for a month; the copies it no longer names are
    // nobody's, because the snapshot that pointed at them has been replaced.
    await discardUnusedPublished(existingId, [...addresses.keys()]);
    response.status(200).json({ id: existingId, topicId });
    return;
  }

  // Only on a new list: republishing merges, and a count written here would
  // reset it. Taking is about the list, not the snapshot.
  batch.set(collection.doc(target), {
    ...document,
    publishedAt: FieldValue.serverTimestamp(),
    takeCount: 0,
    rankingCount: 0,
  });
  await batch.commit();
  await noteWordingConcern(target, document.title, identity, concern);
  response.status(201).json({ id: target, topicId });
}

/** What the deciding needs to know about the list a board was saved from. */
async function resolvePublication(identity: Identity, takenFrom: string | null, items: Card[]): Promise<Publication> {
  if (takenFrom === null) {
    return decidePublication({ takenFrom, source: null, callerUid: identity.uid, items });
  }
  const doc = await getFirestore().collection(PUBLISHED).doc(takenFrom).get();
  const data = doc.exists ? (doc.data() as StoredList) : null;
  const source = data === null
    ? null
    : {
        id: doc.id,
        authorUid: data.authorUid,
        title: data.title,
        authorName: data.authorName,
        underReview: data.underReview === true,
        items: (data.items as Card[]) ?? [],
      };
  return decidePublication({ takenFrom, source, callerUid: identity.uid, items });
}

/**
 * The reader's placing of somebody's cards, kept beside that list and
 * counted on it once. Their tier names travel too, so a ranking with other
 * words than the author's still reads. Publishing it again replaces it.
 */
async function rank(
  response: Response,
  identity: Identity,
  listId: string,
  draft: { tiers: { label: string }[]; items: PlacedCard[] },
): Promise<void> {
  const db = getFirestore();
  const list = db.collection(PUBLISHED).doc(listId);
  const ranking = db.collection(RANKINGS).doc(`${listId}_${identity.uid}`);
  await db.runTransaction(async (transaction) => {
    const [source, existing] = await Promise.all([transaction.get(list), transaction.get(ranking)]);
    if (!source.exists) {
      return;
    }
    const cards = ((source.data() as StoredList).items as Card[]) ?? [];
    transaction.set(ranking, {
      listId,
      uid: identity.uid,
      authorName: identity.name ?? "Anonymous",
      authorPhotoUrl: identity.picture,
      arrangement: arrangementOver(cards, draft.items),
      tierLabels: draft.tiers.map((tier) => tier.label),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!existing.exists) {
      transaction.update(list, { rankingCount: FieldValue.increment(1) });
    }
  });
  response.status(200).json({ id: listId, ranking: true });
}

async function routeRankings(
  method: string,
  listId: string,
  rest: string,
  query: Record<string, unknown>,
  response: Response,
  identity: Identity,
): Promise<void> {
  if (method === "GET" && rest === "") {
    return await readRankings(response, identity, listId, singleParam(query.after));
  }
  if (method === "DELETE" && rest === "mine") {
    return await deleteMyRanking(response, identity, listId);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

function toRanking(data: StoredRanking) {
  return {
    uid: data.uid,
    authorName: data.authorName,
    authorPhotoUrl: data.authorPhotoUrl ?? null,
    arrangement: data.arrangement ?? [],
    tierLabels: data.tierLabels ?? [],
    updatedAtMs: data.updatedAt?.toMillis() ?? 0,
  };
}

/** Newest first, a page at a time, the reader's own ahead of the page it would otherwise sit in. */
async function readRankings(response: Response, identity: Identity, listId: string, after: string | null): Promise<void> {
  const db = getFirestore();
  const collection = db.collection(RANKINGS);
  let ordered: FirebaseFirestore.Query = collection.where("listId", "==", listId).orderBy("updatedAt", "desc");
  if (after) {
    const previous = await collection.doc(after).get();
    if (!previous.exists) {
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }
  const [page, mine] = await Promise.all([
    ordered.limit(RANKINGS_PAGE_SIZE).get(),
    after === null ? collection.doc(`${listId}_${identity.uid}`).get() : null,
  ]);
  const rankings = page.docs
    // Their own never sits in a page: it leads the first one and would repeat on a later one.
    .filter((doc) => (doc.data() as StoredRanking).uid !== identity.uid)
    .map((doc) => toRanking(doc.data() as StoredRanking));
  const withMine = mine?.exists ? [toRanking(mine.data() as StoredRanking), ...rankings] : rankings;
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    rankings: mineFirst(withMine, identity.uid),
    nextCursor: nextCursor(page.docs.map((doc) => doc.id), RANKINGS_PAGE_SIZE),
  });
}

async function deleteMyRanking(response: Response, identity: Identity, listId: string): Promise<void> {
  const db = getFirestore();
  const list = db.collection(PUBLISHED).doc(listId);
  const ranking = db.collection(RANKINGS).doc(`${listId}_${identity.uid}`);
  await db.runTransaction(async (transaction) => {
    const [source, existing] = await Promise.all([transaction.get(list), transaction.get(ranking)]);
    if (!existing.exists) {
      return;
    }
    transaction.delete(ranking);
    if (source.exists) {
      const count = (source.data() as StoredList).rankingCount ?? 0;
      transaction.update(list, { rankingCount: Math.max(0, count - 1) });
    }
  });
  response.status(204).send();
}

/** A list that is gone takes its rankings with it; nobody can open them without it. */
async function discardRankings(listId: string): Promise<void> {
  const db = getFirestore();
  const carrying = await db.collection(RANKINGS).where("listId", "==", listId).get();
  for (const part of chunked(carrying.docs, WRITES_PER_BATCH)) {
    const batch = db.batch();
    part.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

function refuseTopicRequest(response: Response, reason: "both" | "bad_name" | "bad_id"): void {
  switch (reason) {
    case "both":
      response.status(400).json({ error: "Pick a topic or name a new one, not both", code: "INVALID" });
      return;
    case "bad_name":
      response.status(400).json({ error: "A topic name is two to forty characters", code: "INVALID" });
      return;
    case "bad_id":
      response.status(400).json({ error: "Which topic?", code: "INVALID" });
      return;
  }
}

function refuseAttachment(response: Response, reason: "bad_id" | "not_available" | "too_many_pending"): void {
  switch (reason) {
    case "bad_id":
      response.status(400).json({ error: "No such topic", code: "INVALID" });
      return;
    case "not_available":
      response.status(400).json({ error: "That topic is not open to you", code: "TOPIC_UNAVAILABLE" });
      return;
    case "too_many_pending":
      response.status(409).json({ error: "Three of your topics are still waiting", code: "TOO_MANY_PENDING_TOPICS" });
      return;
  }
}

/** What the deciding needs to know about the topic a publication asked for. */
async function resolveAttachment(identity: Identity, request: TopicRequest, chosen: Category): Promise<Attachment> {
  if (request.kind === "none") {
    return { kind: "none" };
  }
  const topics = getFirestore().collection(TOPICS);
  const base = { request, chosenCategory: chosen, callerUid: identity.uid };
  if (request.kind === "existing") {
    const snapshot = await topics.doc(request.topicId).get();
    const byId = snapshot.exists ? knownTopic(snapshot.id, snapshot.data() as StoredTopic) : null;
    return decideAttachment({ ...base, byId, approvedByName: null, ownPendingByName: null, pendingCount: 0 });
  }
  const [approved, ownPending, pending] = await Promise.all([
    topics.where("nameLower", "==", request.nameLower).where("status", "==", "approved").limit(1).get(),
    topics
      .where("nameLower", "==", request.nameLower)
      .where("status", "==", "pending")
      .where("createdBy", "==", identity.uid)
      .limit(1)
      .get(),
    topics.where("createdBy", "==", identity.uid).where("status", "==", "pending").count().get(),
  ]);
  const first = (snapshot: FirebaseFirestore.QuerySnapshot): KnownTopic | null =>
    snapshot.empty ? null : knownTopic(snapshot.docs[0].id, snapshot.docs[0].data() as StoredTopic);
  return decideAttachment({
    ...base,
    byId: null,
    approvedByName: first(approved),
    ownPendingByName: first(ownPending),
    pendingCount: pending.data().count,
  });
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
  const stored = existing.data() as StoredList;
  if (stored.authorUid !== identity.uid) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const batch = getFirestore().batch();
  batch.delete(doc);
  if (stored.topicId) {
    batch.update(getFirestore().collection(TOPICS).doc(stored.topicId), { listCount: FieldValue.increment(-1) });
  }
  await batch.commit();
  await discardPublished(id);
  await discardRankings(id);
  response.status(204).send();
}

/**
 * Puts a board the classifier was unsure about in front of the person who
 * reads the queue, filed as a report under a reporter id nobody can hold so
 * it is settled by the same two buttons. Never blocks the publication: the
 * classifier cannot tell a film list about sex scenes from pornography.
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

/**
 * Everything under lists/topics: the approved ones to pick from, somebody's
 * own, the queue, one topic, following it, and the moderator's four words.
 */
async function routeTopics(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  const [first = "", second = ""] = rest;
  if (method === "GET") {
    if (first === "") {
      return await readTopics(response, identity, {
        prefix: searchTerm(query.q),
        section: categoryFilter(query.section),
        limit: topicsPageSize(query.limit),
      });
    }
    if (first === "mine") return await readMyTopics(response, identity);
    if (first === "pending") return await readPendingTopics(response, identity);
    if (second === "") return await readTopic(response, identity, first);
  }
  if (method === "POST" && first !== "") {
    if (second === "follow") return await followTopic(response, identity, first);
    const action = TOPIC_ACTIONS.find((known) => known === second);
    if (action) return await settleTopic(response, identity, first, action, body);
  }
  if (method === "DELETE" && first !== "" && second === "follow") {
    return await unfollowTopic(response, identity, first);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

interface TopicFilters {
  prefix: string | null;
  section: Category | null;
  limit: number;
}

/** Approved topics: the ones that start with what was typed, or the biggest, within a section if asked. */
async function readTopics(response: Response, identity: Identity, filters: TopicFilters): Promise<void> {
  let query: FirebaseFirestore.Query = getFirestore().collection(TOPICS).where("status", "==", "approved");
  if (filters.prefix) {
    query = query
      .where("nameLower", ">=", filters.prefix)
      .where("nameLower", "<=", `${filters.prefix}`)
      .orderBy("nameLower");
  } else {
    if (filters.section) {
      query = query.where("section", "==", filters.section);
    }
    query = query.orderBy("listCount", "desc");
  }

  const [snapshot, followed] = await Promise.all([query.limit(filters.limit).get(), followedTopicIds(identity.uid)]);
  const mine = new Set(followed);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    topics: snapshot.docs.map((doc) => toTopic(doc.id, doc.data() as StoredTopic, mine.has(doc.id))),
  });
}

/** Everything this person proposed, whatever became of it: the waiting ones first. */
async function readMyTopics(response: Response, identity: Identity): Promise<void> {
  const [snapshot, followed] = await Promise.all([
    getFirestore().collection(TOPICS).where("createdBy", "==", identity.uid).limit(TOPICS_READ).get(),
    followedTopicIds(identity.uid),
  ]);
  const mine = new Set(followed);
  const topics = orderMine(
    snapshot.docs.map((doc) => {
      const data = doc.data() as StoredTopic;
      return {
        status: data.status,
        createdAtMs: data.createdAt?.toMillis() ?? 0,
        topic: toTopic(doc.id, data, mine.has(doc.id)),
      };
    }),
  ).map((one) => one.topic);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ topics });
}

/**
 * The queue, oldest first, each with who asked, where they wanted it and the
 * approved topics it might be a twin of -- the three things a decision needs.
 */
async function readPendingTopics(response: Response, identity: Identity): Promise<void> {
  if (!(await isModeratorNow(identity))) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const db = getFirestore();
  const snapshot = await db.collection(TOPICS).where("status", "==", "pending").limit(TOPICS_READ).get();
  const waiting = snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as StoredTopic }))
    .sort((left, right) => (left.data.createdAt?.toMillis() ?? 0) - (right.data.createdAt?.toMillis() ?? 0));

  const topics = await Promise.all(
    waiting.map(async ({ id, data }) => {
      const pending = knownTopic(id, data);
      const word = pending.nameLower.split(" ")[0] ?? "";
      const candidates = word.length === 0
        ? []
        : (
            await db
              .collection(TOPICS)
              .where("status", "==", "approved")
              .where("nameLower", ">=", word)
              .where("nameLower", "<=", `${word}`)
              .orderBy("nameLower")
              .limit(SIMILAR_TOPICS + 1)
              .get()
          ).docs.map((doc) => ({ doc, known: knownTopic(doc.id, doc.data() as StoredTopic) }));
      const similar = similarTopics(pending, candidates.map((one) => one.known)).map((known) => {
        const found = candidates.find((one) => one.known.id === known.id)!;
        return toTopic(found.doc.id, found.doc.data() as StoredTopic, false);
      });
      return {
        ...toTopic(id, data, false),
        proposerName: data.proposerName,
        requestedSection: data.requestedSection ?? null,
        similar,
      };
    }),
  );

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ topics });
}

async function readTopic(response: Response, identity: Identity, topicId: string): Promise<void> {
  if (!isTopicId(topicId)) {
    response.status(400).json({ error: "Which topic?", code: "INVALID" });
    return;
  }
  const db = getFirestore();
  const [doc, follow] = await Promise.all([
    db.collection(TOPICS).doc(topicId).get(),
    db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId)).get(),
  ]);
  if (!doc.exists) {
    response.status(404).json({ error: "No such topic", code: "NOT_FOUND" });
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json(toTopic(doc.id, doc.data() as StoredTopic, follow.exists));
}

/**
 * Following a topic is following an approved word; a waiting one is a label,
 * not yet a place. Idempotent, and the topic's count moves only when the
 * follow is new, inside one transaction.
 */
async function followTopic(response: Response, identity: Identity, topicId: string): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in to follow", code: "NOT_SIGNED_IN" });
    return;
  }
  if (!isTopicId(topicId)) {
    response.status(400).json({ error: "Which topic?", code: "INVALID" });
    return;
  }
  const db = getFirestore();
  const topicRef = db.collection(TOPICS).doc(topicId);
  const already = await db.collection(TOPIC_FOLLOWS).where("follower", "==", identity.uid).count().get();
  if (already.data().count >= MAX_FOLLOWING) {
    response.status(409).json({ error: "Following too many topics", code: "TOO_MANY_FOLLOWING" });
    return;
  }

  const outcome = await db.runTransaction(async (transaction) => {
    const topic = await transaction.get(topicRef);
    if (!topic.exists) return "missing";
    if ((topic.data() as StoredTopic).status !== "approved") return "not_approved";
    const followRef = db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId));
    if ((await transaction.get(followRef)).exists) return "already";
    transaction.set(followRef, { follower: identity.uid, topicId, createdAt: FieldValue.serverTimestamp() });
    transaction.update(topicRef, { followerCount: FieldValue.increment(1) });
    return "followed";
  });

  switch (outcome) {
    case "missing":
      response.status(404).json({ error: "No such topic", code: "NOT_FOUND" });
      return;
    case "not_approved":
      response.status(409).json({ error: "That topic is still waiting", code: "NOT_APPROVED" });
      return;
    default:
      response.status(200).json({ following: true });
  }
}

async function unfollowTopic(response: Response, identity: Identity, topicId: string): Promise<void> {
  if (!isTopicId(topicId)) {
    response.status(400).json({ error: "Which topic?", code: "INVALID" });
    return;
  }
  const db = getFirestore();
  const followRef = db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId));
  await db.runTransaction(async (transaction) => {
    if (!(await transaction.get(followRef)).exists) return;
    transaction.delete(followRef);
    const topicRef = db.collection(TOPICS).doc(topicId);
    if ((await transaction.get(topicRef)).exists) {
      transaction.update(topicRef, { followerCount: FieldValue.increment(-1) });
    }
  });
  response.status(200).json({ following: false });
}

/**
 * A moderator's word on a topic: approved into a section, renamed, merged into
 * another, or rejected. The lists carrying it are rewritten in the same
 * breath, in parts small enough for a batch.
 */
async function settleTopic(
  response: Response,
  identity: Identity,
  topicId: string,
  action: TopicAction,
  body: unknown,
): Promise<void> {
  if (!(await isModeratorNow(identity))) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  if (!isTopicId(topicId)) {
    response.status(400).json({ error: "Which topic?", code: "INVALID" });
    return;
  }
  const db = getFirestore();
  const ref = db.collection(TOPICS).doc(topicId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    response.status(404).json({ error: "No such topic", code: "NOT_FOUND" });
    return;
  }
  const topic = knownTopic(topicId, snapshot.data() as StoredTopic);

  const source = (body ?? {}) as Record<string, unknown>;
  let into: KnownTopic | null = null;
  if (action === "merge" && isTopicId(source.into)) {
    const target = await db.collection(TOPICS).doc(source.into).get();
    into = target.exists ? knownTopic(target.id, target.data() as StoredTopic) : null;
  }

  const outcome = decideTopicAction(action, topic, { section: source.section, name: source.name, into });
  if (!outcome.ok) {
    refuseTopicAction(response, outcome.reason);
    return;
  }

  const carrying = await db.collection(PUBLISHED).where("topicId", "==", topicId).get();
  for (const part of chunked(carrying.docs, WRITES_PER_BATCH)) {
    const batch = db.batch();
    part.forEach((doc) => batch.update(doc.ref, outcome.lists));
    await batch.commit();
  }

  const update: Record<string, unknown> = { ...outcome.topic };
  if (outcome.decided) {
    update.decidedAt = FieldValue.serverTimestamp();
    update.decidedBy = identity.uid;
  }
  if (action === "merge" && into !== null) {
    update.listCount = 0;
    await db.collection(TOPICS).doc(into.id).update({ listCount: FieldValue.increment(carrying.size) });
  }
  if (action === "reject") {
    update.listCount = 0;
  }
  await ref.update(update);

  const [fresh, follow] = await Promise.all([
    ref.get(),
    db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId)).get(),
  ]);
  response.status(200).json(toTopic(topicId, fresh.data() as StoredTopic, follow.exists));
}

function refuseTopicAction(
  response: Response,
  reason: "no_section" | "bad_name" | "settled" | "no_target" | "target_not_approved" | "itself",
): void {
  switch (reason) {
    case "no_section":
      response.status(400).json({ error: "Approving needs a section", code: "INVALID" });
      return;
    case "bad_name":
      response.status(400).json({ error: "A topic name is two to forty characters", code: "INVALID" });
      return;
    case "settled":
      response.status(409).json({ error: "That topic has been decided already", code: "SETTLED" });
      return;
    case "no_target":
      response.status(400).json({ error: "Merge into which topic?", code: "INVALID" });
      return;
    case "target_not_approved":
      response.status(400).json({ error: "Merge into an approved topic", code: "INVALID" });
      return;
    case "itself":
      response.status(400).json({ error: "A topic cannot be merged into itself", code: "INVALID" });
      return;
  }
}

/**
 * A moderator moves one list: into a topic, which brings its section, or into
 * a section, which keeps the list's topic only while the two still agree.
 */
async function moveList(response: Response, identity: Identity, listId: string, body: unknown): Promise<void> {
  if (!(await isModeratorNow(identity))) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const db = getFirestore();
  const ref = db.collection(PUBLISHED).doc(listId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  const stored = snapshot.data() as StoredList;
  const source = (body ?? {}) as Record<string, unknown>;
  const from = stored.topicId ?? null;

  let update: { category: Category; topicId: string | null; topicName: string | null };
  if (Object.prototype.hasOwnProperty.call(source, "topicId") && source.topicId !== null) {
    if (!isTopicId(source.topicId)) {
      response.status(400).json({ error: "Which topic?", code: "INVALID" });
      return;
    }
    const target = await db.collection(TOPICS).doc(source.topicId).get();
    const topic = target.exists ? (target.data() as StoredTopic) : null;
    if (!topic || topic.status !== "approved" || topic.section === null) {
      response.status(400).json({ error: "Move into an approved topic", code: "INVALID" });
      return;
    }
    update = { category: topic.section, topicId: target.id, topicName: topic.name };
  } else {
    const category = CATEGORIES.find((known) => known === source.category);
    if (!category) {
      response.status(400).json({ error: "Which section?", code: "INVALID" });
      return;
    }
    let keeps = false;
    if (from !== null && !Object.prototype.hasOwnProperty.call(source, "topicId")) {
      const current = await db.collection(TOPICS).doc(from).get();
      keeps = current.exists && (current.data() as StoredTopic).section === category;
    }
    update = keeps
      ? { category, topicId: from, topicName: stored.topicName ?? null }
      : { category, topicId: null, topicName: null };
  }

  const batch = db.batch();
  batch.update(ref, update);
  if (from !== null && from !== update.topicId) {
    batch.update(db.collection(TOPICS).doc(from), { listCount: FieldValue.increment(-1) });
  }
  if (update.topicId !== null && update.topicId !== from) {
    batch.update(db.collection(TOPICS).doc(update.topicId), { listCount: FieldValue.increment(1) });
  }
  await batch.commit();
  response.status(204).send();
}

/**
 * Who may decide topics and complaints besides the configured person. Only
 * that person appoints or removes: a moderator who could make moderators
 * would make the role mean nothing.
 */
async function routeModerators(
  method: string,
  uid: string,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  if (!isModerator(identity)) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const roles = getFirestore().collection(ROLES);
  if (method === "GET" && uid === "") {
    const snapshot = await roles.where("moderator", "==", true).get();
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      moderators: snapshot.docs.map((doc) => ({
        uid: doc.id,
        name: (doc.get("name") as string | undefined) ?? "",
        photoUrl: (doc.get("photoUrl") as string | null | undefined) ?? null,
        appointedAt: (doc.get("appointedAt") as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0,
      })),
    });
    return;
  }
  if (!isUid(uid)) {
    response.status(400).json({ error: "Which person?", code: "INVALID" });
    return;
  }
  if (method === "POST") {
    if (uid === identity.uid) {
      response.status(409).json({ error: "You already decide here", code: "YOURSELF" });
      return;
    }
    const source = (body ?? {}) as Record<string, unknown>;
    const photoUrl = typeof source.photoUrl === "string" && source.photoUrl.startsWith("https://") ? source.photoUrl : null;
    await roles.doc(uid).set({
      moderator: true,
      appointedBy: identity.uid,
      appointedAt: FieldValue.serverTimestamp(),
      name: cleanText(source.name, MAX_TITLE_LENGTH) ?? "",
      photoUrl,
    });
    response.status(200).json({ uid, moderator: true });
    return;
  }
  if (method === "DELETE") {
    await roles.doc(uid).delete();
    response.status(204).send();
    return;
  }
  response.status(405).json({ error: "Use GET, POST or DELETE" });
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed.slice(0, maxLength);
}
