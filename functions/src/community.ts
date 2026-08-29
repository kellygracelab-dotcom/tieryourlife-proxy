import { onRequest } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { requireUser, type Identity } from "./auth";
import {
  CATEGORIES,
  FEED_PAGE_SIZE,
  MAX_TITLE_LENGTH,
  decidePublish,
  type Category,
  type PublishDecision,
} from "./publishing";

const PUBLISHED = "publishedLists";

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

    // Everything after /lists — empty for the feed, an id for one list.
    const id = request.path.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
    const hasId = id.length > 0 && id !== "lists";

    try {
      switch (request.method) {
        case "GET":
          return hasId
            ? await readOne(response, id)
            : await readFeed(response, {
                category: categoryFilter(request.query.category),
                author: singleParam(request.query.author),
                query: searchTerm(request.query.q),
              });
        case "POST":
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
  const ordered = filters.query
    ? query
        .where("titleLower", ">=", filters.query)
        .where("titleLower", "<=", `${filters.query}`)
        .orderBy("titleLower")
    : query.orderBy("updatedAt", "desc");

  const snapshot = await ordered.limit(FEED_PAGE_SIZE).get();

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    lists: snapshot.docs.map((doc) => toSummary(doc.id, doc.data() as StoredList)),
  });
}

async function readOne(response: Response, id: string): Promise<void> {
  const doc = await getFirestore().collection(PUBLISHED).doc(id).get();
  if (!doc.exists) {
    response.status(404).json({ error: "No such list", code: "NOT_FOUND" });
    return;
  }
  const data = doc.data() as StoredList;
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

  const document = {
    authorUid: identity.uid,
    authorName: identity.name ?? "Anonymous",
    authorPhotoUrl: identity.picture,
    title: decision.list.title,
    titleLower: decision.list.titleLower,
    category: decision.list.category,
    tiers: decision.list.tiers,
    items: decision.list.items,
    itemCount: decision.list.items.length,
    coverImageUrl: decision.list.coverImageUrl,
    previewImages: decision.list.previewImages,
    tierColors: decision.list.tierColors,
    updatedAt: FieldValue.serverTimestamp(),
  };

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
    await collection.doc(existingId).set(document, { merge: true });
    response.status(200).json({ id: existingId });
    return;
  }

  const created = await collection.add({ ...document, publishedAt: FieldValue.serverTimestamp() });
  response.status(201).json({ id: created.id });
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
  response.status(204).send();
}
