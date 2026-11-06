/**
 * The e2e mode: the real code under the Firebase emulators of a `demo-`
 * project, which nothing can send anywhere real. Only there is App Check
 * skipped and every outbound call answered with the stubs below, so a test
 * needs no keys and no network. Anywhere else nothing here changes a thing.
 */
import type { SafeSearchVerdict } from "./safety";
import type { WordingVerdict } from "./wording";

/** The project ids the runtime says it serves; a check on one alone could be fooled by the other. */
function projectIdsOf(env: NodeJS.ProcessEnv): string[] {
  const ids = [env.GCLOUD_PROJECT];
  try {
    ids.push((JSON.parse(env.FIREBASE_CONFIG ?? "{}") as { projectId?: string }).projectId);
  } catch {
    ids.push("");
  }
  return ids.filter((id): id is string => id !== undefined);
}

export function isDemoEmulator(env: NodeJS.ProcessEnv = process.env): boolean {
  const ids = projectIdsOf(env);
  return env.FUNCTIONS_EMULATOR === "true" && ids.length > 0 && ids.every((id) => id.startsWith("demo-"));
}

/**
 * A function's secrets: declared everywhere but here, where the emulator
 * would go and ask Secret Manager for them, and where the stubs never read them.
 */
export function secretsOutsideDemo<T>(secrets: T[]): T[] {
  return isDemoEmulator() ? [] : secrets;
}

/** Vision finding nothing to object to. */
export const SAFE_VERDICT: SafeSearchVerdict = { adult: "VERY_UNLIKELY", racy: "VERY_UNLIKELY", violence: "VERY_UNLIKELY" };

/** The classifier finding nothing to queue. */
export const CALM_WORDS: WordingVerdict = { sexual: 0, derogatory: 0, profanity: 0 };

/** TMDB's answer to a search that found nothing. */
export const EMPTY_TMDB_SEARCH = { page: 1, results: [], total_pages: 0, total_results: 0 };

/** A one-pixel PNG: what a web picture kept for somebody turns out to be. */
export const STUB_PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
