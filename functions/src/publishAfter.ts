/**
 * What an Update of a published list leaves for after its answer (26.11.2026, publish-update-speed BRIEF,
 * step 3): every copy of the list credited as the list now is, and the list's copies it no longer names
 * retired. One job per revision, done by the `publishAfter` trigger (src/publishAfterJobs.ts): the
 * answer no longer waits the second or four these took on a big list.
 *
 * A job that fails is tried again by the trigger's retry; after [PUBLISH_AFTER_TRIES] failures an
 * ERROR line "Publish after failed" is written and the job is left as it is, with `gaveUpAt`. Nothing is
 * lost for good: the next Update of the list does both again, and a copy left unretired only takes room.
 * A change of the author's name or of anonymity is credited in the request itself, as before.
 */

import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";

export const PUBLISH_AFTER_JOBS = "publishAfterJobs";
export const PUBLISH_AFTER_TRIES = 3;

export interface PublishAfterJob {
  listId: string;
  revision: number;
  /** Copies the revision names (`published/{listId}/` names), kept. */
  keep: string[];
  /** Copies the revision before named: the only ones that may be retired. */
  previous: string[];
  /** The byline as this revision stored it. */
  credits: { anonymous: boolean; authorUid: string; authorName: string };
}

/** What doing a job needs, apart from the job: the list as it now is, crediting and retiring. */
export interface PublishAfterWork {
  /** The list's revision and the copies it names now; null when it is gone. */
  readList(listId: string): Promise<{ revision: number; names: string[] } | null>;
  syncCredits(listId: string, anonymous: boolean, authorUid: string, authorName: string): Promise<void>;
  retire(listId: string, keeping: string[], candidates: string[]): Promise<void>;
}

/** One job per list and revision: the same revision queued twice is one job. */
export function publishAfterJobId(listId: string, revision: number): string {
  return `${listId}_${revision}`;
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((one) => typeof one === "string") ? (value as string[]) : null);

export function readPublishAfterJob(raw: unknown): PublishAfterJob | null {
  const data = (raw ?? {}) as Record<string, unknown>;
  const credits = (data.credits ?? {}) as Record<string, unknown>;
  const keep = strings(data.keep);
  const previous = strings(data.previous);
  if (typeof data.listId !== "string" || data.listId === "" || typeof data.revision !== "number" || keep === null || previous === null) return null;
  if (typeof credits.anonymous !== "boolean" || typeof credits.authorUid !== "string" || typeof credits.authorName !== "string") return null;
  return { listId: data.listId, revision: data.revision, keep, previous, credits: { anonymous: credits.anonymous, authorUid: credits.authorUid, authorName: credits.authorName } };
}

/**
 * Queues [job]; the same revision already queued stays as it is. False when the queue could not be
 * written: the caller then does the work itself, as before 26.11.2026.
 */
export async function queuePublishAfter(job: PublishAfterJob): Promise<boolean> {
  const db = getFirestore();
  const ref = db.collection(PUBLISH_AFTER_JOBS).doc(publishAfterJobId(job.listId, job.revision));
  try {
    await db.runTransaction(async (transaction) => {
      if ((await transaction.get(ref)).exists) return;
      transaction.set(ref, { ...job, attempts: 0, queuedAt: FieldValue.serverTimestamp() });
    });
    return true;
  } catch (error) {
    console.warn("Publish after not queued", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The job's work against the list as it now is. A later revision has its own job with the byline as
 * it then was, so this one credits nothing; whatever the list now names is kept either way.
 */
export async function doPublishAfter(job: PublishAfterJob, work: PublishAfterWork): Promise<"done" | "gone"> {
  const now = await work.readList(job.listId);
  if (now === null) return "gone";
  const tasks: Promise<void>[] = [work.retire(job.listId, [...new Set([...job.keep, ...now.names])], job.previous)];
  if (now.revision === job.revision) tasks.push(work.syncCredits(job.listId, job.credits.anonymous, job.credits.authorUid, job.credits.authorName));
  const failed = (await Promise.allSettled(tasks)).find((one): one is PromiseRejectedResult => one.status === "rejected");
  if (failed) throw failed.reason;
  return "done";
}

/**
 * One delivery of the job at [ref]: counted, done, and removed once done. A failure is thrown for the
 * trigger to be retried, until the tries are used up: then the ERROR line, and no more retries.
 */
export async function handlePublishAfter(ref: DocumentReference, work: PublishAfterWork): Promise<"done" | "gone" | "gave up" | "missing"> {
  const counted = await getFirestore().runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.get("gaveUpAt") !== undefined) return null;
    const attempts = (typeof doc.get("attempts") === "number" ? (doc.get("attempts") as number) : 0) + 1;
    transaction.update(ref, { attempts });
    return { attempts, job: readPublishAfterJob(doc.data()) };
  });
  if (counted === null) return "missing";
  if (counted.job === null || counted.attempts > PUBLISH_AFTER_TRIES) {
    console.error("Publish after failed", JSON.stringify({ job: ref.id, tries: counted.attempts - 1, readable: counted.job !== null }));
    await ref.update({ gaveUpAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    return "gave up";
  }
  const outcome = await doPublishAfter(counted.job, work);
  await ref.delete();
  return outcome;
}
