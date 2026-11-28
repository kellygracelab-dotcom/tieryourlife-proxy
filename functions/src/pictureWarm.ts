/*
 * The site makes a card's small copy (/img/200, /img/400) the first time somebody asks for it, and keeps
 * it in Storage beside the picture (Web #294). A freshly published list of 117 cards opened first took
 * 5.5 s at the median, 6.9 s for all, against 1.1 s once the copies were there (Web, Coordinator,
 * 28.11.2026). So after a publication or an Update the proxy asks the site for those copies itself, in
 * the background, a few at a time: the first visitor finds them made.
 *
 * A job per list and revision in `pictureWarmJobs`, done by the `warmPictures` trigger
 * (src/pictureWarmJobs.ts) and deleted when done. Nothing waits for it and nothing fails with it: a copy
 * not made now is made on its first view, as before. No retries. The emulator never asks the real site.
 */

import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";
import { isDemoEmulator } from "./emulator";
import { bucketPathOf } from "./publicMedia";

export const PICTURE_WARM_JOBS = "pictureWarmJobs";
/** The widths the site keeps a card's copy at (Web's CARD_WIDTHS). */
export const WARM_WIDTHS: readonly number[] = [200, 400];
const SITE_IMG = "https://tieryourlife.com/img/";
/** At most this many asked at once: the site's function draws them on one vCPU. */
export const WARM_AT_ONCE = 3;
export const WARM_WAIT_MS = 30_000;
/** More pictures than any list holds; a job never outlives its trigger's 540 s. */
export const WARM_MOST = 300;
export const WARM_USER_AGENT = "TierYourLife-Proxy warm-up";

export interface PictureWarmJob {
  listId: string;
  revision: number;
  /** Bucket paths under `published/`. */
  paths: string[];
}

/** The `published/` bucket paths among [urls], each once, in order. */
export function warmPathsOf(urls: readonly (string | null | undefined)[]): string[] {
  const paths = urls.flatMap((url) => {
    const path = typeof url === "string" ? bucketPathOf(url) : null;
    return path !== null && path.startsWith("published/") ? [path] : [];
  });
  return [...new Set(paths)];
}

/** One job per list and revision: the same revision queued twice is one job. */
export function pictureWarmJobId(listId: string, revision: number | string): string {
  return `${listId}_${revision}`;
}

/** Queues the job; nothing to warm, the emulator, or a queue that cannot be written: nothing, logged. */
export async function queuePictureWarm(job: PictureWarmJob, demo: boolean = isDemoEmulator()): Promise<void> {
  if (demo || job.paths.length === 0) return;
  try {
    await getFirestore()
      .collection(PICTURE_WARM_JOBS)
      .doc(pictureWarmJobId(job.listId, job.revision))
      .set({ ...job, paths: job.paths.slice(0, WARM_MOST), queuedAt: FieldValue.serverTimestamp() });
  } catch (error) {
    console.warn("Picture warm-up not queued", error instanceof Error ? error.message : error);
  }
}

export interface WarmOutcome {
  asked: number;
  ok: number;
  failed: number;
  /** A few of the failures, as `{status or error} {address}`. */
  failures: string[];
}

/** Asks the site for every path at every width, [atOnce] at a time. */
export async function warmPictures(
  paths: readonly string[],
  fetcher: typeof fetch = fetch,
  { atOnce = WARM_AT_ONCE, waitMs = WARM_WAIT_MS }: { atOnce?: number; waitMs?: number } = {},
): Promise<WarmOutcome> {
  const addresses = paths.slice(0, WARM_MOST).flatMap((path) => WARM_WIDTHS.map((width) => `${SITE_IMG}${width}/${path}`));
  const outcome: WarmOutcome = { asked: addresses.length, ok: 0, failed: 0, failures: [] };
  let next = 0;
  const fail = (why: string, address: string) => {
    outcome.failed++;
    if (outcome.failures.length < 5) outcome.failures.push(`${why} ${address}`);
  };
  const worker = async () => {
    while (next < addresses.length) {
      const address = addresses[next++];
      try {
        const answer = await fetcher(address, { headers: { "User-Agent": WARM_USER_AGENT }, signal: AbortSignal.timeout(waitMs) });
        // Read to the end: the site keeps the copy once it has drawn it.
        await answer.arrayBuffer();
        if (answer.ok) outcome.ok++;
        else fail(String(answer.status), address);
      } catch (error) {
        fail(error instanceof Error ? error.name : "error", address);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, addresses.length) }, worker));
  return outcome;
}

/** Reads the job, asks for its copies, logs one line and deletes the job. */
export async function handlePictureWarm(ref: DocumentReference, warm: typeof warmPictures = warmPictures): Promise<void> {
  const data = (await ref.get()).data();
  const paths = Array.isArray(data?.paths) ? data.paths.filter((one: unknown): one is string => typeof one === "string") : [];
  const started = Date.now();
  const outcome = paths.length > 0 ? await warm(paths) : { asked: 0, ok: 0, failed: 0, failures: [] };
  console.log(`Picture warm-up ${JSON.stringify({ listId: data?.listId ?? null, revision: data?.revision ?? null, ...outcome, ms: Date.now() - started })}`);
  await ref.delete().catch(() => undefined);
}
