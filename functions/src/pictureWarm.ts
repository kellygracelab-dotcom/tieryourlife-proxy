/*
 * The site makes a picture's small copy the first time somebody asks for it and keeps it (Web #294:
 * beside the picture in Storage; a collage in share/c/{id}/). A freshly published list of 117 cards
 * opened first took 5.5 s at the median, 6.9 s for all, against 1.1 s once the copies were there (Web,
 * Coordinator, 28.11.2026). So after a publication or an Update the proxy asks the site for them itself,
 * in the background, a few at a time: the first visitor finds them made.
 *
 * What the site's pages ask for (Web, src/lib/pictureSize.ts, a copy at least twice the shown width):
 * a card's picture at /img/200 (64 CSS px tiles), a collage cell's at /img/400 (200 CSS px), and the
 * feed card's collage at its own `collageUrl`. A cover and the game modes read the original, which the
 * site sends as it is: nothing to make.
 *
 * A job per list and revision in `pictureWarmJobs`, done by the `warmPictures` trigger
 * (src/pictureWarmJobs.ts) and deleted when done. Nothing waits for it and nothing fails with it: a copy
 * not made now is made on its first view, as before. No retries. The emulator never asks the real site.
 */

import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";
import { isDemoEmulator } from "./emulator";
import { bucketPathOf } from "./publicMedia";

export const PICTURE_WARM_JOBS = "pictureWarmJobs";
const SITE_IMG = "https://tieryourlife.com/img/";
/** A card's tile copy, and a collage cell's. */
export const CARD_WIDTH = 200;
export const PREVIEW_WIDTH = 400;
/** At most this many asked at once: the site's function draws them on one vCPU. */
export const WARM_AT_ONCE = 3;
/** Under Hosting's 60 s. */
export const WARM_WAIT_MS = 30_000;
/** More pictures than any list holds; a job never outlives its trigger's 540 s. */
export const WARM_MOST = 300;
export const WARM_USER_AGENT = "TierYourLife-Proxy warm-up";

export interface PictureWarmJob {
  listId: string;
  revision: number | string;
  /** Bucket paths under `published/` of card pictures. */
  cards: string[];
  /** Bucket paths under `published/` of collage pictures. */
  previews: string[];
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

/**
 * Queues the job. Queued even with no new picture: every revision moves the collage's address, and the
 * trigger asks for it when the list shows one. Nothing in the emulator; a queue that cannot be written
 * is logged.
 */
export async function queuePictureWarm(job: PictureWarmJob, demo: boolean = isDemoEmulator()): Promise<void> {
  if (demo) return;
  try {
    await getFirestore()
      .collection(PICTURE_WARM_JOBS)
      .doc(pictureWarmJobId(job.listId, job.revision))
      .set({ ...job, cards: job.cards.slice(0, WARM_MOST), previews: job.previews.slice(0, WARM_MOST), queuedAt: FieldValue.serverTimestamp() });
  } catch (error) {
    console.warn("Picture warm-up not queued", error instanceof Error ? error.message : error);
  }
}

/** The site's addresses to ask for: the collage first (the feed's heaviest), then cells, then cards. */
export function warmAddresses(cards: readonly string[], previews: readonly string[], collageUrl: string | null): string[] {
  return [
    ...(collageUrl === null ? [] : [collageUrl]),
    ...previews.slice(0, WARM_MOST).map((path) => `${SITE_IMG}${PREVIEW_WIDTH}/${path}`),
    ...cards.slice(0, WARM_MOST).map((path) => `${SITE_IMG}${CARD_WIDTH}/${path}`),
  ];
}

export interface WarmOutcome {
  asked: number;
  ok: number;
  failed: number;
  /** A few of the failures, as `{status or error} {address}`. */
  failures: string[];
}

/** Asks the site for every address, [atOnce] at a time. */
export async function warmPictures(
  addresses: readonly string[],
  fetcher: typeof fetch = fetch,
  { atOnce = WARM_AT_ONCE, waitMs = WARM_WAIT_MS }: { atOnce?: number; waitMs?: number } = {},
): Promise<WarmOutcome> {
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

export interface PictureWarmWork {
  /** The list's `collageUrl` as a reader is told it now, or null (no collage, or the list is gone). */
  collageOf(listId: string): Promise<string | null>;
  warm(addresses: readonly string[]): Promise<WarmOutcome>;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);

/** Reads the job, asks for its copies, logs one line and deletes the job. */
export async function handlePictureWarm(ref: DocumentReference, work: PictureWarmWork): Promise<void> {
  const data = (await ref.get()).data() ?? {};
  const listId = typeof data.listId === "string" ? data.listId : null;
  const started = Date.now();
  const collage = listId === null ? null : await work.collageOf(listId).catch(() => null);
  const addresses = warmAddresses(strings(data.cards), strings(data.previews), collage);
  const outcome = addresses.length > 0 ? await work.warm(addresses) : { asked: 0, ok: 0, failed: 0, failures: [] };
  console.log(`Picture warm-up ${JSON.stringify({ listId, revision: data.revision ?? null, collage: collage !== null, ...outcome, ms: Date.now() - started })}`);
  await ref.delete().catch(() => undefined);
}
