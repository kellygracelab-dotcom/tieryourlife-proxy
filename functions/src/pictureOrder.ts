/**
 * The order a picture search's hits are shown in, as one pure function the search and its tests share
 * (moved from `pictureSearch.ts`, 25.11.2026). What a list wants ranks first (`pictureIntent.ts`), then how
 * well a title or other name matches what was typed, then each catalogue's own order.
 *
 * 25.11.2026 (Coordinator, from Danylo: "борщ блюдо" with the All filter showed two artists on top):
 * - searched with the All filter on a board of a catalogue's section, the section ranks only when its own
 *   kind matched what was typed: borscht on a games board is no game, so nothing is put below games;
 * - of hits matching equally, people come after things, unless the board is of people, music or sport.
 */

import { entityKey, type Chosen } from "./pictureEntity";
import { wantRank, wantScore, type Want } from "./pictureIntent";
import { hitScore, OWN_KINDS, type PictureHit, type PictureScope } from "./pictureSources";

export interface OrderInput {
  typed: string;
  scope: PictureScope;
  want?: Want | null;
}

/**
 * What the board's section says about [hits] searched with [input]. With the All filter, a catalogue's
 * section speaks only when its own kind is among the hits by the name typed; otherwise nothing.
 */
export function sectionWant(input: OrderInput, hits: readonly PictureHit[]): Want | null {
  const want = input.want ?? null;
  if (input.scope !== "all" || want?.kind !== "scope") return want;
  const own = OWN_KINDS[want.scope] ?? [];
  return hits.some((hit) => own.includes(hit.kind) && hitScore(hit, input.typed) < 3) ? want : null;
}

/** What the hits are ranked for: the list's want, or, where it says nothing, what its chosen item implies. */
function rankingWant(want: Want | null, chosen: Chosen | null): Want | null {
  return want === null && chosen?.implied ? { kind: "type", type: chosen.implied } : want;
}

/**
 * How a search ranks hits for what its list wants. The [chosen] item's pictures come before all: its
 * catalogue's first, then its own from Commons (stage 2).
 */
export function rankFor(input: OrderInput, chosen: Chosen | null = null): (hit: PictureHit) => number {
  const want = rankingWant(input.want ?? null, chosen);
  const keys = new Set(chosen?.keys ?? []);
  // The item's own Wikidata picture comes first where it shows a kind, or where nothing else does ("all"):
  // an animals list keeps iNaturalist's "Octopus" above Wikidata's "Octopoda".
  const lifted = (hit: PictureHit) => hit.source !== "wikidata" || hit.kind !== "thing" || input.scope === "all";
  return (hit) => (keys.has(entityKey(hit)) && lifted(hit) ? (hit.source === "wikidata" ? -1 : -2) : wantRank(hit, input.scope, want));
}

/** Whether a person ranks after a thing that matches as well: everywhere but on a board of people, music or sport. */
function personLater(hit: PictureHit, want: Want | null): boolean {
  if (hit.kind !== "person" && hit.kind !== "artist") return false;
  if (want?.kind === "scope" && (want.scope === "people" || want.scope === "music")) return false;
  return !(want?.kind === "type" && want.type === "sport");
}

/** How a hit stands among those of its rank, lower first: its match, then a person after a thing. */
export function scoreFor(input: OrderInput, chosen: Chosen | null = null): (hit: PictureHit) => number {
  const want = rankingWant(input.want ?? null, chosen);
  return (hit) => wantScore(hit, want, hitScore(hit, input.typed)) * 2 + (personLater(hit, want) ? 1 : 0);
}
