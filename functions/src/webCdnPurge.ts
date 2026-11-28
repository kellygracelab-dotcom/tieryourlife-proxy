import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { discardPublished } from "./publishedPictures";
import { isDemoEmulator } from "./emulator";

/*
 * The site's CDN keeps a published picture a day (Web, 28.11.2026), and Hosting's CDN cannot be cleared
 * by path. So after a moderation takedown has deleted a list's pictures, the Proxy leaves a note here and
 * calls the site's `POST /api/cdn-purge`, which takes the notes not done yet, removes the site's smaller
 * copies of every path named, clears the whole CDN with a new Hosting release and marks them `doneAt`. Only a takedown writes one: a list its author withdraws, an erased account
 * and a copy no list names any more hide nothing urgent, and a day of an edge copy is their trade-off.
 * Nothing else reads this collection; clients cannot (firestore.rules).
 */
export const WEB_CDN_PURGES = "webCdnPurges";
/** The site's own route; with no note waiting it does nothing, so it needs no key. */
export const WEB_CDN_PURGE_URL = "https://tieryourlife.com/api/cdn-purge";
/** The site answers in 10-60 s; a takedown does not wait for it, and the clearing goes on there. */
export const WEB_CDN_PURGE_WAIT_MS = 5_000;

export interface WebCdnPurge {
  listId: string;
  reason: "takedown";
  /** Every file deleted, as its full path in the bucket (`published/{list}/{name}`). */
  paths: string[];
}

export interface TakedownPictureTools {
  /** The full paths of the files in a list's own published folder. */
  ownFiles(listId: string): Promise<string[]>;
  /** A list's own published folder, its share cards and collages, deleted. */
  discardOwn(listId: string): Promise<void>;
  /** The copies other lists hold of its pictures, deleted; their full paths. */
  discardCopies(listId: string): Promise<string[]>;
  /** The note for the site's CDN, written. */
  askPurge(purge: WebCdnPurge): Promise<void>;
  /** The site told to clear its CDN of the notes waiting. */
  callPurge(): Promise<void>;
}

/**
 * A taken-down list's pictures: its folder and the copies others made, deleted, and then the site asked
 * to clear its CDN of them. The deletion has happened by the time the note is written, so the site never
 * clears the CDN only to be handed the same picture again. A note that cannot be written leaves the
 * takedown done and is logged: the edge copy then lives out its day. The site is then called; a call that
 * fails or takes longer than a few seconds is logged and leaves the note waiting for the next call.
 */
export async function takeDownPictures(listId: string, tools: TakedownPictureTools): Promise<void> {
  const own = await tools.ownFiles(listId);
  await tools.discardOwn(listId);
  const copies = await tools.discardCopies(listId);
  await tools.askPurge({ listId, reason: "takedown", paths: [...new Set([...own, ...copies])] }).catch((error) => {
    console.error(`Web CDN purge for ${listId} not asked: ${(error as Error).message}`);
  });
  await tools.callPurge().catch((error) => {
    console.warn(`Web CDN purge call failed for ${listId}: ${(error as Error).message}`);
  });
}

/** Calls the site's route; anything but a 2xx answer within [waitMs] is an error. */
export async function callWebCdnPurge(fetcher: typeof fetch = fetch, waitMs: number = WEB_CDN_PURGE_WAIT_MS): Promise<void> {
  const answer = await fetcher(WEB_CDN_PURGE_URL, { method: "POST", signal: AbortSignal.timeout(waitMs) });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
}

export function realTakedownPictureTools(discardCopies: (listId: string) => Promise<string[]>): TakedownPictureTools {
  return {
    ownFiles: async (listId) => {
      const [files] = await getStorage().bucket().getFiles({ prefix: `published/${listId}/` });
      return files.map((file) => file.name);
    },
    discardOwn: (listId) => discardPublished(listId),
    discardCopies,
    askPurge: async (purge) => {
      await getFirestore().collection(WEB_CDN_PURGES).add({ at: FieldValue.serverTimestamp(), ...purge });
    },
    // The emulator's takedowns never reach the real site.
    callPurge: () => (isDemoEmulator() ? Promise.resolve() : callWebCdnPurge()),
  };
}
