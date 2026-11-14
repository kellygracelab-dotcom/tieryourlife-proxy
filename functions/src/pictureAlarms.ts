/**
 * Alarms about pictures, written so that Cloud Logging files them as errors
 * and an alert policy can match them on one stable `message`:
 *
 * - `PICTURE_SOURCE_DENIED`: a catalogue answered 401 or 403. That is not a
 *   busy catalogue (429, 5xx), which rests and comes back; it is our key
 *   switched off or our access closed, and every search, refresh and copy
 *   that asks it fails quietly from then on. Each instance counts such
 *   answers per catalogue and writes at most one line a minute per catalogue,
 *   with the running count, so a closed key shows within the day, not by
 *   complaints, and a busy search page does not flood the log.
 * - `PICTURE_ALARM`: the daily upkeep kept a copy past its catalogue's time
 *   limit because neither its catalogue address nor the catalogue's id could
 *   give it a picture again (`pictureCopyUpkeep.ts`). Someone has to look.
 *
 * Each line is one JSON object on stderr. Cloud Functions (2nd gen) reads such
 * a line as a structured entry: `severity` becomes the entry's level and the
 * rest its `jsonPayload`, so `jsonPayload.message="PICTURE_SOURCE_DENIED"`
 * finds them. The repository defines no alert policy; one on these messages is
 * the owner's to create in Cloud Monitoring.
 */
export const PICTURE_ALARM = "PICTURE_ALARM";
export const PICTURE_SOURCE_DENIED = "PICTURE_SOURCE_DENIED";
/** One line per catalogue per instance at most this often; the count keeps running in between. */
export const DENIED_LOG_EVERY_MS = 60_000;

/**
 * The catalogues' own APIs, the hosts our keys and our requests go to. The
 * hosts they keep their pictures on are left out on purpose: there a 403 is
 * usually one picture's (Amazon S3, where iNaturalist keeps its photos,
 * answers 403 for a file that is gone), not the catalogue closing to us.
 * Twitch hands out IGDB's tokens, so its refusal is IGDB's.
 */
const API_HOSTS: Readonly<Record<string, string>> = {
  "api.themoviedb.org": "tmdb",
  "api.igdb.com": "igdb",
  "id.twitch.tv": "igdb",
  "graphql.anilist.co": "anilist",
  "store.steampowered.com": "steam",
  "api.steampowered.com": "steam",
  "openlibrary.org": "openlibrary",
  "api.inaturalist.org": "inaturalist",
  "commons.wikimedia.org": "wikimedia",
  "www.wikidata.org": "wikidata",
};

/**
 * The catalogue whose API an address is, for a refusal; null for any other
 * site (a picture a person pasted from somewhere is no key of ours), for a
 * catalogue's picture host, and for Deezer, which is no longer asked.
 */
export function deniedSourceOf(url: string | URL): string | null {
  let host: string;
  try {
    host = (typeof url === "string" ? new URL(url) : url).hostname;
  } catch {
    return null;
  }
  return Object.hasOwn(API_HOSTS, host) ? API_HOSTS[host]! : null;
}

/** What one instance has seen of one catalogue's refusals: how many, and when it last wrote a line. */
export interface DeniedTally {
  count: number;
  loggedAtMs: number | null;
}

/** One more refusal counted, and whether this one is written: the first, and then once a minute. */
export function tallyDenied(tally: DeniedTally | undefined, nowMs: number): { tally: DeniedTally; log: boolean } {
  const count = (tally?.count ?? 0) + 1;
  const last = tally?.loggedAtMs ?? null;
  const log = last === null || nowMs - last >= DENIED_LOG_EVERY_MS;
  return { tally: { count, loggedAtMs: log ? nowMs : last }, log };
}

/** The line written for a refusal: the catalogue, what it answered this time, and how many this instance has seen. */
export function deniedEntry(source: string, status: number, count: number): Record<string, unknown> {
  return { severity: "ERROR", message: PICTURE_SOURCE_DENIED, source, status, count };
}

const tallies = new Map<string, DeniedTally>();

/**
 * Counts a catalogue's 401 or 403 and writes the line when it is due. Any other
 * status, and any address that is not a catalogue's, is ignored, so every
 * request to a catalogue can hand its answer here. True when a line was written.
 */
export function noteDenied(url: string | URL, status: number, nowMs: number = Date.now()): boolean {
  if (status !== 401 && status !== 403) return false;
  const source = deniedSourceOf(url);
  if (source === null) return false;
  const { tally, log } = tallyDenied(tallies.get(source), nowMs);
  tallies.set(source, tally);
  if (log) console.error(JSON.stringify(deniedEntry(source, status, tally.count)));
  return log;
}

/** Forgets this instance's counts; for tests. */
export function forgetDenied(): void {
  tallies.clear();
}

/** A copy the upkeep kept past its time: its catalogue, its file, the lists, rankings and boards that show it, and why. */
export interface CopyAlarm {
  source: string;
  path: string;
  docs: string[];
  reason: string;
}

/** The line written for a copy kept past its time. */
export function copyAlarmEntry(alarm: CopyAlarm): Record<string, unknown> {
  return { severity: "ERROR", message: PICTURE_ALARM, ...alarm };
}

export function writeAlarm(alarm: CopyAlarm): void {
  console.error(JSON.stringify(copyAlarmEntry(alarm)));
}
