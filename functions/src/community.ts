import { defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { FieldPath, FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  anonymityAfter,
  fillVisible,
  isAnonymous,
  mineFor,
  ownAuthor,
  shownAuthor,
  viewerFollowsFor,
  authorsToAsk,
  type ListReader,
} from "./anonymous";
import { auditEntry, changedFields, type AuditAction, type AuditEntry } from "./audit";
import { bylineOf, decideEditorialAccess, EDITORIAL_UID, editorialByline, type Byline } from "./editorial";
import { matchPeople, MIN_QUERY_LENGTH, personOf, type Person } from "./people";
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
  addressOf,
  copyAsFace,
  copyForPublication,
  discardPublished,
  discardUnusedPublished,
} from "./publishedPictures";
import {
  FEED_PAGE_SIZE,
  REPORT_PAGE_SIZE,
  MAX_TITLE_LENGTH,
  decidePublish,
  picturesWanted,
  settle,
  tierCountsOf,
  type PublishDecision,
} from "./publishing";
import {
  arrangementOver,
  creditNeedsRewrite,
  decidePublication,
  isOwnedRanking,
  mineFirst,
  rankingCursor,
  readRankingCursor,
  rankingRefusal,
  rankingWrite,
  RANKINGS_PAGE_SIZE,
  readRankingBody,
  rowsFromDocument,
  rowsToDocument,
  readTakenFrom,
  shownCredit,
  type BasedOn,
  type Card,
  type PlacedCard,
  type Publication,
} from "./rankings";
import {
  ACTIVITY_WINDOW_MS,
  answerFor,
  APPROVED_EDIT_FIELDS,
  base36Of,
  BUILT_IN_SECTION_IDS,
  BUILT_IN_SECTIONS,
  builtInRecord,
  collageImage,
  checkName,
  countWithout,
  decideDeletion,
  decideOrder,
  decideProposal,
  decideProposalQuota,
  decideSectionAction,
  decideSectionChoice,
  decideWithdrawal,
  DEFAULT_ICON,
  findClash,
  followedSectionRun,
  isOpen,
  isSectionId,
  liveTopics,
  MAX_DECLINE_NOTE_LENGTH,
  mayCall,
  notYetEditable,
  PENDING_EDIT_FIELDS,
  pictureEditRefusal,
  namesAfter,
  nameKey,
  NEUTRAL_COLOURS,
  NEW_WINDOW_MS,
  newSection,
  noStats,
  orderSections,
  OTHER,
  pickCollage,
  pickSectionId,
  readSectionEdits,
  recentProposals,
  releasedNames,
  reservationClash,
  SECTION_ACTIONS,
  SECTION_STATS_TTL_MS,
  sectionFollowId,
  SECTIONS_TTL_MS,
  sectionsListedFor,
  sectionView,
  TimedCache,
  waitingFor,
  WITHDRAWN_LISTS,
  type CollageCandidate,
  type EditRefusal,
  type NameClash,
  type NameReservation,
  type ProposalRefusal,
  type Role,
  type SectionAction,
  type SectionActionRefusal,
  type SectionCall,
  type SectionChoice,
  type SectionEdits,
  type SectionOutcome,
  type SectionPicture,
  type SectionRecord,
  type SectionStats,
  type SectionStatus,
  type SectionView,
  finishCallOf,
  TOPIC_DECISIONS,
  type TopicDecision,
  type Viewer,
} from "./sections";
import {
  coloursFromChosenTint,
  coloursFromPalette,
  coloursFromPicture,
  coloursFromTint,
  paletteOf,
  type ColourPair,
  type SectionColours,
} from "./sectionColours";
import { CONTENT_TYPES, judgePicture, type PictureRefusal } from "./imageSize";
import {
  bucketName,
  discardProposalPicture,
  discardSectionPictures,
  discardStoredPicture,
  keepForProposal,
  pictureIdOf,
  proposalPath,
  publishSectionPicture,
  readOwnPicture,
  readStoredPicture,
  realPictureColours,
  sectionPicturePath,
  discardTopicPictures,
  keepingOnlyIfWritten,
  replacedSectionPicture,
  replacedTopicPicture,
  tokenAddressOf,
  topicPicturePath,
} from "./sectionPictures";
import { decideApproveAsTopic, decideMergeIntoTopic, mergeTopicId, nameClashOf, topicKeyOf } from "./proposalTopic";
import { adminKeeps, publishedByFor, readAdminListsQuery, readsBySection } from "./adminLists";
import { matchesSearch, missOf, searchFieldsFor, searchQueryOf } from "./search";
import { igdbClientId, igdbClientSecret, pictureTmdbToken, routePictures } from "./pictureSearch";
import {
  cleanTopicName,
  decideAttachment,
  decideTopicAction,
  decideTopicCreation,
  decideTopicDeletion,
  decideTopicEdit,
  impliedTopic,
  MAX_TOPIC_HOPS,
  topicHop,
  readTopicPictureId,
  isTopicId,
  mayKnowProposer,
  orderMine,
  readTopicRequest,
  similarTopics,
  SIMILAR_TOPICS,
  topicReservationClash,
  topicsPageSize,
  TOPIC_ACTIONS,
  type Attachment,
  type KnownTopic,
  type Topic,
  type TopicAction,
  type TopicReader,
  type TopicRequest,
  type TopicReservation,
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
const SECTIONS = "sections";
const CONFIG = "config";
/** One document per name a section holds, so two claims to one name meet in one place. */
const SECTION_NAMES = "sectionNames";
/** One document per account that proposes, holding the times of its recent proposals. */
const SECTION_PROPOSERS = "sectionProposers";
const SECTIONS_CONFIG = "sections";
/** One line per decision the owner or a moderator made. */
const AUDIT_LOG = "auditLog";
/** One document per lower-cased topic name, so two claims to one name meet in one place. */
const TOPIC_NAMES = "topicNames";
const VERBS = ["report", "takedown", "dismiss", "taken", "move"];

/** Paths that are not about one list: topics and the people who may decide them. */
const TOPICS_PATH = "topics";
const MODERATORS_PATH = "moderators";
const RANKINGS_PATH = "rankings";
const SECTIONS_PATH = "sections";
const PROPOSALS_PATH = "proposals";
const QUEUE_PATH = "queue";
const ORDER_PATH = "order";
const NAME_CHECK_PATH = "name-check";
const ADMIN_PATH = "admin";
const EDITORIAL_PATH = "editorial";
const SEARCH_MISSES_PATH = "search-misses";
const PICTURES_PATH = "pictures";
const SEARCH_MISSES = "searchMisses";
const CANDIDATES_PATH = "candidates";
const APPROVE_AS_TOPIC: TopicDecision = "approve-as-topic";
const MERGE_INTO_TOPIC: TopicDecision = "merge-into-topic";

/** How many accounts the candidate index holds at most; past that, appointing needs the uid. */
const MAX_INDEXED_ACCOUNTS = 10_000;

/** How long the candidate index is kept before Auth is listed again. */
const PEOPLE_TTL_MS = 5 * 60 * 1000;

/** How many proposals the moderators' queue reads at once. */
const SECTION_QUEUE_READ = 200;

/** How many times a new section's id is picked again after losing a race for it. */
const SECTION_ID_ATTEMPTS = 5;

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
 * The configured person is the owner; whoever they have appointed since is a
 * moderator, by a role in the database written only by these functions on
 * the owner's word. The owner alone appoints, so the door is still one
 * person's to open.
 */
async function roleOf(identity: Identity): Promise<Role | null> {
  if (isModerator(identity)) return "owner";
  const role = await getFirestore().collection(ROLES).doc(identity.uid).get();
  return role.exists && role.get("moderator") === true ? "moderator" : null;
}

async function isModeratorNow(identity: Identity): Promise<boolean> {
  return (await roleOf(identity)) !== null;
}

const MAX_NOTE_LENGTH = 500;


interface StoredList {
  /** Words to be found by (src/search.ts); absent on a list stored before search had them. */
  searchKeys?: string[];
  authorUid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  title: string;
  titleLower: string;
  category: string;
  tiers: unknown[];
  items: unknown[];
  itemCount: number;
  coverImageUrl: string | null;
  previewImages: string[];
  tierColors: string[];
  /** The topic this list carries, if any; the name is copied so a card needs no second read. */
  topicId?: string | null;
  topicName?: string | null;
  /** The author's own proposed section, which the list moves into once approved; meanwhile it sits in `category`. */
  proposedSection?: string | null;
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
  /** Published without the author's name; the author is still stored, for owning it. */
  anonymous?: boolean;
  /** Cards per tier in tier order, the unranked last; worked out on read for lists published before it was kept. */
  tierCounts?: number[];
}

interface StoredRanking {
  listId: string;
  uid: string;
  authorName: string;
  authorPhotoUrl: string | null;
  arrangement: (number | null)[];
  /** The cards of each tier left to right; absent on rankings stored without them. */
  rows?: { items: number[] }[];
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

/** Old lists keep the word "null" as their cover; only a web address goes out as a picture. */
export function webPicture(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

/**
 * A list as one reader is told it: an anonymous one by nobody, and so is a
 * copy's credit to one; `mine` when the reader is the one who published it,
 * and whether they follow its author when `followed` says whom they follow.
 */
export function toSummary(
  id: string,
  data: StoredList,
  reader: ListReader | null = null,
  followed: ReadonlySet<string> | null = null,
) {
  return {
    id,
    title: data.title,
    ...shownAuthor(data),
    ...mineFor(data, reader),
    ...viewerFollowsFor(data, reader, followed),
    tierCounts: Array.isArray(data.tierCounts)
      ? data.tierCounts
      : tierCountsOf((data.tiers ?? []).length, (data.items ?? []) as { tierIndex?: unknown }[]),
    category: data.category ?? "other",
    itemCount: data.itemCount,
    coverImageUrl: webPicture(data.coverImageUrl),
    previewImages: (data.previewImages ?? []).filter((url) => webPicture(url) !== null),
    tierColors: data.tierColors ?? [],
    topicId: data.topicId ?? null,
    topicName: data.topicName ?? null,
    updatedAt: data.updatedAt?.toMillis() ?? 0,
    takeCount: data.takeCount ?? 0,
    rankingCount: data.rankingCount ?? 0,
    basedOn: shownCredit(data.basedOn),
  };
}

interface StoredTopic {
  name: string;
  nameLower: string;
  section: string | null;
  status: TopicStatus;
  /** The section the proposer wanted; the moderator's hint, not the answer. */
  requestedSection: string | null;
  createdBy: string;
  proposerName: string;
  createdAt?: FirebaseFirestore.Timestamp;
  decidedAt?: FirebaseFirestore.Timestamp | null;
  decidedBy?: string | null;
  listCount?: number;
  followerCount?: number;
  mergedInto?: string | null;
  names?: Record<string, string>;
  /** Public, at topics/{id}/{pictureId}; absent or null for a topic without one. */
  picture?: SectionPicture | null;
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

/** A topic as one reader is told it; see `mayKnowProposer` for who learns who proposed it. */
export function toTopic(id: string, data: StoredTopic, following: boolean, reader: TopicReader): Topic {
  return {
    id,
    name: data.name,
    names: data.names ?? {},
    section: data.section ?? null,
    status: data.status,
    listCount: data.listCount ?? 0,
    followerCount: data.followerCount ?? 0,
    following,
    ...(mayKnowProposer(data.createdBy, reader) ? { createdBy: data.createdBy } : {}),
    mergedInto: data.mergedInto ?? null,
    pictureUrl: data.picture?.url ?? null,
  };
}

export const lists = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
    // Picture search asks TMDB itself (src/pictureSearch.ts).
    secrets: [pictureTmdbToken, igdbClientId, igdbClientSecret],
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
    const listingAnonymous = !verb && id === "anonymous";
    const query = request.query as Record<string, unknown>;

    try {
      // Topics and moderators have their own small trees of paths.
      if (segments[0] === TOPICS_PATH) {
        return await routeTopics(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[0] === MODERATORS_PATH) {
        return await routeModerators(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[0] === ADMIN_PATH) {
        return await routeAdmin(request.method, segments.slice(1), query, response, identity);
      }
      if (segments[0] === PICTURES_PATH) {
        return await routePictures(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[0] === SEARCH_MISSES_PATH && segments.length === 1) {
        return await routeSearchMisses(request.method, request.body, response, identity);
      }
      if (segments[0] === EDITORIAL_PATH) {
        return await routeEditorial(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[0] === SECTIONS_PATH) {
        return await routeSections(request.method, segments.slice(1), query, request.body, response, identity);
      }
      if (segments[1] === RANKINGS_PATH && segments[0]) {
        return await routeRankings(request.method, segments[0], segments[2] ?? "", query, request.body, response, identity);
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
          if (listingAnonymous) {
            return await readAnonymousLists(response, identity, singleParam(request.query.after));
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

/** Anything that could not be a section id means "no filter", not an error. */
function categoryFilter(raw: unknown): string | null {
  return isSectionId(raw) ? raw : null;
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
  category: string | null;
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

  // A search asks for one word and keeps what has the others (src/search.ts),
  // in the order Firestore keeps them, so pages resume where they stopped.
  const search = searchQueryOf(filters.query);
  if (filters.query !== null && search === null) {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ lists: [], nextCursor: null });
    return;
  }
  let ordered = search
    ? query.where("searchKeys", "array-contains", search.key)
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

  // Filtered here rather than in the query: a `where` would need a composite
  // index for every combination of category, author and ordering, and lists
  // stored before `anonymous` existed lack the field an equality would need.
  // An anonymous list stays off its author's page, where the page's name
  // would be its author's; everywhere else it goes out by nobody.
  const shown = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    const data = doc.data() as StoredList;
    return data.underReview !== true && !(filters.author !== null && isAnonymous(data)) && (search === null || matchesSearch(doc.get("searchKeys"), search));
  };
  const page = await fillVisible(
    async (last) => (await (last ? ordered.startAfter(last) : ordered).limit(FEED_PAGE_SIZE).get()).docs,
    shown,
    FEED_PAGE_SIZE,
  );
  const followed = await followsAmong(identity, page.rows.map((doc) => doc.data() as StoredList));

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: page.rows.map((doc) => toSummary(doc.id, doc.data() as StoredList, identity, followed)),
    nextCursor: page.next?.id ?? null,
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
  const followed = identity.isAnonymous ? null : new Set(authors);
  // People, topics and sections are sets of runs over the same page; a list
  // reached more than one way comes out once.
  const sectionRun = followedSectionRun(sections, filters.category);
  const runs = await Promise.all([
    ...chunked(authors).map((run) => followedRun("authorUid", run, filters, cursor, identity, followed)),
    ...chunked(topics).map((run) => followedRun("topicId", run, filters, cursor, identity, followed)),
    ...chunked(sectionRun).map((run) => followedRun("category", run, filters, cursor, identity, followed)),
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
  reader: ListReader,
  followed: ReadonlySet<string> | null,
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

  // An anonymous list never reaches anybody for following its author; by a
  // topic or a section it still may, by nobody.
  const shown = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    const data = doc.data() as StoredList;
    const inCategory = filters.category === null || field !== "topicId" || data.category === filters.category;
    return data.underReview !== true && inCategory && !(field === "authorUid" && isAnonymous(data));
  };
  const page = await fillVisible(
    async (last) => (await (last ? ordered.startAfter(last) : ordered).limit(FEED_PAGE_SIZE).get()).docs,
    shown,
    FEED_PAGE_SIZE,
  );
  return page.rows
    .map((doc) => {
      const data = doc.data() as StoredList;
      return {
        id: doc.id,
        updatedAt: data.updatedAt?.toMillis() ?? 0,
        takeCount: data.takeCount ?? 0,
        summary: toSummary(doc.id, data, reader, followed),
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

/** The sections this person follows, at most as many as one page will draw from. */
async function followedSectionIds(uid: string): Promise<string[]> {
  const snapshot = await getFirestore()
    .collection(SECTION_FOLLOWS)
    .where("follower", "==", uid)
    .limit(MAX_FOLLOWING)
    .get();
  return snapshot.docs.map((doc) => doc.get("section") as string);
}

/**
 * Which of a page's authors a signed-in reader follows: one document per
 * author on the page, at most a page of them; nothing for a guest, who follows nobody.
 */
async function followsAmong(identity: Identity, lists: readonly StoredList[]): Promise<Set<string> | null> {
  if (identity.isAnonymous) return null;
  const authors = authorsToAsk(lists, identity);
  if (authors.length === 0) return new Set();
  const db = getFirestore();
  const docs = await db.getAll(...authors.map((author) => db.collection(FOLLOWS).doc(followId(identity.uid, author))));
  return new Set(authors.filter((_, at) => docs[at].exists));
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
  const [pages, topicDocs, approved, numbers] = await Promise.all([
    Promise.all(
      chunked(followed).map((authors) =>
        db.collection(PUBLISHED).where("authorUid", "in", authors).orderBy("updatedAt", "desc").limit(MAX_FOLLOWING).get(),
      ),
    ),
    topicIds.length > 0 ? db.getAll(...topicIds.map((id) => db.collection(TOPICS).doc(id))) : Promise.resolve([]),
    approvedSections(),
    currentStats(),
  ]);
  const lists = pages.flatMap((page) => page.docs.map((doc) => doc.data() as StoredList));
  const topics = topicDocs
    .filter((doc) => doc.exists)
    .map((doc) => toTopic(doc.id, doc.data() as StoredTopic, true, { uid: identity.uid, staff: false }));
  // In the order the tiles are drawn; one approved a moment ago elsewhere goes last until this instance knows it.
  const known = new Map(approved.map((one) => [one.id, one]));
  const ordered = [
    ...orderSections(sectionIds.flatMap((id) => known.get(id) ?? []), new Set(), activityOf(numbers)).map((one) => one.id),
    ...sectionIds.filter((id) => !known.has(id)),
  ];
  const sections = ordered.map((id) => ({ id, followerCount: numbers.stats.get(id)?.followerCount ?? 0 }));
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ authors: followedAuthors(followed, lists), topics, sections });
}

/**
 * A section as stored. Every field is written when the document is made, so
 * the defaults in `sectionRecord` only guard against a document edited by hand.
 */
interface StoredSection {
  name?: string;
  names?: Record<string, string>;
  icon?: string;
  picture?: SectionPicture | null;
  tint?: ColourPair;
  topicBg?: ColourPair;
  topicIcon?: ColourPair;
  status?: SectionStatus;
  builtIn?: boolean;
  hidden?: boolean;
  rank?: number | null;
  fileUnder?: string | null;
  mergedInto?: string | null;
  mergedTopicId?: string | null;
  proposerUid?: string | null;
  proposerName?: string | null;
  proposalPicture?: string | null;
  proposalPictureUrl?: string | null;
  palette?: string[];
  unfinished?: boolean;
  decidedAs?: string | null;
  declineNote?: string | null;
  dismissedAt?: FirebaseFirestore.Timestamp | null;
  withdrawn?: boolean;
  tintChosen?: boolean;
  createdAt?: FirebaseFirestore.Timestamp;
  approvedAt?: FirebaseFirestore.Timestamp | null;
  decidedAt?: FirebaseFirestore.Timestamp | null;
  decidedBy?: string | null;
}

function sectionRecord(id: string, data: StoredSection): SectionRecord {
  const derived = data.tint ? coloursFromTint(data.tint.light) : NEUTRAL_COLOURS;
  return {
    id,
    name: data.name ?? id,
    names: data.names ?? {},
    icon: data.icon ?? DEFAULT_ICON,
    picture: data.picture ?? null,
    tint: data.tint ?? derived.tint,
    topicBg: data.topicBg ?? derived.topicBg,
    topicIcon: data.topicIcon ?? derived.topicIcon,
    status: data.status ?? "pending",
    builtIn: data.builtIn === true,
    hidden: data.hidden === true,
    rank: data.rank ?? null,
    fileUnder: data.fileUnder ?? null,
    mergedInto: data.mergedInto ?? null,
    mergedTopicId: data.mergedTopicId ?? null,
    proposerUid: data.proposerUid ?? null,
    proposerName: data.proposerName ?? null,
    proposalPicture: data.proposalPicture ?? null,
    proposalPictureUrl: data.proposalPictureUrl ?? null,
    palette: data.palette ?? [],
    unfinished: data.unfinished === true,
    decidedAs: TOPIC_DECISIONS.find((one) => one === data.decidedAs) ?? null,
    declineNote: data.declineNote ?? null,
    dismissed: data.dismissedAt != null,
    withdrawn: data.withdrawn === true,
    tintChosen: data.tintChosen === true,
    createdAtMs: data.createdAt?.toMillis() ?? 0,
    approvedAtMs: data.approvedAt?.toMillis() ?? null,
    decidedAtMs: data.decidedAt?.toMillis() ?? null,
    decidedBy: data.decidedBy ?? null,
  };
}

const timestampOf = (ms: number | null) => (ms === null ? null : Timestamp.fromMillis(ms));

function newSectionDocument(record: SectionRecord): Record<string, unknown> {
  return {
    name: record.name,
    names: record.names,
    icon: record.icon,
    picture: record.picture,
    tint: record.tint,
    topicBg: record.topicBg,
    topicIcon: record.topicIcon,
    status: record.status,
    builtIn: record.builtIn,
    hidden: record.hidden,
    rank: record.rank,
    fileUnder: record.fileUnder,
    mergedInto: record.mergedInto,
    mergedTopicId: record.mergedTopicId,
    proposerUid: record.proposerUid,
    proposerName: record.proposerName,
    proposalPicture: record.proposalPicture,
    proposalPictureUrl: record.proposalPictureUrl,
    palette: record.palette,
    unfinished: record.unfinished,
    declineNote: record.declineNote,
    dismissedAt: null,
    withdrawn: record.withdrawn,
    tintChosen: record.tintChosen,
    createdAt: Timestamp.fromMillis(record.createdAtMs),
    approvedAt: timestampOf(record.approvedAtMs),
    decidedAt: timestampOf(record.decidedAtMs),
    decidedBy: record.decidedBy,
  };
}

/** Firestore's code for a document `create` found already there. */
const ALREADY_EXISTS = 6;
const alreadyExists = (error: unknown) => (error as { code?: unknown } | null)?.code === ALREADY_EXISTS;

/**
 * The built-ins are ordinary documents, made the first time one is missed.
 * Seeding rather than migrating: `create` writes only what is absent, and
 * leaves alone anything a moderator has changed since.
 */
async function seedBuiltIns(ids: readonly string[]): Promise<SectionRecord[]> {
  const sections = getFirestore().collection(SECTIONS);
  return await Promise.all(
    BUILT_IN_SECTIONS.filter((one) => ids.includes(one.id)).map(async (builtIn) => {
      const record = builtInRecord(builtIn);
      try {
        await sections.doc(builtIn.id).create(newSectionDocument(record));
        return record;
      } catch (error) {
        if (!alreadyExists(error)) throw error;
        const doc = await sections.doc(builtIn.id).get();
        return sectionRecord(doc.id, doc.data() as StoredSection);
      }
    }),
  );
}

async function withBuiltIns(records: SectionRecord[], wanted: readonly string[] = BUILT_IN_SECTION_IDS): Promise<SectionRecord[]> {
  const missing = wanted.filter((id) => BUILT_IN_SECTION_IDS.includes(id) && !records.some((one) => one.id === id));
  return missing.length === 0 ? records : [...records, ...(await seedBuiltIns(missing))];
}

async function readSectionsWhere(statuses: readonly SectionStatus[]): Promise<SectionRecord[]> {
  const snapshot = await getFirestore().collection(SECTIONS).where("status", "in", [...statuses]).get();
  const records = await withBuiltIns(snapshot.docs.map((doc) => sectionRecord(doc.id, doc.data() as StoredSection)));
  return records.filter((one) => statuses.includes(one.status));
}

/** Every section there is, read fresh: for comparing names, picking ids and the moderators' history. */
async function readAllSections(): Promise<SectionRecord[]> {
  const snapshot = await getFirestore().collection(SECTIONS).get();
  return await withBuiltIns(snapshot.docs.map((doc) => sectionRecord(doc.id, doc.data() as StoredSection)));
}

/** Read fresh rather than from the cache: whatever is decided here must not act on a section as it was. */
async function readSectionsById(ids: readonly string[]): Promise<Map<string, SectionRecord>> {
  const wanted = [...new Set(ids.filter(isSectionId))];
  if (wanted.length === 0) return new Map();
  const db = getFirestore();
  const docs = await db.getAll(...wanted.map((id) => db.collection(SECTIONS).doc(id)));
  const found = docs.filter((doc) => doc.exists).map((doc) => sectionRecord(doc.id, doc.data() as StoredSection));
  return new Map((await withBuiltIns(found, wanted)).map((one) => [one.id, one]));
}

async function readSectionById(id: string): Promise<SectionRecord | null> {
  return (await readSectionsById([id])).get(id) ?? null;
}

async function proposedBy(uid: string): Promise<SectionRecord[]> {
  const snapshot = await getFirestore().collection(SECTIONS).where("proposerUid", "==", uid).get();
  return snapshot.docs.map((doc) => sectionRecord(doc.id, doc.data() as StoredSection));
}

/** The ids of whichever of these sections new lists and topics may go into. */
function openSectionIds(sections: readonly (SectionRecord | null)[]): Set<string> {
  return new Set(sections.filter((one): one is SectionRecord => one !== null && isOpen(one)).map((one) => one.id));
}

/**
 * A name's reservation: one document per compared form of a name, so two
 * sections claiming the same name at the same moment meet in one document
 * and one of them loses. Hashed, because a name may hold characters a
 * document id may not.
 */
function reservationRef(key: string): FirebaseFirestore.DocumentReference {
  return getFirestore().collection(SECTION_NAMES).doc(createHash("sha256").update(key).digest("hex"));
}

/** Inside a transaction: which section other than `self` already holds one of these names. Reads only. */
async function reservedBy(
  transaction: FirebaseFirestore.Transaction,
  names: readonly string[],
  self: string | null,
): Promise<string | null> {
  const keys = [...new Set(names.map(nameKey))];
  if (keys.length === 0) return null;
  const docs = await transaction.getAll(...keys.map(reservationRef));
  const reservations = docs
    .filter((doc) => doc.exists)
    .map((doc) => ({ key: doc.get("key") as string, sectionId: doc.get("sectionId") as string }));
  const holderIds = [...new Set(reservations.map((one) => one.sectionId))].filter((id) => id !== self && isSectionId(id));
  const sections = getFirestore().collection(SECTIONS);
  const holders = holderIds.length === 0 ? [] : await transaction.getAll(...holderIds.map((id) => sections.doc(id)));
  const known = new Map(
    holders.filter((doc) => doc.exists).map((doc) => [doc.id, sectionRecord(doc.id, doc.data() as StoredSection)]),
  );
  return reservationClash(keys, reservations, known, self);
}

function reserveNames(transaction: FirebaseFirestore.Transaction, names: readonly string[], sectionId: string): void {
  for (const key of new Set(names.map(nameKey))) {
    transaction.set(reservationRef(key), { key, sectionId, reservedAt: FieldValue.serverTimestamp() });
  }
}

/** Inside a transaction: the first id for this name that no document has, read rather than assumed. */
async function freeSectionId(
  transaction: FirebaseFirestore.Transaction,
  name: string,
  known: readonly string[],
): Promise<string> {
  const taken = new Set(known);
  for (let attempt = 1; ; attempt++) {
    const id = pickSectionId(name, taken, () => base36Of(randomBytes(8)));
    if (!(await transaction.get(getFirestore().collection(SECTIONS).doc(id))).exists) return id;
    if (attempt >= SECTION_ID_ATTEMPTS) throw new Error(`No free section id for ${id}`);
    taken.add(id);
  }
}

/**
 * Which of the owner's and moderators' edits the order screen was drawn
 * from. Saving the order names it, and a save drawn from an older one is
 * refused rather than undoing somebody else's work.
 */
const sectionsConfig = () => getFirestore().collection(CONFIG).doc(SECTIONS_CONFIG);

async function readSectionsVersion(): Promise<number> {
  const config = await sectionsConfig().get();
  return (config.get("version") as number | undefined) ?? 0;
}

async function bumpSectionsVersion(): Promise<void> {
  await sectionsConfig().set({ version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

interface StatsRead {
  readAtMs: number;
  stats: Map<string, SectionStats>;
}

/**
 * The approved sections and their counts change slowly and every reader asks
 * for the same ones, so they are read once in a while, not per request. So
 * are the names already taken, which a name check reads on every keystroke.
 * A change on this instance forgets what it touched.
 */
const approvedSectionsCache = new TimedCache<SectionRecord[]>(SECTIONS_TTL_MS);
const claimedSectionsCache = new TimedCache<SectionRecord[]>(SECTIONS_TTL_MS);
const sectionStats = new TimedCache<StatsRead>(SECTION_STATS_TTL_MS);

async function approvedSections(): Promise<SectionRecord[]> {
  return await approvedSectionsCache.get(() => readSectionsWhere(["approved"]));
}

async function currentStats(): Promise<StatsRead> {
  return await sectionStats.get(async () => {
    const sections = await approvedSections();
    const stats = await Promise.all(sections.map((one) => readOneSection(one.id)));
    return { readAtMs: Date.now(), stats: new Map(stats.map((one) => [one.id, one])) };
  });
}

function forgetSections(): void {
  approvedSectionsCache.invalidate();
  claimedSectionsCache.invalidate();
  sectionStats.invalidate();
}

function activityOf(read: StatsRead): (id: string) => number {
  return (id) => read.stats.get(id)?.lists30d ?? 0;
}

/** A section approved since the counts were read has none yet in them, so it is counted on its own. */
async function statsOf(id: string): Promise<SectionStats> {
  return (await currentStats()).stats.get(id) ?? (await readOneSection(id));
}

async function countWhere(collection: string, field: string, value: string): Promise<number> {
  const counted = await getFirestore().collection(collection).where(field, "==", value).count().get();
  return counted.data().count;
}

const waitingCount = (id: string) => countWhere(PUBLISHED, "proposedSection", id);

/**
 * Everything under lists/sections: the list and one section, a name check,
 * following one, proposing and taking a proposal back, and the calls of the
 * owner and the moderators.
 */
async function routeSections(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  const [first = "", second = ""] = rest;
  if (rest.length <= 2) {
    if (first === "" && method === "GET") return await readSections(response, identity);
    if (first === "" && method === "POST") return await createSection(response, identity, body);
    if (first === NAME_CHECK_PATH && second === "" && method === "GET") return await checkSectionName(response, query);
    if (first === QUEUE_PATH && second === "" && method === "GET") return await readSectionQueue(response, identity);
    if (first === ORDER_PATH && second === "" && method === "PUT") return await putSectionOrder(response, identity, body);
    if (first === PROPOSALS_PATH) {
      if (second === "" && method === "POST") return await proposeSection(response, identity, body);
      if (second !== "" && method === "DELETE") return await withdrawProposal(response, identity, second);
    } else if (first !== "") {
      if (second === "" && method === "GET") return await readSection(response, identity, first);
      if (second === "" && method === "PATCH") return await editSection(response, identity, first, body);
      if (second === "" && method === "DELETE") return await deleteSection(response, identity, first);
      if (second === FOLLOW && method === "POST") return await followSection(response, identity, first);
      if (second === FOLLOW && method === "DELETE") return await unfollowSection(response, identity, first);
      if (second === APPROVE_AS_TOPIC && method === "POST") return await approveAsTopic(response, identity, first, body);
      if (second === MERGE_INTO_TOPIC && method === "POST") return await mergeIntoTopic(response, identity, first, body);
      const action = SECTION_ACTIONS.find((known) => known === second);
      if (action && method === "POST") return await settleSection(response, identity, first, action, body);
    }
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

/** The caller's role, or the refusal already sent when it is not one this call wants. */
async function roleFor(response: Response, identity: Identity, call: SectionCall): Promise<Role | null> {
  const role = await roleOf(identity);
  if (mayCall(role, call)) return role;
  response.status(403).json({
    error: "Not yours",
    code: "NOT_YOURS",
    ...(role === null ? {} : { detail: "owner_only" }),
  });
  return null;
}

/**
 * The approved sections in the order every client draws them, then the
 * caller's own proposals. The owner and moderators also get the hidden
 * sections and every proposal, decline and merge there has been, and the
 * version the order screen saves against.
 */
async function readSections(response: Response, identity: Identity): Promise<void> {
  const role = await roleOf(identity);
  const staff = role !== null;
  const [cached, numbers, followed, others, version] = await Promise.all([
    staff ? [] : approvedSections(),
    currentStats(),
    followedSectionIds(identity.uid),
    staff ? readAllSections() : identity.isAnonymous ? [] : proposedBy(identity.uid),
    staff ? readSectionsVersion() : null,
  ]);
  // What was read fresh wins over the cache: their own section approved a
  // moment ago on another instance is theirs to see now.
  const approved = new Map(cached.map((one) => [one.id, one]));
  others.filter((one) => one.status === "approved").forEach((one) => approved.set(one.id, one));

  const viewer: Viewer = { uid: identity.uid, moderator: staff };
  const { tiles, proposals } = sectionsListedFor(viewer, [...approved.values()], others);
  const waiting = await Promise.all(proposals.map((one) => (one.status === "pending" ? waitingCount(one.id) : 0)));
  const following = new Set(followed);
  const sections = [
    ...orderSections(tiles, following, activityOf(numbers)).map((one) =>
      sectionView(one, viewer, numbers.stats.get(one.id) ?? noStats(one.id), following.has(one.id)),
    ),
    ...proposals.map((one, at) => sectionView(one, viewer, noStats(one.id), false, waiting[at])),
  ];
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ sections, updatedAt: numbers.readAtMs, version, role });
}

/**
 * Four counts and their under-review parts: Firestore cannot count "not true"
 * over documents that lack the field, and nearly every list lacks it, so the
 * hidden ones are counted and subtracted.
 */
async function readOneSection(id: string): Promise<SectionStats> {
  const db = getFirestore();
  const lists = db.collection(PUBLISHED).where("category", "==", id);
  const hidden = lists.where("underReview", "==", true);
  const week = Timestamp.fromMillis(Date.now() - NEW_WINDOW_MS);
  const month = Timestamp.fromMillis(Date.now() - ACTIVITY_WINDOW_MS);
  const [all, allHidden, recent, recentHidden, active, activeHidden, followers, collage] = await Promise.all([
    lists.count().get(),
    hidden.count().get(),
    lists.where("updatedAt", ">=", week).count().get(),
    hidden.where("updatedAt", ">=", week).count().get(),
    lists.where("updatedAt", ">=", month).count().get(),
    hidden.where("updatedAt", ">=", month).count().get(),
    db.collection(SECTION_FOLLOWS).where("section", "==", id).count().get(),
    readCollage(id),
  ]);
  return {
    id,
    listCount: countWithout(all.data().count, allHidden.data().count),
    lists30d: countWithout(active.data().count, activeHidden.data().count),
    newThisWeek: countWithout(recent.data().count, recentHidden.data().count),
    followerCount: followers.data().count,
    collage,
  };
}

/** The pictures of a section's most taken lists that may speak for it; see `pickCollage`. */
async function readCollage(id: string): Promise<string[]> {
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

/** Whether a name is free while somebody types it. The proposal itself is checked again, against a fresh read. */
async function checkSectionName(response: Response, query: Record<string, unknown>): Promise<void> {
  const claimed = await claimedSectionsCache.get(() => readSectionsWhere(["approved", "pending"]));
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json(checkName(query.name, claimed));
}

/**
 * One section, for a link or an id a client has not met; see `answerFor` for
 * who is told what. A hidden one still answers: its lists are still
 * reachable by link.
 */
async function readSection(response: Response, identity: Identity, id: string): Promise<void> {
  const found = isSectionId(id) ? await readSectionById(id) : null;
  // The moderators' role is read only when it could change the answer.
  const everybodys =
    found === null ||
    found.status === "approved" ||
    (found.status === "merged" && found.approvedAtMs !== null) ||
    found.proposerUid === identity.uid;
  const viewer: Viewer = { uid: identity.uid, moderator: !everybodys && (await isModeratorNow(identity)) };
  const answer = answerFor(found, viewer);
  if (found === null || answer === "missing") return noSuchSection(response);
  if (answer === "merged") return merged(response, found.mergedInto as string, found.mergedTopicId);
  response.setHeader("Cache-Control", "no-store");
  if (found.status !== "approved") {
    const pending = found.status === "pending";
    const [waiting, clashes] = await Promise.all([
      pending ? waitingCount(id) : 0,
      pending && viewer.moderator ? nameClashesOf([found]) : null,
    ]);
    const view = sectionView(found, viewer, noStats(id), false, waiting);
    response.status(200).json(clashes === null ? view : withClash(view, clashes[0]));
    return;
  }
  const [stats, follow] = await Promise.all([
    statsOf(id),
    getFirestore().collection(SECTION_FOLLOWS).doc(sectionFollowId(identity.uid, id)).get(),
  ]);
  response.status(200).json(sectionView(found, viewer, stats, follow.exists));
}

function noSuchSection(response: Response): void {
  response.status(404).json({ error: "No such section", code: "NOT_FOUND" });
}

function merged(response: Response, into: string, topicId: string | null = null): void {
  response.status(410).json({
    error: "That section was merged into another",
    code: "MERGED",
    detail: into,
    mergedInto: into,
    ...(topicId === null ? {} : { mergedTopicId: topicId }),
  });
}

/**
 * Following is open to anybody signed in, and only to an approved section.
 * There is a ceiling now that there is no longer a fixed nine.
 */
async function followSection(response: Response, identity: Identity, id: string): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in to follow", code: "NOT_SIGNED_IN" });
    return;
  }
  const found = isSectionId(id) ? await readSectionById(id) : null;
  if (found !== null && answerFor(found, { uid: identity.uid, moderator: false }) === "merged") {
    return merged(response, found.mergedInto as string);
  }
  if (found?.status !== "approved") return noSuchSection(response);

  const db = getFirestore();
  const ref = db.collection(SECTION_FOLLOWS).doc(sectionFollowId(identity.uid, id));
  const [mine, already] = await Promise.all([
    ref.get(),
    db.collection(SECTION_FOLLOWS).where("follower", "==", identity.uid).count().get(),
  ]);
  if (!mine.exists) {
    if (already.data().count >= MAX_FOLLOWING) {
      response.status(409).json({ error: "Following too many sections", code: "TOO_MANY_FOLLOWING" });
      return;
    }
    await ref.set({ follower: identity.uid, section: id, createdAt: FieldValue.serverTimestamp() });
  }
  response.status(200).json({ following: true });
}

async function unfollowSection(response: Response, identity: Identity, id: string): Promise<void> {
  if (!isSectionId(id)) return noSuchSection(response);
  await getFirestore().collection(SECTION_FOLLOWS).doc(sectionFollowId(identity.uid, id)).delete();
  response.status(200).json({ following: false });
}

/** Writing about sections takes the same door as publishing: a real account, not banned. */
async function refuseWriter(response: Response, identity: Identity): Promise<boolean> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return true;
  }
  const ban = await readBan(identity.uid);
  if (isBanned(ban, Date.now())) {
    response.status(403).json({ error: "You cannot propose sections at the moment", ...noticeFor(ban) });
    return true;
  }
  return false;
}

type SectionRefusal = ProposalRefusal | EditRefusal | { code: "BAD_PICTURE"; why: PictureRefusal };

/** Every refusal is `{error, code, detail?}`; the older field names ride along for the app's first draft. */
function refuseSection(response: Response, refusal: SectionRefusal): void {
  switch (refusal.code) {
    case "BAD_NAME":
      response.status(400).json({ error: "A section name is two to twenty-four characters", code: refusal.code });
      return;
    case "NAME_TAKEN":
      response.status(400).json({
        error: "There is a section by that name already",
        code: refusal.code,
        detail: refusal.id,
        id: refusal.id,
      });
      return;
    case "BAD_ICON":
      response.status(400).json({ error: "Pick one of the offered icons", code: refusal.code });
      return;
    case "BAD_FILE_UNDER":
      response.status(400).json({ error: "File the lists under an open section", code: refusal.code });
      return;
    case "BAD_PICTURE":
      response.status(400).json({
        error: "That picture cannot be a section's",
        code: refusal.code,
        detail: refusal.why,
        why: refusal.why,
      });
      return;
    case "TOO_MANY_PENDING":
      response.status(400).json({ error: "Three of your sections are still waiting", code: refusal.code });
      return;
    case "TOO_MANY_PROPOSALS":
      response.status(429).json({ error: "That is enough proposals for one day", code: refusal.code });
      return;
    case "INVALID":
      response.status(400).json({ error: refusal.detail, code: refusal.code, detail: refusal.detail });
      return;
  }
}

function refuseSectionAction(response: Response, reason: SectionActionRefusal): void {
  switch (reason) {
    case "settled":
      response.status(409).json({ error: "That section has been decided already", code: "SETTLED" });
      return;
    case "built_in":
      response.status(409).json({ error: "A built-in section stays", code: "BUILT_IN" });
      return;
    case "no_target":
      response.status(400).json({ error: "Merge into which section?", code: "INVALID", detail: "into" });
      return;
    case "itself":
      response.status(400).json({ error: "A section cannot be merged into itself", code: "INVALID", detail: "into" });
      return;
    case "target_not_approved":
      response.status(400).json({ error: "Merge into an approved section", code: "INVALID", detail: "into" });
      return;
  }
}

/** Vision's colours of a picture, or none when it cannot be asked: a palette is a help, not a condition. */
async function paletteFor(bytes: Buffer): Promise<string[]> {
  try {
    return paletteOf(await realPictureColours(bytes));
  } catch (error) {
    console.warn("No palette for a proposal", error);
    return [];
  }
}

type Created = { code: null; record: SectionRecord } | SectionRefusal;

/**
 * A proposal: judged on everything but its picture first, then the picture
 * is measured, then one transaction checks the account's allowance and the
 * name and writes the section; last the picture is copied out of the
 * proposer's folder before the daily sweep can take it.
 */
async function proposeSection(response: Response, identity: Identity, body: unknown): Promise<void> {
  if (await refuseWriter(response, identity)) return;
  const db = getFirestore();
  const allowance = db.collection(SECTION_PROPOSERS).doc(identity.uid);
  const [sections, used] = await Promise.all([readAllSections(), allowance.get()]);
  const decision = decideProposal({ body, callerUid: identity.uid, sections });
  if (!decision.ok) return refuseSection(response, decision);
  // Asked before the download and Vision, so a day's last refusal costs nothing; the transaction asks again.
  if (decideProposalQuota(0, recentProposals(used.get("recent"), Date.now())) !== null) {
    return refuseSection(response, { code: "TOO_MANY_PROPOSALS" });
  }

  const bytes = await readOwnPicture(identity.uid, decision.pictureId);
  const judged = judgePicture(bytes);
  if (!judged.ok || bytes === null) return refuseSection(response, { code: "BAD_PICTURE", why: judged.ok ? "missing" : judged.why });

  const token = randomUUID();
  const bucket = bucketName();
  const palette = await paletteFor(bytes);
  // The account's own document is read and written by every proposal it
  // makes, so two at once are taken one after the other, never side by side.
  const created = await db.runTransaction(async (transaction): Promise<Created> => {
    const now = Date.now();
    const [held, mine] = await Promise.all([
      transaction.get(allowance),
      transaction.get(db.collection(SECTIONS).where("proposerUid", "==", identity.uid)),
    ]);
    const recent = recentProposals(held.get("recent"), now);
    const quota = decideProposalQuota(mine.docs.filter((doc) => doc.get("status") === "pending").length, recent);
    if (quota !== null) return { code: quota };
    const clash = await reservedBy(transaction, [decision.name], null);
    if (clash !== null) return { code: "NAME_TAKEN", id: clash };
    const id = await freeSectionId(transaction, decision.name, sections.map((one) => one.id));
    const path = proposalPath(id, decision.pictureId);
    const record: SectionRecord = {
      ...newSection(id, decision.name, now),
      icon: decision.icon,
      fileUnder: decision.fileUnder,
      proposerUid: identity.uid,
      proposerName: identity.name ?? "Anonymous",
      proposalPicture: path,
      proposalPictureUrl: tokenAddressOf(bucket, path, token),
      palette,
    };
    transaction.create(db.collection(SECTIONS).doc(id), newSectionDocument(record));
    reserveNames(transaction, [decision.name], id);
    transaction.set(allowance, { recent: [...recent, now], updatedAt: FieldValue.serverTimestamp() });
    return { code: null, record };
  });
  if (created.code !== null) return refuseSection(response, created);

  const { record } = created;
  try {
    await keepForProposal(record.proposalPicture as string, bytes, CONTENT_TYPES[judged.size.format], token);
  } catch (error) {
    await db.collection(SECTIONS).doc(record.id).delete();
    throw error;
  }
  claimedSectionsCache.invalidate();
  response.status(201).json(sectionView(record, { uid: identity.uid, moderator: false }, noStats(record.id), false));
}

/**
 * The proposer taking a waiting proposal back, or putting away what became
 * of a declined or merged one. Decided in a transaction, like the moderators'
 * words, so whichever comes first stands and the other is told it is too late.
 */
async function withdrawProposal(response: Response, identity: Identity, id: string): Promise<void> {
  if (await refuseWriter(response, identity)) return;
  if (!isSectionId(id)) return noSuchSection(response);
  const db = getFirestore();
  const ref = db.collection(SECTIONS).doc(id);
  const outcome = await db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(ref);
    const section = fresh.exists ? sectionRecord(id, fresh.data() as StoredSection) : null;
    const what = decideWithdrawal(section, identity.uid);
    const putAway = { dismissedAt: FieldValue.serverTimestamp(), proposalPicture: null, proposalPictureUrl: null };
    if (what === "withdraw") {
      // Kept, as declined by its own proposer and already put away: its id
      // stays taken, so no later section can inherit lists that still name it.
      transaction.update(ref, {
        ...putAway,
        status: "declined",
        declineNote: null,
        decidedAt: FieldValue.serverTimestamp(),
        decidedBy: identity.uid,
        unfinished: true,
        withdrawn: true,
      });
    } else if (what === "dismiss") {
      transaction.update(ref, putAway);
    }
    return { what, status: section?.status ?? null };
  });
  if (outcome.what === "missing") return noSuchSection(response);
  if (outcome.what === "settled") {
    response.status(409).json({ error: "That section has been decided already", code: "SETTLED" });
    return;
  }
  // A declined proposal's lists stop waiting; doing it again is doing nothing.
  if (outcome.what === "withdraw" || outcome.status === "declined") {
    await rewriteWhere(PUBLISHED, "proposedSection", id, WITHDRAWN_LISTS);
    await ref.update({ unfinished: false });
  }
  await discardProposalPicture(id);
  if (outcome.what === "withdraw") claimedSectionsCache.invalidate();
  response.status(204).send();
}

/**
 * The queue, oldest first, each with who asked, its picture, its palette and
 * how many lists wait for it; then the decisions whose lists were not all
 * moved, oldest decision first, each with `finish`, the call that completes it.
 */
async function readSectionQueue(response: Response, identity: Identity): Promise<void> {
  if ((await roleFor(response, identity, "queue")) === null) return;
  const sections = getFirestore().collection(SECTIONS);
  const [pending, unfinished] = await Promise.all([
    sections.where("status", "==", "pending").limit(SECTION_QUEUE_READ).get(),
    sections.where("unfinished", "==", true).limit(SECTION_QUEUE_READ).get(),
  ]);
  const waiting = pending.docs
    .map((doc) => sectionRecord(doc.id, doc.data() as StoredSection))
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  const stuck = unfinished.docs
    .map((doc) => sectionRecord(doc.id, doc.data() as StoredSection))
    .filter((one) => one.status !== "pending" && finishCallOf(one) !== null)
    .sort((left, right) => (left.decidedAtMs ?? 0) - (right.decidedAtMs ?? 0));
  const [counts, clashes, stuckCounts] = await Promise.all([
    Promise.all(waiting.map((one) => waitingCount(one.id))),
    nameClashesOf(waiting),
    Promise.all(stuck.map((one) => waitingCount(one.id))),
  ]);
  const viewer: Viewer = { uid: identity.uid, moderator: true };
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    sections: [
      ...waiting.map((one, at) => withClash(sectionView(one, viewer, noStats(one.id), false, counts[at]), clashes[at])),
      ...stuck.map((one, at) => withClash(sectionView(one, viewer, noStats(one.id), false, stuckCounts[at]), null)),
    ],
  });
}

function withClash(view: SectionView, nameClash: NameClash): SectionView {
  return { ...view, nameClash };
}

/**
 * For the staff: what each waiting proposal's name already belongs to, read
 * from the reservations the names are claimed by. Two reads per proposal, its
 * topic name and its section name, then the holders, each step one batch.
 */
async function nameClashesOf(proposals: readonly SectionRecord[]): Promise<NameClash[]> {
  if (proposals.length === 0) return [];
  const db = getFirestore();
  const topicKeys = proposals.map((one) => topicKeyOf(one.name));
  const sectionKeys = proposals.map((one) => nameKey(one.name));
  const askedTopics = [...new Set(topicKeys.filter((key): key is string => key !== null))];
  const askedSections = [...new Set(sectionKeys)];
  const [topicDocs, sectionDocs] = await Promise.all([
    askedTopics.length === 0 ? [] : db.getAll(...askedTopics.map(topicReservationRef)),
    db.getAll(...askedSections.map(reservationRef)),
  ]);
  const topicReservations = new Map<string, TopicReservation>(
    topicDocs
      .filter((doc) => doc.exists)
      .map((doc) => [doc.get("key") as string, { key: doc.get("key") as string, topicId: doc.get("topicId") as string }]),
  );
  const byKey = new Map<string, NameReservation>(
    sectionDocs
      .filter((doc) => doc.exists)
      .map((doc) => [doc.get("key") as string, { key: doc.get("key") as string, sectionId: doc.get("sectionId") as string }]),
  );
  const sectionReservations = sectionKeys.map((key) => byKey.get(key) ?? null);
  const topicIds = [...new Set([...topicReservations.values()].map((one) => one.topicId).filter(isTopicId))];
  const [holders, sections] = await Promise.all([
    topicIds.length === 0 ? [] : db.getAll(...topicIds.map((id) => db.collection(TOPICS).doc(id))),
    readSectionsById(sectionReservations.flatMap((one, at) => (one === null || one.sectionId === proposals[at].id ? [] : [one.sectionId]))),
  ]);
  const topics = new Map(
    holders.filter((doc) => doc.exists).map((doc) => [doc.id, knownTopic(doc.id, doc.data() as StoredTopic)]),
  );
  const topicSections = [...topics.values()].flatMap((one) => (one.section === null || sections.has(one.section) ? [] : [one.section]));
  (await readSectionsById(topicSections)).forEach((one, id) => sections.set(id, one));
  return proposals.map((proposal, at) => {
    const key = topicKeys[at];
    const topicReservation = key === null ? null : topicReservations.get(key) ?? null;
    return nameClashOf(proposal, {
      topicReservation,
      topic: topicReservation === null ? null : topics.get(topicReservation.topicId) ?? null,
      sectionReservation: sectionReservations[at],
      sections,
    });
  });
}

type MeasuredPicture =
  | { ok: true; bytes: Buffer; contentType: string; width: number; height: number }
  | { ok: false; why: PictureRefusal };

type PreparedPicture = (MeasuredPicture & { ok: false }) | (MeasuredPicture & { ok: true; colours: SectionColours });

/** Vision's look at a picture's colours; when Vision cannot be asked, the palette it gave at proposal time. */
async function pictureColours(bytes: Buffer, palette: readonly string[]): Promise<SectionColours> {
  try {
    return coloursFromPicture(await realPictureColours(bytes), NEUTRAL_COLOURS);
  } catch (error) {
    const fallback = coloursFromPalette(palette);
    if (fallback === null) throw error;
    console.warn("Vision unavailable; colours from the proposal's palette", error);
    return fallback;
  }
}

/**
 * A picture measured and its colours worked out, before anything about it is
 * written. A tint somebody chose stands in for Vision's look at the colours.
 */
async function preparePicture(
  bytes: Buffer | null,
  chosenTint: string | undefined,
  palette: readonly string[],
): Promise<PreparedPicture> {
  const measured = measurePicture(bytes);
  if (!measured.ok) return measured;
  return {
    ...measured,
    colours: chosenTint === undefined ? await pictureColours(measured.bytes, palette) : coloursFromChosenTint(chosenTint, false),
  };
}

function measurePicture(bytes: Buffer | null): MeasuredPicture {
  const judged = judgePicture(bytes);
  if (!judged.ok || bytes === null) return { ok: false, why: judged.ok ? "missing" : judged.why };
  return { ok: true, bytes, contentType: CONTENT_TYPES[judged.size.format], width: judged.size.width, height: judged.size.height };
}

function editFields(edits: SectionEdits): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (edits.name !== undefined) fields.name = edits.name;
  if (edits.names !== undefined) fields.names = edits.names;
  if (edits.icon !== undefined) fields.icon = edits.icon;
  if (edits.rank !== undefined) fields.rank = edits.rank;
  if (edits.hidden !== undefined) fields.hidden = edits.hidden;
  return fields;
}

async function staffView(response: Response, identity: Identity, id: string, status: number): Promise<void> {
  const fresh = await readSectionById(id);
  if (fresh === null) return noSuchSection(response);
  response.status(status).json(sectionView(fresh, { uid: identity.uid, moderator: true }, noStats(id), false));
}

/** The owner making an approved section outright, with a picture from their own folder if they like. */
async function createSection(response: Response, identity: Identity, body: unknown): Promise<void> {
  const role = await roleFor(response, identity, "create");
  if (role === null) return;
  const read = readSectionEdits(body, ["name", "names", "icon", "rank", "pictureId", "tint"]);
  if (!read.ok) return refuseSection(response, read);
  const { edits } = read;
  const name = edits.name;
  if (name === undefined) return refuseSection(response, { code: "BAD_NAME" });

  const sections = await readAllSections();
  const names = namesAfter({ name, names: {} }, edits);
  const clash = findClash(names, sections, null);
  if (clash !== null) return refuseSection(response, { code: "NAME_TAKEN", id: clash });
  const pictureId = edits.pictureId ?? undefined;
  const picture = pictureId === undefined ? null : await preparePicture(await readOwnPicture(identity.uid, pictureId), edits.tint, []);
  if (picture !== null && !picture.ok) return refuseSection(response, { code: "BAD_PICTURE", why: picture.why });

  const now = Date.now();
  const bucket = bucketName();
  const colours = picture?.ok ? picture.colours : edits.tint !== undefined ? coloursFromChosenTint(edits.tint, false) : NEUTRAL_COLOURS;
  const db = getFirestore();
  const created = await db.runTransaction(async (transaction): Promise<Created> => {
    const taken = await reservedBy(transaction, names, null);
    if (taken !== null) return { code: "NAME_TAKEN", id: taken };
    const id = await freeSectionId(transaction, name, sections.map((one) => one.id));
    const record: SectionRecord = {
      ...newSection(id, name, now),
      ...colours,
      names: edits.names ?? {},
      icon: edits.icon ?? DEFAULT_ICON,
      rank: edits.rank ?? null,
      picture: picture?.ok && pictureId !== undefined
        ? { url: addressOf(bucket, sectionPicturePath(id, pictureId)), width: picture.width, height: picture.height }
        : null,
      status: "approved",
      approvedAtMs: now,
      decidedAtMs: now,
      decidedBy: identity.uid,
    };
    transaction.create(db.collection(SECTIONS).doc(id), newSectionDocument(record));
    reserveNames(transaction, names, id);
    const created = { name: record.name, names: record.names, icon: record.icon, rank: record.rank, status: record.status };
    auditInTransaction(transaction, auditEntry(identity.uid, role, "section.create", `${SECTIONS}/${id}`, null, created));
    return { code: null, record };
  });
  if (created.code !== null) return refuseSection(response, created);

  const { record } = created;
  if (picture?.ok && pictureId !== undefined) {
    try {
      await publishSectionPicture(sectionPicturePath(record.id, pictureId), picture.bytes, picture.contentType);
    } catch (error) {
      await db.collection(SECTIONS).doc(record.id).delete();
      throw error;
    }
  }
  await bumpSectionsVersion();
  forgetSections();
  response.status(201).json(sectionView(record, { uid: identity.uid, moderator: true }, noStats(record.id), false));
}

type Settled =
  | { kind: "decided"; outcome: Extract<SectionOutcome, { ok: true }> }
  | { kind: "refused"; reason: SectionActionRefusal; status: SectionStatus | null }
  | { kind: "taken"; id: string; status: SectionStatus | null };

/**
 * A word on a section: approved or declined by the owner or a moderator,
 * merged by the owner. The slow part of an approval, Vision and the copy,
 * comes first and writes nothing anybody reads; then one transaction reads
 * the section again and writes the decision, so of two words at once one
 * stands and the other is told it came too late. The lists move after, and
 * the section says it is unfinished until they have: the same word again
 * finishes the job.
 */
async function settleSection(
  response: Response,
  identity: Identity,
  id: string,
  action: SectionAction,
  body: unknown,
): Promise<void> {
  const role = await roleFor(response, identity, action);
  if (role === null) return;
  const found = isSectionId(id) ? await readSectionById(id) : null;
  if (found === null) return noSuchSection(response);
  const source = (body ?? {}) as Record<string, unknown>;
  const intoId = action === "merge" && isSectionId(source.into) ? source.into : null;
  const into = intoId === null ? null : await readSectionById(intoId);
  const early = decideSectionAction(action, found, into);
  if (!early.ok) return refuseSectionAction(response, early.reason);

  const update: Record<string, unknown> = {
    status: early.status,
    decidedAt: FieldValue.serverTimestamp(),
    decidedBy: identity.uid,
    unfinished: true,
  };
  let names: string[] = [];
  let copied = false;
  if (action === "approve" && !early.resume) {
    // A pin is part of the order, and the order is the owner's.
    if (source.rank !== undefined && !mayCall(role, "order")) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS", detail: "owner_only" });
      return;
    }
    const read = readSectionEdits(body, ["name", "names", "icon", "rank", "tint"]);
    if (!read.ok) return refuseSection(response, read);
    if (read.edits.name !== undefined || read.edits.names !== undefined) {
      names = namesAfter(found, read.edits);
      const clash = findClash(names, await readAllSections(), id);
      if (clash !== null) return refuseSection(response, { code: "NAME_TAKEN", id: clash });
    }
    const path = found.proposalPicture;
    const chosen = read.edits.tint ?? (found.tintChosen ? found.tint.light : undefined);
    const picture = await preparePicture(path === null ? null : await readStoredPicture(path), chosen, found.palette);
    if (!picture.ok || path === null) return refuseSection(response, { code: "BAD_PICTURE", why: picture.ok ? "missing" : picture.why });
    const published = sectionPicturePath(id, pictureIdOf(path));
    await publishSectionPicture(published, picture.bytes, picture.contentType);
    copied = true;
    Object.assign(update, editFields(read.edits), picture.colours, {
      picture: { url: addressOf(bucketName(), published), width: picture.width, height: picture.height },
      approvedAt: FieldValue.serverTimestamp(),
      fileUnder: null,
      proposalPicture: null,
      proposalPictureUrl: null,
    });
  }
  if (action === "decline") {
    update.declineNote = cleanText(source.note, MAX_DECLINE_NOTE_LENGTH);
  }
  if (early.mergedInto !== null) {
    update.mergedInto = early.mergedInto;
  }

  const db = getFirestore();
  const ref = db.collection(SECTIONS).doc(id);
  const settled = await db.runTransaction(async (transaction): Promise<Settled> => {
    const [fresh, target] = await Promise.all([
      transaction.get(ref),
      intoId === null ? null : transaction.get(db.collection(SECTIONS).doc(intoId)),
    ]);
    if (!fresh.exists) return { kind: "refused", reason: "settled", status: null };
    const section = sectionRecord(id, fresh.data() as StoredSection);
    const targetRecord = target?.exists ? sectionRecord(target.id, target.data() as StoredSection) : null;
    const outcome = decideSectionAction(action, section, targetRecord);
    if (!outcome.ok) return { kind: "refused", reason: outcome.reason, status: section.status };
    if (outcome.resume !== early.resume) return { kind: "refused", reason: "settled", status: section.status };
    if (outcome.resume) return { kind: "decided", outcome };
    const clash = names.length > 0 ? await reservedBy(transaction, names, id) : null;
    if (clash !== null) return { kind: "taken", id: clash, status: section.status };
    transaction.update(ref, update);
    if (names.length > 0) reserveNames(transaction, names, id);
    const change = changedFields(section as unknown as Record<string, unknown>, update);
    auditInTransaction(transaction, auditEntry(identity.uid, role, `section.${action}` as AuditAction, `${SECTIONS}/${id}`, change.before, change.after));
    return { kind: "decided", outcome };
  });
  if (settled.kind !== "decided") {
    // The copy made for an approval that did not happen is nobody's; one another approval won keeps it.
    if (copied && settled.status !== "approved") await discardSectionPictures(id);
    if (settled.kind === "taken") return refuseSection(response, { code: "NAME_TAKEN", id: settled.id });
    return refuseSectionAction(response, settled.reason);
  }

  const { outcome } = settled;
  await rewriteWhere(PUBLISHED, "proposedSection", id, outcome.waiting);
  if (outcome.filed !== null) await rewriteWhere(PUBLISHED, "category", id, outcome.filed);
  if (outcome.mergedInto !== null) await pointAt(id, outcome.mergedInto);
  // A declined proposer still sees their picture until they put the notice away.
  if (action !== "decline") await discardProposalPicture(id);
  await ref.update({ unfinished: false });
  if (action !== "decline") await bumpSectionsVersion();
  forgetSections();
  await staffView(response, identity, id, 200);
}

/**
 * The owner's edit of a section. An approved one may change anything: a new
 * picture brings new colours unless the same call names a tint, which wins,
 * and `pictureId: null` takes the picture away and leaves the colours. A
 * built-in keeps its own colours whatever picture it is given, and its tint
 * is taken as given. A proposal still waiting may have its name,
 * translations, icon, picture and tint changed and stays waiting: its
 * picture is replaced in the private folder, never removed, and its palette
 * looked at again, a tint chosen for it is kept for approval, and its place
 * and visibility wait for approval (400 INVALID).
 */
async function editSection(response: Response, identity: Identity, id: string, body: unknown): Promise<void> {
  const role = await roleFor(response, identity, "edit");
  if (role === null) return;
  const found = isSectionId(id) ? await readSectionById(id) : null;
  if (found === null) return noSuchSection(response);
  if (found.status !== "approved" && found.status !== "pending") {
    response.status(409).json({ error: "Only an approved or waiting section is edited", code: "SETTLED" });
    return;
  }
  const waiting = found.status === "pending";
  const notYet = notYetEditable(found.status, body);
  if (notYet !== null) {
    response.status(400).json({ error: "A waiting section gets its place when it is approved", code: "INVALID", detail: notYet });
    return;
  }
  const read = readSectionEdits(body, waiting ? PENDING_EDIT_FIELDS : APPROVED_EDIT_FIELDS);
  if (!read.ok) return refuseSection(response, read);
  const { edits } = read;
  const pictureRefusal = pictureEditRefusal(found, role, edits.pictureId);
  if (pictureRefusal === "built_in") {
    response.status(409).json({ error: "Only the owner gives a built-in section a picture", code: "BUILT_IN", detail: "pictureId" });
    return;
  }
  if (pictureRefusal === "waiting") {
    response.status(400).json({ error: "A waiting section keeps its picture", code: "INVALID", detail: "pictureId" });
    return;
  }
  if (edits.hidden === true && found.id === OTHER) {
    response.status(409).json({ error: "Other stays open: lists fall back to it", code: "BUILT_IN", detail: "hidden" });
    return;
  }
  const names = edits.name !== undefined || edits.names !== undefined ? namesAfter(found, edits) : [];
  if (names.length > 0) {
    const clash = findClash(names, await readAllSections(), id);
    if (clash !== null) return refuseSection(response, { code: "NAME_TAKEN", id: clash });
  }

  const update = editFields(edits);
  const pictureId = edits.pictureId;
  // A file this edit writes, removed again if the edit does not land; and the one it makes old, removed if it does.
  let copied: string | null = null;
  let replaced: string | null = null;
  if (typeof pictureId === "string" && waiting) {
    const bytes = await readOwnPicture(identity.uid, pictureId);
    const judged = judgePicture(bytes);
    if (!judged.ok || bytes === null) return refuseSection(response, { code: "BAD_PICTURE", why: judged.ok ? "missing" : judged.why });
    const path = proposalPath(id, pictureId);
    const same = path === found.proposalPicture;
    // The same file written again keeps its address, so a refused edit leaves the stored one working.
    const token = (same ? tokenOf(found.proposalPictureUrl) : null) ?? randomUUID();
    await keepForProposal(path, bytes, CONTENT_TYPES[judged.size.format], token);
    copied = same ? null : path;
    replaced = same ? null : found.proposalPicture;
    Object.assign(update, {
      proposalPicture: path,
      proposalPictureUrl: tokenAddressOf(bucketName(), path, token),
      palette: await paletteFor(bytes),
    });
  } else if (typeof pictureId === "string") {
    const bytes = await readOwnPicture(identity.uid, pictureId);
    const picture = found.builtIn ? measurePicture(bytes) : await preparePicture(bytes, edits.tint, found.palette);
    if (!picture.ok) return refuseSection(response, { code: "BAD_PICTURE", why: picture.why });
    const path = sectionPicturePath(id, pictureId);
    const url = addressOf(bucketName(), path);
    await publishSectionPicture(path, picture.bytes, picture.contentType);
    // The same file again is the picture it already has, never one to clean up.
    copied = found.picture?.url === url ? null : path;
    Object.assign(update, "colours" in picture ? picture.colours : {}, { picture: { url, width: picture.width, height: picture.height } });
  } else if (pictureId === null) {
    update.picture = null;
  }
  // A new picture on any section but a built-in already brought its colours, the chosen tint among them.
  if (edits.tint !== undefined && (waiting || typeof pictureId !== "string" || found.builtIn)) {
    Object.assign(update, coloursFromChosenTint(edits.tint, found.builtIn));
    if (waiting) update.tintChosen = true;
  }

  const db = getFirestore();
  const ref = db.collection(SECTIONS).doc(id);
  type Saved = { replaced: string | null } | "settled" | { taken: string };
  const saved = await keepingOnlyIfWritten(copied, () => db.runTransaction(async (transaction): Promise<Saved> => {
    const fresh = await transaction.get(ref);
    if (!fresh.exists || fresh.get("status") !== found.status) return "settled";
    const current = sectionRecord(id, fresh.data() as StoredSection);
    const clash = names.length > 0 ? await reservedBy(transaction, names, id) : null;
    if (clash !== null) return { taken: clash };
    const stale = names.length > 0 ? await ownReservations(transaction, releasedNames(namesAfter(current, {}), names), id) : [];
    if (Object.keys(update).length > 0) transaction.update(ref, update);
    if (names.length > 0) reserveNames(transaction, names, id);
    stale.forEach((one) => transaction.delete(one));
    const change = changedFields(current as unknown as Record<string, unknown>, update);
    if (change.after !== null) {
      auditInTransaction(transaction, auditEntry(identity.uid, role, "section.edit", `${SECTIONS}/${id}`, change.before, change.after));
    }
    if (waiting || !("picture" in update)) return { replaced: null };
    // The picture this edit replaces, as the section says now rather than when it was first read.
    const before = (fresh.get("picture") as SectionPicture | null | undefined)?.url;
    const after = (update.picture as SectionPicture | null)?.url;
    return { replaced: replacedSectionPicture(id, before, after) };
  }));
  if (typeof saved === "string" || "taken" in saved) {
    if (copied !== null) await discardStoredPicture(copied);
    if (saved === "settled") {
      response.status(409).json({ error: "That section was decided meanwhile", code: "SETTLED" });
      return;
    }
    return refuseSection(response, { code: "NAME_TAKEN", id: saved.taken });
  }
  if (waiting) {
    if (replaced !== null) await discardStoredPicture(replaced);
    claimedSectionsCache.invalidate();
  } else {
    if (saved.replaced !== null) await discardStoredPicture(saved.replaced);
    await bumpSectionsVersion();
    forgetSections();
  }
  await staffView(response, identity, id, 200);
}

/** The download token a stored address carries, if it carries one. */
function tokenOf(address: string | null): string | null {
  if (address === null) return null;
  try {
    return new URL(address).searchParams.get("token");
  } catch {
    return null;
  }
}

/** Inside a transaction: the reservations of these name keys that this section itself holds. Reads only. */
async function ownReservations(
  transaction: FirebaseFirestore.Transaction,
  keys: readonly string[],
  sectionId: string,
): Promise<FirebaseFirestore.DocumentReference[]> {
  if (keys.length === 0) return [];
  const docs = await transaction.getAll(...keys.map(reservationRef));
  return docs.filter((doc) => doc.exists && doc.get("sectionId") === sectionId).map((doc) => doc.ref);
}

/**
 * The owner's order screen saved: ranks and what is hidden, in one
 * transaction with the version it was drawn from, which moves on with it.
 */
async function putSectionOrder(response: Response, identity: Identity, body: unknown): Promise<void> {
  const role = await roleFor(response, identity, "order");
  if (role === null) return;
  const source = (body ?? {}) as { ids?: unknown; hidden?: unknown; version?: unknown };
  if (!Number.isSafeInteger(source.version)) {
    response.status(400).json({ error: "Which version was this order drawn from?", code: "BAD_ORDER", detail: "version" });
    return;
  }
  // Seeded before the transaction, so the built-ins are there to be ordered.
  await readAllSections();
  const db = getFirestore();
  const config = sectionsConfig();
  const outcome = await db.runTransaction(async (transaction) => {
    const [stored, all] = await Promise.all([transaction.get(config), transaction.get(db.collection(SECTIONS))]);
    const version = (stored.get("version") as number | undefined) ?? 0;
    if (source.version !== version) return { kind: "conflict" as const, version };
    const records = all.docs.map((doc) => sectionRecord(doc.id, doc.data() as StoredSection));
    const decision = decideOrder(source, records);
    if (!decision.ok) return { kind: "bad" as const };
    decision.changes.forEach((one) => transaction.update(db.collection(SECTIONS).doc(one.id), one.fields));
    // Only the sections whose place or visibility moved, each with what it was and what it is.
    const was = new Map(records.map((one) => [one.id, one]));
    const before = Object.fromEntries(
      decision.changes.map((one) => [one.id, Object.fromEntries(Object.keys(one.fields).map((key) => [key, was.get(one.id)?.[key as "rank" | "hidden"] ?? null]))]),
    );
    const after = Object.fromEntries(decision.changes.map((one) => [one.id, one.fields]));
    auditInTransaction(transaction, auditEntry(identity.uid, role, "section.order", `${CONFIG}/${SECTIONS_CONFIG}`, before, after));
    transaction.set(config, { version: version + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { kind: "saved" as const };
  });
  if (outcome.kind === "conflict") {
    response.status(409).json({
      error: "The sections changed since this order was drawn",
      code: "CONFLICT",
      detail: "version",
      version: outcome.version,
    });
    return;
  }
  if (outcome.kind === "bad") {
    response.status(400).json({ error: "Every id once, each an approved section, and Other never hidden", code: "BAD_ORDER" });
    return;
  }
  forgetSections();
  await readSections(response, identity);
}

/**
 * The owner removing a section outright, which is only for one nothing is
 * filed under, waits for, or names as an approved or waiting topic's place. A proposal filed
 * under it is filed under Other instead; its followers stop following it.
 */
async function deleteSection(response: Response, identity: Identity, id: string): Promise<void> {
  const role = await roleFor(response, identity, "delete");
  if (role === null) return;
  const found = isSectionId(id) ? await readSectionById(id) : null;
  if (found === null) return noSuchSection(response);
  const [filed, waiting, topicStatuses] = await Promise.all([
    countWhere(PUBLISHED, "category", id),
    waitingCount(id),
    getFirestore().collection(TOPICS).where("section", "==", id).select("status").get(),
  ]);
  const topics = liveTopics(topicStatuses.docs.map((doc) => doc.get("status")));
  const decision = decideDeletion(found, { lists: filed + waiting, topics });
  if (!decision.ok) {
    if (decision.reason === "built_in") {
      response.status(409).json({ error: "A built-in section stays", code: "BUILT_IN" });
    } else {
      response.status(409).json({
        error: "Lists or topics are still in that section",
        code: "NOT_EMPTY",
        detail: topics > 0 && filed + waiting === 0 ? "topics" : "lists",
        lists: filed + waiting,
        topics,
      });
    }
    return;
  }
  await rewriteWhere(SECTIONS, "fileUnder", id, { fileUnder: OTHER });
  await deleteWhere(SECTION_FOLLOWS, "section", id);
  const batch = getFirestore().batch();
  batch.delete(getFirestore().collection(SECTIONS).doc(id));
  auditInBatch(batch, auditEntry(identity.uid, role, "section.delete", `${SECTIONS}/${id}`, { name: found.name, status: found.status }, null));
  await batch.commit();
  await discardSectionPictures(id);
  await discardProposalPicture(id);
  await bumpSectionsVersion();
  forgetSections();
  response.status(204).send();
}

/** Everything else that named a merged section names where it went: topics, follows, older merges and proposals filed under it. */
async function pointAt(from: string, into: string): Promise<void> {
  await rewriteWhere(TOPICS, "section", from, { section: into });
  await rewriteWhere(SECTIONS, "mergedInto", from, { mergedInto: into });
  await rewriteWhere(SECTIONS, "fileUnder", from, { fileUnder: into });
  const follows = getFirestore().collection(SECTION_FOLLOWS);
  // Two writes a follow: the new one set, so somebody already following both ends up with one.
  await inPages(SECTION_FOLLOWS, "section", from, ["follower", "createdAt"], WRITES_PER_BATCH / 2, (batch, doc) => {
    const follower = doc.get("follower") as string;
    batch.set(follows.doc(sectionFollowId(follower, into)), {
      follower,
      section: into,
      createdAt: doc.get("createdAt") ?? FieldValue.serverTimestamp(),
    });
    batch.delete(doc.ref);
  });
}

/**
 * Every document of a collection with `field == value`, a page at a time,
 * reading only `fields` of each, each page one batch. A merge of a big
 * section never holds its lists in memory, and one cut short is finished by
 * asking again: whatever was moved no longer matches.
 */
async function inPages(
  collection: string,
  field: string,
  value: string,
  fields: readonly string[],
  pageSize: number,
  write: (batch: FirebaseFirestore.WriteBatch, doc: FirebaseFirestore.QueryDocumentSnapshot) => boolean | void,
): Promise<void> {
  const db = getFirestore();
  let after: string | null = null;
  for (;;) {
    let page = db
      .collection(collection)
      .where(field, "==", value)
      .orderBy(FieldPath.documentId())
      .select(...fields)
      .limit(pageSize);
    if (after !== null) page = page.startAfter(after);
    const read = await page.get();
    if (read.empty) return;
    const batch = db.batch();
    // A row the writer passes over, by answering false, costs no write.
    const writes = read.docs.filter((doc) => write(batch, doc) !== false).length;
    if (writes > 0) await batch.commit();
    if (read.size < pageSize) return;
    after = read.docs[read.size - 1].id;
  }
}

async function rewriteWhere(
  collection: string,
  field: string,
  value: string,
  change: Record<string, unknown>,
): Promise<void> {
  await inPages(collection, field, value, [], WRITES_PER_BATCH, (batch, doc) => {
    batch.update(doc.ref, change);
  });
}

async function deleteWhere(collection: string, field: string, value: string): Promise<void> {
  await inPages(collection, field, value, [], WRITES_PER_BATCH, (batch, doc) => {
    batch.delete(doc.ref);
  });
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
    if (data.underReview === true || isAnonymous(data) || skip.has(data.authorUid) || authors.has(data.authorUid)) {
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

  const proposals = await proposalsWaitedFor(snapshot.docs);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: snapshot.docs.map((doc) => {
      const data = doc.data() as StoredList;
      return {
        ...toSummary(doc.id, data, identity, identity.isAnonymous ? null : new Set()),
        ...ownAuthor(data),
        ...waitingFor(data.proposedSection, proposals),
      };
    }),
  });
}

/**
 * The proposals these lists wait for, read in one batch: a list waiting for
 * a proposed section says which, so a reader can say where it will move.
 */
async function proposalsWaitedFor(docs: readonly FirebaseFirestore.DocumentSnapshot[]): Promise<Map<string, SectionRecord>> {
  return await readSectionsById(
    docs.map((doc) => (doc.data() as StoredList).proposedSection).filter((id): id is string => typeof id === "string"),
  );
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
        coverImageUrl: collageImage({ coverImageUrl: data.coverImageUrl ?? null, previewImages: data.previewImages ?? [] }),
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
  const role = await roleOf(identity);
  if (role === null) {
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
  const listed = listDoc.exists ? (listDoc.data() as StoredList) : null;
  const standing = { underReview: listed?.underReview === true, reviewed: listed?.reviewed === true };
  if (takeDown) {
    auditInBatch(batch, auditEntry(identity.uid, role, "report.takedown", `${PUBLISHED}/${listId}`,
      { ...standing, reports: filed.size }, { removed: true }));
    batch.delete(db.collection(PUBLISHED).doc(listId));
    if (topicId !== null) {
      batch.update(db.collection(TOPICS).doc(topicId), { listCount: FieldValue.increment(-1) });
    }
    // Only with a takedown. Putting a list back and banning its author in one
    // gesture would be two opposite judgements at once.
    if (banLength !== null && authorUid !== null) {
      const ban = banFrom(banLength, Date.now(), reasonForBan);
      batch.set(db.collection(BANS).doc(authorUid), ban);
      auditInBatch(batch, auditEntry(identity.uid, role, "ban.set", `${BANS}/${authorUid}`, null, { ...ban, length: banLength }));
    }
  } else {
    const change = changedFields(standing, { underReview: false, reviewed: true });
    auditInBatch(batch, auditEntry(identity.uid, role, "report.dismiss", `${PUBLISHED}/${listId}`,
      { ...change.before, reports: filed.size }, change.after));
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
  // One document says whether the reader follows this author; a set of one is all the summary needs.
  const follows = identity.isAnonymous
    ? null
    : (await getFirestore().collection(FOLLOWS).doc(followId(identity.uid, data.authorUid)).get()).exists;
  const followed = follows === null ? null : new Set(follows ? [data.authorUid] : []);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    ...toSummary(doc.id, data, identity, followed),
    tiers: data.tiers,
    items: data.items,
  });
}

async function publish(
  response: Response,
  identity: Identity,
  body: unknown,
  existingId: string | null,
  byline: Byline = bylineOf(identity),
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

  // Replacing a list the author already published does not add to their count,
  // and the house has no count.
  const alreadyPublished = existingId || byline.speaker !== null
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
    if (previous.authorUid !== byline.uid) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
      return;
    }
  }

  // Where the board came from, settled before the pictures: the same cards
  // make this a ranking of that list, which copies nothing and names no topic.
  // A list of the author's own being replaced is a republish whatever it says,
  // and the house only ever publishes lists of its own.
  const source = body as Record<string, unknown>;
  const publication = existingId || byline.speaker !== null
    ? ({ kind: "list", basedOn: null } as Publication)
    : await resolvePublication(identity, readTakenFrom(source.takenFrom), decision.draft.items);
  if (publication.kind === "ranking") {
    return await rank(response, identity, publication.listId, decision.draft);
  }

  // Which section, and which topic, settled before the pictures as well: a
  // refusal of either should cost nothing.
  const section = await resolveSectionChoice(identity, decision.draft.category, previous?.category ?? null);
  if (!section.ok) {
    response.status(400).json({ error: "That section does not take new lists", code: "INVALID", detail: "category" });
    return;
  }
  const asked = readTopicRequest(source.topicId, source.newTopic);
  if (!asked.ok) {
    refuseTopicRequest(response, asked.reason);
    return;
  }
  const attachment = await resolveAttachment(identity, asked.request, section.category);
  if (attachment.kind === "refuse") {
    refuseAttachment(response, attachment.reason);
    return;
  }
  const implied = asked.request.kind === "none"
    ? impliedTopic({
        request: asked.request,
        viaTopic: section.viaTopic === undefined ? null : await liveTopic(section.viaTopic),
        chosenCategory: section.category,
        previous,
      })
    : null;

  // Asked before the pictures, because it costs one call and no bytes.
  // Answered after the board is stored, because the answer is a report about
  // a list and there has to be a list to report.
  const words = wordsOf(decision.draft);
  const wording = byline.speaker === null && words.length >= ENOUGH_TO_JUDGE ? await realModeration(words) : null;
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
  const topicId = attachment.kind === "attach" ? attachment.topic.id : topicRef?.id ?? implied?.topicId ?? null;
  const topicName = attachment.kind === "attach"
    ? attachment.topic.name
    : attachment.kind === "create"
      ? attachment.name
      : implied?.topicName ?? null;

  const document = {
    authorUid: byline.uid,
    authorName: byline.name,
    authorPhotoUrl: byline.photoUrl,
    title: list.title,
    titleLower: list.titleLower,
    // A title kept keeps its keys, translations and all; a new one starts from its own words.
    ...(previous?.title === list.title && previous.searchKeys !== undefined ? {} : searchFieldsFor([list.title])),
    // A topic decides the section: an approved one brings its own, a waiting
    // one holds the list under "other" until somebody has looked. So a list
    // with a topic never waits for a proposed section as well.
    category: attachment.kind === "none" ? implied?.category ?? section.category : attachment.category,
    proposedSection: attachment.kind === "none" && implied === null ? section.proposedSection : null,
    topicId,
    topicName,
    tiers: list.tiers,
    items: list.items,
    itemCount: list.items.length,
    coverImageUrl: list.coverImageUrl,
    previewImages: list.previewImages,
    tierColors: list.tierColors,
    tierCounts: tierCountsOf(list.tiers.length, list.items),
    basedOn: publication.basedOn,
    anonymous: byline.speaker !== null || anonymityAfter(decision.draft.anonymous, previous),
    updatedAt: FieldValue.serverTimestamp(),
    // Replacing the contents replaces the snapshot, so it has not been looked
    // at. Merging without these left a shield for anything published behind it.
    underReview: false,
    reviewed: false,
  };

  // One transaction, so a new topic's name is reserved with the topic as a
  // moderator's is, and two claims to one name meet in one document. A name
  // somebody else's topic already holds stays theirs; this one waits beside
  // it, as waiting twins always have, for a moderator to merge.
  await db.runTransaction(async (transaction) => {
    const reserve = topicRef !== null && attachment.kind === "create"
      ? (await topicNameTaken(transaction, attachment.nameLower, null)) === null
      : false;
    // The topics' counts of lists follow the list: off the one it leaves, onto
    // the one it joins, and a new topic starts at one.
    const previousTopic = previous?.topicId ?? null;
    if (previousTopic !== null && previousTopic !== topicId) {
      transaction.update(db.collection(TOPICS).doc(previousTopic), { listCount: FieldValue.increment(-1) });
    }
    if (topicRef !== null && attachment.kind === "create") {
      transaction.set(topicRef, {
        name: attachment.name,
        nameLower: attachment.nameLower,
        names: {},
        ...searchFieldsFor([attachment.name]),
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
      if (reserve) reserveTopicName(transaction, attachment.nameLower, topicRef.id);
    } else if (topicId !== null && topicId !== previousTopic) {
      transaction.update(db.collection(TOPICS).doc(topicId), { listCount: FieldValue.increment(1) });
    }
    if (byline.speaker !== null) {
      // Who spoke for the house lives here and nowhere a reader can reach.
      const what = existingId ? "list.editorial_edit" : "list.editorial_publish";
      auditInTransaction(transaction, auditEntry(identity.uid, byline.speaker, what, `${PUBLISHED}/${target}`, null, { title: list.title, category: document.category }));
    }
    if (existingId) {
      transaction.set(collection.doc(existingId), document, { merge: true });
    } else {
      // Only on a new list: republishing merges, and a count written here would
      // reset it. Taking is about the list, not the snapshot.
      transaction.set(collection.doc(target), {
        ...document,
        publishedAt: FieldValue.serverTimestamp(),
        takeCount: 0,
        rankingCount: 0,
      });
    }
  });
  await noteWordingConcern(target, document.title, identity, concern);

  if (existingId) {
    await syncCredits(existingId, document.anonymous, byline.uid, document.authorName);
    // The board was edited for a month; the copies it no longer names are
    // nobody's, because the snapshot that pointed at them has been replaced.
    await discardUnusedPublished(existingId, [...addresses.keys()]);
    response.status(200).json({ id: existingId, topicId });
    return;
  }
  response.status(201).json({ id: target, topicId });
}

/**
 * Every copy credits this list as it now is: by nobody while it is
 * anonymous, by its author while it is not. Asked of every copy on every
 * republish, so a rewrite cut short by a timeout is finished by the next one.
 */
async function syncCredits(listId: string, anonymous: boolean, authorUid: string, authorName: string): Promise<void> {
  const credit = anonymous
    ? { "basedOn.authorUid": "", "basedOn.authorName": "" }
    : { "basedOn.authorUid": authorUid, "basedOn.authorName": authorName };
  await inPages(PUBLISHED, "basedOn.id", listId, ["basedOn"], WRITES_PER_BATCH, (batch, doc) => {
    const stored = shownCredit(doc.get("basedOn"));
    if (stored === null || !creditNeedsRewrite(stored, anonymous)) return false;
    batch.update(doc.ref, credit);
    return true;
  });
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
        anonymous: isAnonymous(data),
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
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  if (method === "GET" && rest === "") {
    return await readRankings(response, identity, listId, singleParam(query.after));
  }
  if (method === "PUT" && rest === "mine") {
    return await putMyRanking(response, identity, listId, body);
  }
  if (method === "DELETE" && rest === "mine") {
    return await deleteMyRanking(response, identity, listId);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

type RankingOutcome = { refused: "not_signed_in" | "banned" | "missing" | "own_list" } | { invalid: string } | { created: boolean };

/**
 * A reader putting their own placing of somebody's list in its rankings
 * sheet, or replacing it. Everything is judged again inside the transaction
 * that writes it, against the list as it is then, and the list's count goes
 * up once, for a ranking that was not there before.
 */
async function putMyRanking(response: Response, identity: Identity, listId: string, body: unknown): Promise<void> {
  const ban = identity.isAnonymous ? null : await readBan(identity.uid);
  const caller = { uid: identity.uid, isAnonymous: identity.isAnonymous, banned: isBanned(ban, Date.now()) };
  const db = getFirestore();
  const list = readTakenFrom(listId) === null ? null : db.collection(PUBLISHED).doc(listId);
  const ranking = db.collection(RANKINGS).doc(`${listId}_${identity.uid}`);
  const outcome = await db.runTransaction(async (transaction): Promise<RankingOutcome> => {
    const [source, existing] = list === null ? [null, null] : await Promise.all([transaction.get(list), transaction.get(ranking)]);
    const data = source?.exists ? (source.data() as StoredList) : null;
    const refused = rankingRefusal(caller, data === null ? null : { authorUid: data.authorUid, underReview: data.underReview === true });
    if (refused !== null || data === null || list === null) return { refused: refused ?? "missing" };
    const read = readRankingBody(body, (data.items ?? []).length);
    if (!read.ok) return { invalid: read.detail };
    const write = rankingWrite(existing?.exists === true);
    transaction.set(ranking, {
      listId,
      uid: identity.uid,
      authorName: identity.name ?? "Anonymous",
      authorPhotoUrl: identity.picture,
      arrangement: read.arrangement,
      ...(read.rows === null ? {} : { rows: rowsToDocument(read.rows) }),
      tierLabels: read.tierLabels,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (write.countChange > 0) transaction.update(list, { rankingCount: FieldValue.increment(write.countChange) });
    return { created: write.created };
  });

  if ("refused" in outcome) {
    switch (outcome.refused) {
      case "not_signed_in":
        response.status(403).json({ error: "Sign in to rank", code: "NOT_SIGNED_IN" });
        return;
      case "banned":
        response.status(403).json({ error: "You cannot rank at the moment", ...noticeFor(ban as Ban) });
        return;
      case "missing":
        response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
        return;
      case "own_list":
        response.status(409).json({ error: "That list is yours", code: "OWN_LIST" });
        return;
    }
  }
  if ("invalid" in outcome) {
    response.status(400).json({ error: "That placing does not fit the list", code: "INVALID", detail: outcome.invalid });
    return;
  }
  const fresh = await ranking.get();
  response.status(200).json({ ...toRanking(fresh.data() as StoredRanking), created: outcome.created });
}

function toRanking(data: StoredRanking) {
  return {
    uid: data.uid,
    authorName: data.authorName,
    authorPhotoUrl: data.authorPhotoUrl ?? null,
    arrangement: data.arrangement ?? [],
    rows: rowsFromDocument(data.rows),
    tierLabels: data.tierLabels ?? [],
    updatedAtMs: data.updatedAt?.toMillis() ?? 0,
  };
}

/** Newest first, a page at a time, the reader's own ahead of the page it would otherwise sit in. */
async function readRankings(response: Response, identity: Identity, listId: string, after: string | null): Promise<void> {
  const db = getFirestore();
  const collection = db.collection(RANKINGS);
  let ordered: FirebaseFirestore.Query = collection.where("listId", "==", listId).orderBy("updatedAt", "desc");
  const cursor = after ? readRankingCursor(after) : null;
  if (cursor?.kind === "time") {
    ordered = ordered.startAfter(new Timestamp(cursor.time.seconds, cursor.time.nanoseconds));
  } else if (cursor?.kind === "id") {
    const previous = await collection.doc(cursor.id).get();
    if (!previous.exists) {
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }
  // Left out before the page is counted, so neither takes a place in it: the
  // website's visitors' rankings, which have no account behind them, and the
  // reader's own, which leads the first page and would repeat on a later one.
  const shown = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    const data = doc.data() as StoredRanking;
    return isOwnedRanking(data) && data.uid !== identity.uid;
  };
  const [page, mine] = await Promise.all([
    // Carries on past a long run of visitors' rankings rather than ending
    // there: a visitor's ranking's id says nothing about anybody.
    fillVisible(
      async (last) => (await (last ? ordered.startAfter(last) : ordered).limit(RANKINGS_PAGE_SIZE).get()).docs,
      shown,
      RANKINGS_PAGE_SIZE,
      { resumeFromHidden: true },
    ),
    after === null ? collection.doc(`${listId}_${identity.uid}`).get() : null,
  ]);
  const rankings = page.rows.map((doc) => toRanking(doc.data() as StoredRanking));
  const withMine = mine?.exists ? [toRanking(mine.data() as StoredRanking), ...rankings] : rankings;
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    rankings: mineFirst(withMine, identity.uid),
    nextCursor: rankingCursor(
      page.next === null
        ? null
        : { id: page.next.id, shown: shown(page.next), updatedAt: (page.next.get("updatedAt") as Timestamp | undefined) ?? null },
    ),
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

/**
 * A list that is gone takes the app's rankings of it with it; nobody can open
 * them without it. The website's rankings, kept by code and without an
 * account, are the website's: its pages outlive the list.
 */
async function discardRankings(listId: string): Promise<void> {
  const db = getFirestore();
  const carrying = (await db.collection(RANKINGS).where("listId", "==", listId).get()).docs.filter((doc) =>
    isOwnedRanking(doc.data()),
  );
  for (const part of chunked(carrying, WRITES_PER_BATCH)) {
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

/** What the deciding needs to know about the section a publication asked for, and the one it points at. */
async function resolveSectionChoice(identity: Identity, asked: string, keeping: string | null): Promise<SectionChoice> {
  const first = await readSectionsById([asked]);
  const section = first.get(asked);
  const filed = section?.status === "pending" || section?.status === "declined";
  const next = filed ? section.fileUnder : section?.status === "merged" ? section.mergedInto : null;
  const known = next ? new Map([...first, ...(await readSectionsById([next]))]) : first;
  return decideSectionChoice(asked, known, identity.uid, keeping);
}

/**
 * The approved topic an id ends up at, following merges, or null when it is
 * rejected, gone or merged further than anybody should have to follow.
 */
async function liveTopic(topicId: string): Promise<KnownTopic | null> {
  const topics = getFirestore().collection(TOPICS);
  let id = topicId;
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_TOPIC_HOPS && !seen.has(id); hop++) {
    seen.add(id);
    const snapshot = await topics.doc(id).get();
    const stored = snapshot.exists ? (snapshot.data() as StoredTopic) : null;
    const step = topicHop(stored === null ? null : { status: stored.status, section: stored.section ?? null, mergedInto: stored.mergedInto });
    if ("live" in step) return knownTopic(id, stored as StoredTopic);
    if ("gone" in step) return null;
    id = step.next;
  }
  return null;
}

/** What the deciding needs to know about the topic a publication asked for. */
async function resolveAttachment(identity: Identity, request: TopicRequest, chosen: string): Promise<Attachment> {
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

async function unpublish(response: Response, identity: Identity, id: string, byline: Byline = bylineOf(identity)): Promise<void> {
  const doc = getFirestore().collection(PUBLISHED).doc(id);
  const existing = await doc.get();
  if (!existing.exists) {
    response.status(204).send();
    return;
  }
  const stored = existing.data() as StoredList;
  if (stored.authorUid !== byline.uid) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const batch = getFirestore().batch();
  batch.delete(doc);
  if (byline.speaker !== null) {
    auditInBatch(batch, auditEntry(identity.uid, byline.speaker, "list.editorial_unpublish", `${PUBLISHED}/${id}`, { title: stored.title }, null));
  }
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
  if (method === "POST" && first === "") {
    return await createTopic(response, identity, body);
  }
  if (method === "POST" && first !== "") {
    if (second === "follow") return await followTopic(response, identity, first);
    // Renaming is an edit like any other, and goes through the same checks.
    if (second === "rename") return await editTopic(response, identity, first, { name: (body as { name?: unknown } | null)?.name });
    const action = TOPIC_ACTIONS.find((known) => known === second);
    if (action) return await settleTopic(response, identity, first, action, body);
  }
  if (method === "PATCH" && first !== "" && second === "") {
    return await editTopic(response, identity, first, body);
  }
  if (method === "DELETE" && first !== "") {
    if (second === "follow") return await unfollowTopic(response, identity, first);
    if (second === "") return await deleteTopic(response, identity, first);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

interface TopicFilters {
  prefix: string | null;
  section: string | null;
  limit: number;
}

/**
 * Approved topics: the ones with every typed word in their names, in any of
 * the app's languages, the most followed first; or the biggest, within a
 * section if asked.
 */
async function readTopics(response: Response, identity: Identity, filters: TopicFilters): Promise<void> {
  const topics = getFirestore().collection(TOPICS);
  const search = searchQueryOf(filters.prefix);
  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  let followed: string[];
  if (filters.prefix !== null) {
    // The status is checked here rather than asked: with the word it would need an index of its own.
    const found = search === null
      ? []
      : (await topics.where("searchKeys", "array-contains", search.key).limit(filters.limit * 3).get()).docs;
    docs = found
      .filter((doc) => doc.get("status") === "approved" && search !== null && matchesSearch(doc.get("searchKeys"), search))
      .sort((left, right) => Number(right.get("followerCount") ?? 0) - Number(left.get("followerCount") ?? 0))
      .slice(0, filters.limit);
    followed = await followedTopicIds(identity.uid);
  } else {
    let query: FirebaseFirestore.Query = topics.where("status", "==", "approved");
    if (filters.section) {
      query = query.where("section", "==", filters.section);
    }
    query = query.orderBy("listCount", "desc");
    const [snapshot, mineFollowed] = await Promise.all([query.limit(filters.limit).get(), followedTopicIds(identity.uid)]);
    docs = snapshot.docs;
    followed = mineFollowed;
  }

  const mine = new Set(followed);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    topics: docs.map((doc) => toTopic(doc.id, doc.data() as StoredTopic, mine.has(doc.id), { uid: identity.uid, staff: false })),
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
        topic: toTopic(doc.id, data, mine.has(doc.id), { uid: identity.uid, staff: false }),
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
        return toTopic(found.doc.id, found.doc.data() as StoredTopic, false, { uid: identity.uid, staff: true });
      });
      return {
        ...toTopic(id, data, false, { uid: identity.uid, staff: true }),
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
  response.status(200).json(toTopic(doc.id, doc.data() as StoredTopic, follow.exists, { uid: identity.uid, staff: false }));
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
  const topicRef = db.collection(TOPICS).doc(topicId);
  await db.runTransaction(async (transaction) => {
    const [follow, topic] = await Promise.all([transaction.get(followRef), transaction.get(topicRef)]);
    if (!follow.exists) return;
    transaction.delete(followRef);
    if (topic.exists) {
      transaction.update(topicRef, { followerCount: FieldValue.increment(-1) });
    }
  });
  response.status(200).json({ following: false });
}

/**
 * A word on a topic: approved into a section or rejected by the owner or a
 * moderator, merged into another by the owner alone. The lists carrying it
 * are rewritten a page at a time; the topic changes with its line in the log.
 */
async function settleTopic(
  response: Response,
  identity: Identity,
  topicId: string,
  action: TopicAction,
  body: unknown,
): Promise<void> {
  const role = await roleOf(identity);
  if (role === null || (action === "merge" && role !== "owner")) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS", ...(role === null ? {} : { detail: "owner_only" }) });
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
  const stored = snapshot.data() as StoredTopic;
  const topic = knownTopic(topicId, stored);

  const source = (body ?? {}) as Record<string, unknown>;
  let into: KnownTopic | null = null;
  if (action === "merge" && isTopicId(source.into)) {
    const target = await db.collection(TOPICS).doc(source.into).get();
    into = target.exists ? knownTopic(target.id, target.data() as StoredTopic) : null;
  }

  const openSections = action === "approve" && isSectionId(source.section)
    ? openSectionIds([await readSectionById(source.section)])
    : new Set<string>();
  const outcome = decideTopicAction(action, topic, { section: source.section, name: source.name, into, openSections });
  if (!outcome.ok) {
    refuseTopicAction(response, outcome.reason);
    return;
  }

  const moved = await countWhere(PUBLISHED, "topicId", topicId);
  await rewriteWhere(PUBLISHED, "topicId", topicId, outcome.lists);

  const update: Record<string, unknown> = { ...outcome.topic };
  if (typeof outcome.topic.name === "string") Object.assign(update, searchFieldsFor([outcome.topic.name]));
  if (outcome.decided) {
    update.decidedAt = FieldValue.serverTimestamp();
    update.decidedBy = identity.uid;
  }
  const batch = db.batch();
  if (action === "merge" && into !== null) {
    update.listCount = 0;
    batch.update(db.collection(TOPICS).doc(into.id), { listCount: FieldValue.increment(moved) });
  }
  if (action === "reject") {
    update.listCount = 0;
  }
  batch.update(ref, update);
  const what: AuditAction = action === "rename" ? "topic.edit" : (`topic.${action}` as AuditAction);
  const change = changedFields(stored as unknown as Record<string, unknown>, update);
  auditInBatch(batch, auditEntry(identity.uid, role, what, `${TOPICS}/${topicId}`, change.before, change.after));
  await batch.commit();

  const [fresh, follow] = await Promise.all([
    ref.get(),
    db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId)).get(),
  ]);
  response.status(200).json(toTopic(topicId, fresh.data() as StoredTopic, follow.exists, { uid: identity.uid, staff: true }));
}

/** A topic name's reservation: hashed, because a name may hold characters a document id may not. */
function topicReservationRef(nameLower: string): FirebaseFirestore.DocumentReference {
  return getFirestore().collection(TOPIC_NAMES).doc(createHash("sha256").update(nameLower).digest("hex"));
}

/** Inside a transaction: the topic other than `self` holding this name by its reservation. Reads only. */
async function topicNameHolder(
  transaction: FirebaseFirestore.Transaction,
  nameLower: string,
  self: string | null,
): Promise<KnownTopic | null> {
  const held = await transaction.get(topicReservationRef(nameLower));
  if (!held.exists) return null;
  const reservation = { key: held.get("key") as string, topicId: held.get("topicId") as string };
  if (!isTopicId(reservation.topicId)) return null;
  const holder = await transaction.get(getFirestore().collection(TOPICS).doc(reservation.topicId));
  const known = holder.exists ? knownTopic(holder.id, holder.data() as StoredTopic) : null;
  return topicReservationClash(nameLower, reservation, known, self) === null ? null : known;
}

async function topicNameTaken(
  transaction: FirebaseFirestore.Transaction,
  nameLower: string,
  self: string | null,
): Promise<string | null> {
  return (await topicNameHolder(transaction, nameLower, self))?.id ?? null;
}

function reserveTopicName(transaction: FirebaseFirestore.Transaction, nameLower: string, topicId: string): void {
  transaction.set(topicReservationRef(nameLower), { key: nameLower, topicId, reservedAt: FieldValue.serverTimestamp() });
}

/**
 * The owner or a moderator naming an approved topic outright, in an open
 * section, under a name no other topic approved or waiting already has:
 * checked against the stored topics first, then in the same transaction as
 * the write against the names reserved, so two at once cannot both land.
 */
async function createTopic(response: Response, identity: Identity, body: unknown): Promise<void> {
  const role = await roleOf(identity);
  if (role === null) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const name = cleanTopicName(source.name);
  const db = getFirestore();
  const [sameName, section] = await Promise.all([
    name === null ? [] : db.collection(TOPICS).where("nameLower", "==", name.toLowerCase()).get()
      .then((snapshot) => snapshot.docs.map((doc) => knownTopic(doc.id, doc.data() as StoredTopic))),
    isSectionId(source.section) ? readSectionById(source.section) : null,
  ]);
  const decision = decideTopicCreation({
    name: source.name,
    section: source.section,
    openSections: openSectionIds([section]),
    sameName,
  });
  if (!decision.ok) {
    switch (decision.reason) {
      case "bad_name":
        response.status(400).json({ error: "A topic name is two to forty characters", code: "INVALID", detail: "name" });
        return;
      case "no_section":
        response.status(400).json({ error: "Which section?", code: "INVALID", detail: "section" });
        return;
      case "name_taken":
        topicNameRefused(response, decision.id);
        return;
    }
  }
  const asked = readTopicPictureId(source.pictureId);
  if (!asked.ok) return refuseSection(response, { code: "BAD_PICTURE", why: "missing" });
  // Named before it is written: its picture has to be copied into its own folder first.
  const ref = db.collection(TOPICS).doc();
  const picture = typeof asked.pictureId === "string"
    ? await copyTopicPicture(await readOwnPicture(identity.uid, asked.pictureId), ref.id, asked.pictureId)
    : null;
  if (picture !== null && !picture.ok) return refuseSection(response, { code: "BAD_PICTURE", why: picture.why });
  const created = await keepingOnlyIfWritten(picture?.path ?? null, () => db.runTransaction(async (transaction): Promise<{ taken: string } | { id: string }> => {
    const taken = await topicNameTaken(transaction, decision.nameLower, null);
    if (taken !== null) return { taken };
    transaction.set(ref, {
      picture: picture?.picture ?? null,
      name: decision.name,
      nameLower: decision.nameLower,
      names: {},
      ...searchFieldsFor([decision.name]),
      section: decision.section,
      status: "approved",
      requestedSection: decision.section,
      createdBy: identity.uid,
      proposerName: identity.name ?? "Anonymous",
      createdAt: FieldValue.serverTimestamp(),
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: identity.uid,
      listCount: 0,
      followerCount: 0,
      mergedInto: null,
    });
    reserveTopicName(transaction, decision.nameLower, ref.id);
    auditInTransaction(transaction, auditEntry(identity.uid, role, "topic.create", `${TOPICS}/${ref.id}`, null, {
      name: decision.name,
      section: decision.section,
      status: "approved",
      picture: picture?.picture ?? null,
    }));
    return { id: ref.id };
  }));
  if ("taken" in created) {
    if (picture !== null) await discardStoredPicture(picture.path);
    return topicNameRefused(response, created.taken);
  }
  const fresh = await db.collection(TOPICS).doc(created.id).get();
  response.status(201).json(toTopic(created.id, fresh.data() as StoredTopic, false, { uid: identity.uid, staff: true }));
}

/** `id` is the topic holding the name; `section`, where known, is that topic's section. */
function topicNameRefused(response: Response, id: string, section?: string | null): void {
  response.status(409).json({
    error: "There is a topic by that name already",
    code: "NAME_TAKEN",
    detail: id,
    id,
    ...(section === undefined ? {} : { section }),
  });
}

/**
 * The owner's or a moderator's edit of a topic: its name, its translations,
 * or both. A new name goes through the same checks as a new topic, and the
 * lists carrying the topic take the new name with them.
 */
async function editTopic(response: Response, identity: Identity, topicId: string, body: unknown): Promise<void> {
  const role = await roleOf(identity);
  if (role === null) {
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
  const stored = snapshot.data() as StoredTopic;
  const topic = knownTopic(topicId, stored);
  const edit = decideTopicEdit(topic, body);
  if (!edit.ok) {
    return edit.reason === "bad_picture"
      ? refuseSection(response, { code: "BAD_PICTURE", why: "missing" })
      : refuseTopicAction(response, edit.reason);
  }

  const nameLower = edit.nameLower;
  const renaming = nameLower !== undefined && nameLower !== topic.nameLower;
  if (renaming) {
    const same = await db.collection(TOPICS).where("nameLower", "==", nameLower).get();
    const twin = same.docs
      .map((doc) => knownTopic(doc.id, doc.data() as StoredTopic))
      .find((one) => one.id !== topicId && (one.status === "approved" || one.status === "pending"));
    if (twin) return topicNameRefused(response, twin.id);
  }
  const update: Record<string, unknown> = {};
  if (edit.name !== undefined) {
    update.name = edit.name;
    update.nameLower = edit.nameLower;
  }
  if (edit.names !== undefined) update.names = edit.names;
  if (edit.name !== undefined || edit.names !== undefined) {
    Object.assign(update, searchFieldsFor([edit.name ?? stored.name, ...Object.values(edit.names ?? stored.names ?? {})]));
  }
  // A new picture is copied before the decision and removed again if the edit does not land.
  let copied: string | null = null;
  if (typeof edit.pictureId === "string") {
    const picture = await copyTopicPicture(await readOwnPicture(identity.uid, edit.pictureId), topicId, edit.pictureId);
    if (!picture.ok) return refuseSection(response, { code: "BAD_PICTURE", why: picture.why });
    copied = stored.picture?.url === picture.picture.url ? null : picture.path;
    update.picture = picture.picture;
  } else if (edit.pictureId === null) {
    update.picture = null;
  }

  type Saved = { replaced: string | null } | "settled" | { taken: string };
  const saved = await keepingOnlyIfWritten(copied, () => db.runTransaction(async (transaction): Promise<Saved> => {
    const fresh = await transaction.get(ref);
    const status = fresh.get("status");
    if (!fresh.exists || (status !== "approved" && status !== "pending")) return "settled";
    const taken = renaming ? await topicNameTaken(transaction, nameLower, topicId) : null;
    if (taken !== null) return { taken };
    if (Object.keys(update).length > 0) transaction.update(ref, update);
    if (renaming) reserveTopicName(transaction, nameLower, topicId);
    const change = changedFields(stored as unknown as Record<string, unknown>, update);
    if (change.after !== null) {
      auditInTransaction(transaction, auditEntry(identity.uid, role, "topic.edit", `${TOPICS}/${topicId}`, change.before, change.after));
    }
    // The picture this edit replaces, as the topic says now rather than when it was first read.
    const before = (fresh.get("picture") as SectionPicture | null | undefined)?.url;
    const after = (update.picture as SectionPicture | null | undefined)?.url;
    return { replaced: "picture" in update ? replacedTopicPicture(topicId, before, after) : null };
  }));
  if (typeof saved === "string" || "taken" in saved) {
    if (copied !== null) await discardStoredPicture(copied);
    if (saved === "settled") return refuseTopicAction(response, "settled");
    return topicNameRefused(response, saved.taken);
  }
  if (saved.replaced !== null) await discardStoredPicture(saved.replaced);
  if (edit.name !== undefined && edit.name !== topic.name) {
    await rewriteWhere(PUBLISHED, "topicId", topicId, { topicName: edit.name });
  }

  const [fresh, follow] = await Promise.all([
    ref.get(),
    db.collection(TOPIC_FOLLOWS).doc(followId(identity.uid, topicId)).get(),
  ]);
  response.status(200).json(toTopic(topicId, fresh.data() as StoredTopic, follow.exists, { uid: identity.uid, staff: true }));
}

/** The owner removing a topic no list carries any more; whoever followed it stops. */
async function deleteTopic(response: Response, identity: Identity, topicId: string): Promise<void> {
  const role = await roleOf(identity);
  if (role !== "owner") {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS", ...(role === null ? {} : { detail: "owner_only" }) });
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
  const lists = await countWhere(PUBLISHED, "topicId", topicId);
  if (!decideTopicDeletion(lists).ok) {
    response.status(409).json({ error: "Lists still carry that topic", code: "NOT_EMPTY", detail: "lists", lists });
    return;
  }
  await deleteWhere(TOPIC_FOLLOWS, "topicId", topicId);
  const stored = snapshot.data() as StoredTopic;
  const batch = db.batch();
  batch.delete(ref);
  auditInBatch(batch, auditEntry(identity.uid, role, "topic.delete", `${TOPICS}/${topicId}`, { name: stored.name, status: stored.status }, null));
  await batch.commit();
  // Public by address; with the topic gone nothing names them.
  await discardTopicPictures(topicId);
  response.status(204).send();
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
  const role = await roleOf(identity);
  if (role === null) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const db = getFirestore();
  const source = (body ?? {}) as Record<string, unknown>;
  const intoTopic = Object.prototype.hasOwnProperty.call(source, "topicId") && source.topicId !== null;
  if (intoTopic && !isTopicId(source.topicId)) {
    response.status(400).json({ error: "Which topic?", code: "INVALID" });
    return;
  }
  // Sections are read through their cache, which seeds the built-ins; the list and the topics inside the transaction.
  const asked = intoTopic ? null : isSectionId(source.category) ? await readSectionById(source.category) : null;
  if (!intoTopic && (asked === null || asked.status !== "approved")) {
    response.status(400).json({ error: "Which section?", code: "INVALID" });
    return;
  }

  type Moved = "moved" | "missing" | "bad_topic";
  const ref = db.collection(PUBLISHED).doc(listId);
  // One transaction, so two moves at once each take the list from where the other left it, and count it once.
  const moved = await db.runTransaction(async (transaction): Promise<Moved> => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return "missing";
    const stored = snapshot.data() as StoredList;
    const from = stored.topicId ?? null;

    let update: { category: string; topicId: string | null; topicName: string | null; proposedSection: null };
    if (intoTopic) {
      const target = await transaction.get(db.collection(TOPICS).doc(source.topicId as string));
      const topic = target.exists ? (target.data() as StoredTopic) : null;
      if (!topic || topic.status !== "approved" || topic.section === null) return "bad_topic";
      update = { category: topic.section, topicId: target.id, topicName: topic.name, proposedSection: null };
    } else {
      const category = (asked as SectionRecord).id;
      let keeps = false;
      if (from !== null && !Object.prototype.hasOwnProperty.call(source, "topicId")) {
        const current = await transaction.get(db.collection(TOPICS).doc(from));
        keeps = current.exists && (current.data() as StoredTopic).section === category;
      }
      update = keeps
        ? { category, topicId: from, topicName: stored.topicName ?? null, proposedSection: null }
        : { category, topicId: null, topicName: null, proposedSection: null };
    }

    transaction.update(ref, update);
    const change = changedFields(stored as unknown as Record<string, unknown>, update);
    auditInTransaction(transaction, auditEntry(identity.uid, role, "list.move", `${PUBLISHED}/${listId}`, change.before, change.after));
    if (from !== null && from !== update.topicId) {
      transaction.update(db.collection(TOPICS).doc(from), { listCount: FieldValue.increment(-1) });
    }
    if (update.topicId !== null && update.topicId !== from) {
      transaction.update(db.collection(TOPICS).doc(update.topicId), { listCount: FieldValue.increment(1) });
    }
    return "moved";
  });
  if (moved === "missing") {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  if (moved === "bad_topic") {
    response.status(400).json({ error: "Move into an approved topic", code: "INVALID" });
    return;
  }
  response.status(204).send();
}

/**
 * Who may decide besides the owner. The owner and the moderators may see who
 * they are; only the owner appoints, removes, or looks for somebody to
 * appoint: a moderator who could make moderators would make the role mean nothing.
 */
async function routeModerators(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  const [first = "", second = ""] = rest;
  const role = await roleOf(identity);
  if (method === "GET" && first === "") {
    if (role === null) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
      return;
    }
    return await readModerators(response, role);
  }
  if (role !== "owner") {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS", ...(role === null ? {} : { detail: "owner_only" }) });
    return;
  }
  if (method === "GET" && first === CANDIDATES_PATH && second === "") {
    return await readCandidates(response, query.q);
  }
  if (rest.length !== 1 || !isUid(first)) {
    response.status(400).json({ error: "Which person?", code: "INVALID" });
    return;
  }
  if (method === "POST") return await appoint(response, identity, first, body);
  if (method === "DELETE") return await removeModerator(response, identity, first);
  response.status(405).json({ error: "Use GET, POST or DELETE" });
}

/** Names, addresses and faces from Auth, a hundred accounts a call; an account Auth no longer has is left out. */
async function accountsOf(uids: string[]): Promise<Map<string, Person>> {
  const found = new Map<string, Person>();
  for (const part of chunked(uids, 100)) {
    const result = await getAuth().getUsers(part.map((uid) => ({ uid })));
    for (const user of result.users) {
      found.set(user.uid, {
        uid: user.uid,
        name: user.displayName ?? "",
        email: (user.email ?? "").toLowerCase(),
        photoUrl: user.photoURL?.startsWith("https://") ? user.photoURL : null,
      });
    }
  }
  return found;
}

/**
 * The moderators, each with what they were appointed under and what their
 * account says now. Their addresses go to the owner alone.
 */
async function readModerators(response: Response, role: Role): Promise<void> {
  const snapshot = await getFirestore().collection(ROLES).where("moderator", "==", true).get();
  const accounts = await accountsOf(snapshot.docs.map((doc) => doc.id));
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    moderators: snapshot.docs.map((doc) => {
      const account = accounts.get(doc.id);
      return {
        uid: doc.id,
        name: (doc.get("name") as string | undefined) || account?.name || "",
        photoUrl: (doc.get("photoUrl") as string | null | undefined) ?? account?.photoUrl ?? null,
        ...(role === "owner" ? { email: account?.email || null } : {}),
        appointedAt: (doc.get("appointedAt") as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? 0,
      };
    }),
  });
}

/**
 * Every account somebody could be appointed from. Auth can be listed but not
 * searched, so the list is kept a few minutes rather than read per keystroke,
 * and stops at ten thousand accounts read.
 */
const peopleIndex = new TimedCache<Person[]>(PEOPLE_TTL_MS);

async function loadPeople(): Promise<Person[]> {
  const people: Person[] = [];
  let listed = 0;
  let pageToken: string | undefined;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    listed += page.users.length;
    for (const user of page.users) {
      const person = personOf(user);
      if (person !== null) people.push(person);
    }
    pageToken = page.pageToken;
  } while (pageToken !== undefined && listed < MAX_INDEXED_ACCOUNTS);
  return people;
}

/** People to appoint, by the start of their name or address; fewer than two characters ask nothing. */
async function readCandidates(response: Response, typed: unknown): Promise<void> {
  const wanted = typeof typed === "string" ? typed.trim() : "";
  const people = wanted.length < MIN_QUERY_LENGTH ? [] : matchPeople(await peopleIndex.get(loadPeople), wanted);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ people });
}

/**
 * The owner appointing somebody: only an account signed in with a real
 * provider, since a mistyped uid would otherwise appoint nobody without a
 * word. The name and face come from the account unless the owner gives them.
 */
async function appoint(response: Response, identity: Identity, uid: string, body: unknown): Promise<void> {
  if (uid === identity.uid) {
    response.status(409).json({ error: "You already decide here", code: "YOURSELF" });
    return;
  }
  let person: Person | null;
  try {
    person = personOf(await getAuth().getUser(uid));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "auth/user-not-found") throw error;
    response.status(404).json({ error: "No such account", code: "NOT_FOUND" });
    return;
  }
  if (person === null) {
    response.status(400).json({ error: "Only a signed-in account can decide here", code: "INVALID", detail: "uid" });
    return;
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const name = cleanText(source.name, MAX_TITLE_LENGTH) ?? person.name;
  const photoUrl = typeof source.photoUrl === "string" && source.photoUrl.startsWith("https://") ? source.photoUrl : person.photoUrl;
  const db = getFirestore();
  const ref = db.collection(ROLES).doc(uid);
  const was = await ref.get();
  const batch = db.batch();
  batch.set(ref, {
    moderator: true,
    appointedBy: identity.uid,
    appointedAt: FieldValue.serverTimestamp(),
    name,
    photoUrl,
  });
  auditInBatch(batch, auditEntry(identity.uid, "owner", "moderator.appoint", `${ROLES}/${uid}`,
    { moderator: was.exists && was.get("moderator") === true }, { moderator: true, name }));
  await batch.commit();
  response.status(200).json({ uid, moderator: true });
}

async function removeModerator(response: Response, identity: Identity, uid: string): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(ROLES).doc(uid);
  const was = await ref.get();
  const batch = db.batch();
  batch.delete(ref);
  if (was.exists) {
    auditInBatch(batch, auditEntry(identity.uid, "owner", "moderator.remove", `${ROLES}/${uid}`,
      { moderator: was.get("moderator") === true, name: (was.get("name") as string | undefined) ?? "" }, { moderator: false }));
  }
  await batch.commit();
  response.status(204).send();
}

type CopiedPicture = { ok: true; path: string; picture: SectionPicture } | { ok: false; why: PictureRefusal };

/**
 * A topic's picture, checked like a section's (JPEG, PNG or WebP, sixteen by
 * ten, wide enough) and copied to its public folder.
 */
async function copyTopicPicture(bytes: Buffer | null, topicId: string, pictureId: string): Promise<CopiedPicture> {
  const judged = judgePicture(bytes);
  if (!judged.ok || bytes === null) return { ok: false, why: judged.ok ? "missing" : judged.why };
  const path = topicPicturePath(topicId, pictureId);
  await publishSectionPicture(path, bytes, CONTENT_TYPES[judged.size.format]);
  return { ok: true, path, picture: { url: addressOf(bucketName(), path), width: judged.size.width, height: judged.size.height } };
}

/**
 * One section's lists as the staff see them: lists under review too, and
 * the real author beside the public fields, though on an anonymous list only
 * the owner is told who that is. Narrowed to a topic, to the lists with none,
 * or to the lists whose topic is not an approved topic of the section.
 */
async function readAdminLists(response: Response, identity: Identity, query: Record<string, unknown>): Promise<void> {
  const role = await roleOf(identity);
  if (role === null) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const asked = readAdminListsQuery(query);
  if (!asked.ok) {
    response.status(400).json({ error: "Which section's lists?", code: "INVALID", detail: asked.detail });
    return;
  }
  const collection = getFirestore().collection(PUBLISHED);
  // A topic's lists are read by topic, whose indexes exist, and kept to the section here.
  const base = readsBySection(asked.topic)
    ? collection.where("category", "==", asked.section)
    : collection.where("topicId", "==", asked.topic);
  let ordered = base.orderBy(asked.sort === "popular" ? "takeCount" : "updatedAt", "desc");
  if (asked.after !== null) {
    const previous = await collection.doc(asked.after).get();
    if (!previous.exists) {
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }
  // For "other": the topics the rows read so far name, and which of them are approved here.
  const approvedHere = new Set<string>();
  const looked = new Set<string>();
  const page = await fillVisible(
    async (last) => {
      const docs = (await (last ? ordered.startAfter(last) : ordered).limit(FEED_PAGE_SIZE).get()).docs;
      if (asked.topic === "other") await lookUpTopics(docs, asked.section, looked, approvedHere);
      return docs;
    },
    (doc: FirebaseFirestore.QueryDocumentSnapshot) => adminKeeps(doc.data(), asked.section, asked.topic, approvedHere),
    FEED_PAGE_SIZE,
    { resumeFromHidden: true },
  );
  const proposals = await proposalsWaitedFor(page.rows);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: page.rows.map((doc) => {
      const data = doc.data() as StoredList;
      return {
        ...toSummary(doc.id, data, identity),
        underReview: data.underReview === true,
        publishedBy: publishedByFor(data, role === "owner"),
        ...waitingFor(data.proposedSection, proposals),
      };
    }),
    nextCursor: page.next?.id ?? null,
  });
}

/** Reads the topics these lists name that were not read yet, and notes the ones approved into `section`. */
async function lookUpTopics(
  docs: readonly FirebaseFirestore.QueryDocumentSnapshot[],
  section: string,
  looked: Set<string>,
  approvedHere: Set<string>,
): Promise<void> {
  const ids = [...new Set(docs.map((doc) => doc.get("topicId")).filter(isTopicId))].filter((id) => !looked.has(id));
  if (ids.length === 0) return;
  ids.forEach((id) => looked.add(id));
  const db = getFirestore();
  const topics = await db.getAll(...ids.map((id) => db.collection(TOPICS).doc(id)));
  for (const topic of topics) {
    if (topic.exists && topic.get("status") === "approved" && topic.get("section") === section) approvedHere.add(topic.id);
  }
}

type TopicApproval =
  | { refused: "missing" | "settled" | "bad_section" | "bad_name" }
  | { taken: Pick<KnownTopic, "id" | "section"> }
  | { done: true };

/**
 * A proposal approved as a topic inside a section that exists: in one
 * transaction the topic is made, under the proposal's name or a better one
 * and with its picture, the proposal is marked merged into the section and
 * the topic, and the names change hands. The lists waiting for it move after,
 * and asking again finishes a move cut short.
 */
async function approveAsTopic(response: Response, identity: Identity, id: string, body: unknown): Promise<void> {
  const role = await roleFor(response, identity, "approve");
  if (role === null) return;
  const source = (body ?? {}) as Record<string, unknown>;
  const [proposal, section] = await Promise.all([
    isSectionId(id) ? readSectionById(id) : null,
    isSectionId(source.section) ? readSectionById(source.section) : null,
  ]);
  const early = decideApproveAsTopic(proposal, section, body);
  if (!early.ok) return refuseTopicApproval(response, early.reason);
  if (early.resume) return await finishTopicApproval(response, identity, id, early.section, early.topicId);

  const db = getFirestore();
  const same = await db.collection(TOPICS).where("nameLower", "==", early.nameLower).get();
  const twin = same.docs
    .map((doc) => knownTopic(doc.id, doc.data() as StoredTopic))
    .find((one) => one.status === "approved" || one.status === "pending");
  if (twin) return topicNameRefused(response, twin.id, twin.section);

  // The proposal's picture goes public as the topic's; a proposal whose copy is gone makes a topic without one.
  const topicRef = db.collection(TOPICS).doc();
  const privatePath = (proposal as SectionRecord).proposalPicture;
  const picture = privatePath === null
    ? null
    : await copyTopicPicture(await readStoredPicture(privatePath), topicRef.id, pictureIdOf(privatePath));
  const kept = picture?.ok ? picture : null;

  const ref = db.collection(SECTIONS).doc(id);
  const outcome = await keepingOnlyIfWritten(kept?.path ?? null, () => db.runTransaction(async (transaction): Promise<TopicApproval> => {
    const [fresh, place] = await Promise.all([transaction.get(ref), transaction.get(db.collection(SECTIONS).doc(early.section))]);
    const current = fresh.exists ? sectionRecord(id, fresh.data() as StoredSection) : null;
    const target = place.exists ? sectionRecord(place.id, place.data() as StoredSection) : null;
    const again = decideApproveAsTopic(current, target, body);
    if (!again.ok) return { refused: again.reason };
    if (again.resume || current === null) return { refused: "settled" };
    const taken = await topicNameHolder(transaction, again.nameLower, null);
    if (taken !== null) return { taken: { id: taken.id, section: taken.section } };
    const released = await ownReservations(transaction, releasedNames(namesAfter(current, {}), []), id);
    transaction.set(topicRef, {
      name: again.name,
      nameLower: again.nameLower,
      names: again.names,
      ...searchFieldsFor([again.name, ...Object.values(again.names)]),
      section: again.section,
      status: "approved",
      requestedSection: again.section,
      createdBy: current.proposerUid ?? identity.uid,
      proposerName: current.proposerName ?? identity.name ?? "Anonymous",
      createdAt: FieldValue.serverTimestamp(),
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: identity.uid,
      listCount: 0,
      followerCount: 0,
      mergedInto: null,
      picture: kept?.picture ?? null,
    });
    reserveTopicName(transaction, again.nameLower, topicRef.id);
    released.forEach((one) => transaction.delete(one));
    transaction.update(ref, {
      status: "merged",
      mergedInto: again.section,
      mergedTopicId: topicRef.id,
      decidedAs: APPROVE_AS_TOPIC,
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: identity.uid,
      unfinished: true,
    });
    auditInTransaction(transaction, auditEntry(identity.uid, role, "section.approve_as_topic", `${SECTIONS}/${id}`,
      { status: current.status }, { status: "merged", mergedInto: again.section, mergedTopicId: topicRef.id }));
    auditInTransaction(transaction, auditEntry(identity.uid, role, "topic.create", `${TOPICS}/${topicRef.id}`, null,
      { name: again.name, section: again.section, status: "approved", picture: kept?.picture ?? null, fromProposal: id }));
    return { done: true };
  }));
  if (!("done" in outcome)) {
    if (kept !== null) await discardStoredPicture(kept.path);
    if ("taken" in outcome) return topicNameRefused(response, outcome.taken.id, outcome.taken.section);
    return refuseTopicApproval(response, outcome.refused);
  }
  await finishTopicApproval(response, identity, id, early.section, topicRef.id);
}

type TopicMerge = { refused: "missing" | "settled" | "bad_topic" } | { done: true };

/**
 * A proposal merged into a topic that exists: in one transaction the
 * proposal is marked merged into the topic and its section, and lets its
 * names go. The lists waiting for it move after, as for a topic made from
 * it, and asking again finishes a move cut short. The topic keeps its own
 * picture; the proposal's private copy is deleted.
 */
async function mergeIntoTopic(response: Response, identity: Identity, id: string, body: unknown): Promise<void> {
  const role = await roleFor(response, identity, "approve");
  if (role === null) return;
  const db = getFirestore();
  const topicId = mergeTopicId(body);
  const [proposal, held] = await Promise.all([
    isSectionId(id) ? readSectionById(id) : null,
    topicId === null ? null : db.collection(TOPICS).doc(topicId).get(),
  ]);
  const topic = held?.exists ? knownTopic(held.id, held.data() as StoredTopic) : null;
  // Read through the built-ins, which seeds them, so the transaction finds a built-in section too.
  const section = topic?.section ? await readSectionById(topic.section) : null;
  const early = decideMergeIntoTopic(proposal, topic, section);
  if (!early.ok) return refuseTopicMerge(response, early.reason);
  if (early.resume) return await finishTopicApproval(response, identity, id, early.section, early.topicId);

  const ref = db.collection(SECTIONS).doc(id);
  const outcome = await db.runTransaction(async (transaction): Promise<TopicMerge> => {
    const [fresh, topicNow, place] = await Promise.all([
      transaction.get(ref),
      transaction.get(db.collection(TOPICS).doc(early.topicId)),
      transaction.get(db.collection(SECTIONS).doc(early.section)),
    ]);
    const current = fresh.exists ? sectionRecord(id, fresh.data() as StoredSection) : null;
    const into = topicNow.exists ? knownTopic(topicNow.id, topicNow.data() as StoredTopic) : null;
    const target = place.exists ? sectionRecord(place.id, place.data() as StoredSection) : null;
    const again = decideMergeIntoTopic(current, into, target);
    if (!again.ok) return { refused: again.reason };
    if (again.resume || current === null) return { refused: "settled" };
    const released = await ownReservations(transaction, releasedNames(namesAfter(current, {}), []), id);
    released.forEach((one) => transaction.delete(one));
    transaction.update(ref, {
      status: "merged",
      mergedInto: again.section,
      mergedTopicId: again.topicId,
      decidedAs: MERGE_INTO_TOPIC,
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: identity.uid,
      unfinished: true,
    });
    auditInTransaction(transaction, auditEntry(identity.uid, role, "section.merge_into_topic", `${SECTIONS}/${id}`,
      { status: current.status }, { status: "merged", mergedInto: again.section, mergedTopicId: again.topicId }));
    return { done: true };
  });
  if (!("done" in outcome)) return refuseTopicMerge(response, outcome.refused);
  await finishTopicApproval(response, identity, id, early.section, early.topicId);
}

function refuseTopicMerge(response: Response, reason: "missing" | "settled" | "bad_topic"): void {
  if (reason === "bad_topic") {
    response.status(400).json({ error: "Merge it into an approved topic of an open section", code: "INVALID", detail: "topic" });
    return;
  }
  refuseTopicApproval(response, reason);
}

/**
 * The lists that waited for the proposal move into the topic it became, or
 * wherever that topic was merged since; into the section without a topic
 * when it was rejected or deleted. A page at a time, each page in one
 * transaction with what it adds to the topic's count: only lists still
 * waiting are moved, so finishing twice counts nothing twice.
 */
async function finishTopicApproval(
  response: Response,
  identity: Identity,
  proposalId: string,
  section: string,
  topicId: string,
): Promise<void> {
  const db = getFirestore();
  const waiting = db
    .collection(PUBLISHED)
    .where("proposedSection", "==", proposalId)
    .orderBy(FieldPath.documentId())
    .limit(WRITES_PER_BATCH);
  let live = await liveTopic(topicId);
  for (let stale = 0; ; ) {
    const moved = await db.runTransaction(async (transaction): Promise<number | "stale"> => {
      const topicRef = live === null ? null : db.collection(TOPICS).doc(live.id);
      // Read again with the page: a topic merged or rejected in between sends the lists elsewhere.
      const topicNow = topicRef === null ? null : await transaction.get(topicRef);
      if (topicRef !== null && !(topicNow?.exists && "live" in topicHop(topicNow.data() as StoredTopic))) return "stale";
      const page = await transaction.get(waiting);
      const change = live === null
        ? { category: section, topicId: null, topicName: null, proposedSection: null }
        : { category: live.section ?? section, topicId: live.id, topicName: live.name, proposedSection: null };
      page.docs.forEach((doc) => transaction.update(doc.ref, change));
      if (topicRef !== null && page.size > 0) transaction.update(topicRef, { listCount: FieldValue.increment(page.size) });
      return page.size;
    });
    if (moved === "stale") {
      if (++stale > MAX_TOPIC_HOPS) throw new Error(`Topic ${topicId} kept changing while its lists moved`);
      live = await liveTopic(topicId);
      continue;
    }
    if (moved < WRITES_PER_BATCH) break;
  }
  await discardProposalPicture(proposalId);
  await db.collection(SECTIONS).doc(proposalId).update({ unfinished: false, proposalPicture: null, proposalPictureUrl: null });
  await bumpSectionsVersion();
  forgetSections();
  // The topic the lists are in now, or the one the proposal became when they are in none.
  const shownId = live?.id ?? topicId;
  const [fresh, proposal] = await Promise.all([db.collection(TOPICS).doc(shownId).get(), readSectionById(proposalId)]);
  response.status(200).json({
    topic: fresh.exists ? toTopic(shownId, fresh.data() as StoredTopic, false, { uid: identity.uid, staff: true }) : null,
    proposal: proposal === null ? null : sectionView(proposal, { uid: identity.uid, moderator: true }, noStats(proposalId), false),
  });
}

function refuseTopicApproval(response: Response, reason: "missing" | "settled" | "bad_section" | "bad_name"): void {
  switch (reason) {
    case "missing":
      return noSuchSection(response);
    case "settled":
      response.status(409).json({ error: "That section has been decided already", code: "SETTLED" });
      return;
    case "bad_section":
      response.status(400).json({ error: "Approve it into an open section", code: "INVALID", detail: "section" });
      return;
    case "bad_name":
      response.status(400).json({ error: "A topic name is two to forty characters", code: "INVALID", detail: "name" });
      return;
  }
}

/** Paths under lists/admin: how much is waiting for the owner and the moderators, and a section's lists as they see them. */
async function routeAdmin(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  response: Response,
  identity: Identity,
): Promise<void> {
  if (method === "GET" && rest.length === 1 && rest[0] === "counts") {
    return await readAdminCounts(response, identity);
  }
  if (method === "GET" && rest.length === 1 && rest[0] === "lists") {
    return await readAdminLists(response, identity, query);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

/**
 * Open reports, every one the queue would show, and section proposals
 * waiting: counted, never read.
 */
async function readAdminCounts(response: Response, identity: Identity): Promise<void> {
  if (!(await isModeratorNow(identity))) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const db = getFirestore();
  const [reports, proposals] = await Promise.all([
    db.collection(REPORTS).count().get(),
    db.collection(SECTIONS).where("status", "==", "pending").count().get(),
  ]);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ reports: reports.data().count, proposals: proposals.data().count });
}

/**
 * Searches nothing answered: a client says so once it has asked everywhere
 * (sections, topics, lists), and staff read the most asked. Only the words
 * are kept, never who typed them.
 */
async function routeSearchMisses(method: string, body: unknown, response: Response, identity: Identity): Promise<void> {
  if (method === "POST") {
    const miss = missOf((body as { q?: unknown } | null)?.q);
    if (miss !== null) {
      await getFirestore()
        .collection(SEARCH_MISSES)
        .doc(createHash("sha256").update(miss).digest("hex"))
        .set({ q: miss, count: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    response.status(204).send();
    return;
  }
  if (method === "GET") {
    if (!(await isModeratorNow(identity))) {
      response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
      return;
    }
    const snapshot = await getFirestore().collection(SEARCH_MISSES).orderBy("count", "desc").limit(100).get();
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      misses: snapshot.docs.map((doc) => ({ q: doc.get("q"), count: doc.get("count") ?? 0, lastAt: doc.get("lastAt")?.toMillis() ?? 0 })),
    });
    return;
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

/**
 * The house's lists (src/editorial.ts), for the owner and the moderators:
 * list them, publish one, replace one, take one down. A published one is read, ranked and found
 * like any other list.
 */
async function routeEditorial(
  method: string,
  rest: string[],
  query: Record<string, unknown>,
  body: unknown,
  response: Response,
  identity: Identity,
): Promise<void> {
  const access = decideEditorialAccess(await roleOf(identity));
  if (!access.ok) {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS" });
    return;
  }
  const house = editorialByline(access.speaker);
  const [id = "", extra = ""] = rest;
  if (extra === "") {
    if (method === "GET" && id === "") return await readEditorialLists(response, identity, typeof query.after === "string" ? query.after : null);
    if (method === "POST" && id === "") return await publish(response, identity, body, null, house);
    if (method === "PUT" && id !== "") return await publish(response, identity, body, id, house);
    if (method === "DELETE" && id !== "") return await unpublish(response, identity, id, house);
  }
  response.status(404).json({ error: "No such route", code: "NOT_FOUND" });
}

/** The house's lists, the latest change first, a page at a time. */
async function readEditorialLists(response: Response, identity: Identity, after: string | null): Promise<void> {
  const collection = getFirestore().collection(PUBLISHED);
  let ordered = collection.where("authorUid", "==", EDITORIAL_UID).orderBy("updatedAt", "desc");
  if (after) {
    const previous = await collection.doc(after).get();
    if (!previous.exists) {
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }
  const snapshot = await ordered.limit(FEED_PAGE_SIZE).get();
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: snapshot.docs.map((doc) => toSummary(doc.id, doc.data() as StoredList, identity)),
    nextCursor: nextCursor(snapshot.docs.map((doc) => doc.id)),
  });
}

/**
 * Every list published without its author's name, newest first, each with
 * who published it. The owner's alone to read: it undoes the very thing
 * those authors asked for.
 */
async function readAnonymousLists(response: Response, identity: Identity, after: string | null): Promise<void> {
  const role = await roleOf(identity);
  if (role !== "owner") {
    response.status(403).json({ error: "Not yours", code: "NOT_YOURS", ...(role === null ? {} : { detail: "owner_only" }) });
    return;
  }
  const collection = getFirestore().collection(PUBLISHED);
  let ordered = collection.where("anonymous", "==", true).orderBy("updatedAt", "desc");
  if (after) {
    const previous = await collection.doc(after).get();
    if (!previous.exists) {
      response.status(409).json({ error: "That page is gone", code: "CURSOR_GONE" });
      return;
    }
    ordered = ordered.startAfter(previous);
  }
  const snapshot = await ordered.limit(FEED_PAGE_SIZE).get();
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: snapshot.docs.map((doc) => {
      const data = doc.data() as StoredList;
      return { ...toSummary(doc.id, data, identity), publishedBy: { uid: data.authorUid, name: data.authorName } };
    }),
    nextCursor: nextCursor(snapshot.docs.map((doc) => doc.id)),
  });
}

/** One line in the log, written by the batch that carries the change itself. */
function auditInBatch(batch: FirebaseFirestore.WriteBatch, entry: AuditEntry): void {
  batch.set(getFirestore().collection(AUDIT_LOG).doc(), { ...entry, at: FieldValue.serverTimestamp() });
}

/** One line in the log, written by the transaction that carries the change itself. */
function auditInTransaction(transaction: FirebaseFirestore.Transaction, entry: AuditEntry): void {
  transaction.set(getFirestore().collection(AUDIT_LOG).doc(), { ...entry, at: FieldValue.serverTimestamp() });
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed.slice(0, maxLength);
}
