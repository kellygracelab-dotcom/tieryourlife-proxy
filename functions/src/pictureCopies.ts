/**
 * Which catalogues' pictures we keep copies of, one switch each, in
 * `config/pictureCopies` `{sources: {<source>: boolean}}`. A copy is the
 * catalogue's picture kept in our bucket next to the list (or the ranking)
 * that shows it, and the card remembers the catalogue address in
 * `attribution.originalUrl`. Commons files and iNaturalist photos are copied
 * only when their licence lets us; the others, when their switch is on.
 * Switching a source off stops new copies; copies already made stay.
 */
import { getFirestore } from "firebase-admin/firestore";
import { isDemoEmulator } from "./emulator";
import { catalogueSourceOf, mayCopy, type PictureAttribution } from "./pictureAttribution";

export const PICTURE_COPIES = "config/pictureCopies";

export const COPY_SOURCES = ["wikimedia", "inaturalist", "tmdb", "anilist", "igdb", "steam", "openlibrary"] as const;
export type CopySource = (typeof COPY_SOURCES)[number];
export type CopySwitches = Readonly<Record<CopySource, boolean>>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Catalogues whose terms limit how long a copy is kept: fetched again after
 * `refreshAfterMs`, and undone (the card shows the catalogue's address again)
 * when it could not be fetched again by `dropAfterMs`. TMDB keeps a cache six
 * months at most.
 */
export const COPY_LIMITS: Readonly<Record<string, { refreshAfterMs: number; dropAfterMs: number }>> = {
  tmdb: { refreshAfterMs: 90 * DAY_MS, dropAfterMs: 150 * DAY_MS },
};

/** Without a switch written: the openly licensed only, as since 13.11.2026. */
export const DEFAULT_COPY_SWITCHES: CopySwitches = {
  wikimedia: true,
  inaturalist: true,
  tmdb: false,
  anilist: false,
  igdb: false,
  steam: false,
  openlibrary: false,
};

/** The switches a stored document says, each one it does not say at its default. */
export function readCopySwitches(data: unknown): CopySwitches {
  const sources = (data as { sources?: unknown } | null | undefined)?.sources;
  const switches: Record<CopySource, boolean> = { ...DEFAULT_COPY_SWITCHES };
  if (sources !== null && typeof sources === "object") {
    for (const source of COPY_SOURCES) {
      const value = (sources as Record<string, unknown>)[source];
      if (typeof value === "boolean") switches[source] = value;
    }
  }
  return switches;
}

const READ_MS = 60_000;
let cached: { readAtMs: number; switches: CopySwitches } | null = null;

/** The switches as stored, read at most once a minute per instance (every time under the demo emulator). */
export async function copySwitches(): Promise<CopySwitches> {
  const now = Date.now();
  if (cached !== null && now - cached.readAtMs < READ_MS && !isDemoEmulator()) return cached.switches;
  const doc = await getFirestore().doc(PICTURE_COPIES).get().catch(() => null);
  // A failed read keeps what was read before, else the defaults.
  const switches = doc === null ? cached?.switches ?? DEFAULT_COPY_SWITCHES : readCopySwitches(doc.data());
  cached = { readAtMs: now, switches };
  return switches;
}

/** Forgets the switches read; for tests. */
export function forgetCopySwitches(): void {
  cached = null;
}

/** Whether a catalogue picture at [url] is to be kept as our copy. */
export function wantsCopy(url: string | null, attribution: PictureAttribution | null, switches: CopySwitches): boolean {
  if (url === null) return false;
  const source = catalogueSourceOf(url);
  if (source === null || !(COPY_SOURCES as readonly string[]).includes(source) || !switches[source as CopySource]) return false;
  return source === "wikimedia" || source === "inaturalist" ? mayCopy(url, attribution) : true;
}
