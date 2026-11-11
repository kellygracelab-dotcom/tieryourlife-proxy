import { MAX_ITEMS_PER_LIST } from "./publishing";
import { readTakenFrom } from "./rankings";

export interface BoardOrigin { listId: string; version: number }
export type RankingChoice = "offered" | "private" | "ranking";
export interface OriginMetadata { takenFrom?: string; origin?: BoardOrigin; rankingChoice?: RankingChoice }

/** Private metadata is a backup, including after a source disappears; publication checks the real source. */
export function originAfterWrite(source: Record<string, unknown>, previous: OriginMetadata = {}): OriginMetadata | null {
  const origin = source.origin;
  if (origin !== undefined && origin !== null && (typeof origin !== "object" || Array.isArray(origin))) return null;
  const candidate = origin as Record<string, unknown> | null | undefined;
  if (candidate && (!readTakenFrom(candidate.listId) || !Number.isSafeInteger(candidate.version) || (candidate.version as number) < 0)) return null;
  const taken = source.takenFrom;
  if (taken !== undefined && taken !== null && readTakenFrom(taken) === null) return null;
  if (candidate && taken !== undefined && taken !== null && candidate.listId !== taken) return null;
  const choice = source.rankingChoice;
  if (choice !== undefined && choice !== null && (typeof choice !== "string" || !["offered", "private", "ranking"].includes(choice))) return null;
  // Null, like omission, cannot erase provenance or offer the same question again.
  const result: OriginMetadata = { ...previous };
  if (candidate) {
    result.origin = { listId: candidate.listId as string, version: candidate.version as number };
    result.takenFrom = candidate.listId as string;
  } else if (typeof taken === "string") {
    if (result.origin && result.origin.listId !== taken) return null;
    result.takenFrom = taken;
  }
  if (choice === "private" || choice === "ranking" || (choice === "offered" && result.rankingChoice === undefined)) result.rankingChoice = choice;
  return result;
}

/** Only metadata participates here; ordinary card ordering and IDs without a binding do not. */
export function originState(board: OriginMetadata & { items?: { uid: string; sourceIndex?: number }[] } | null): string {
  return JSON.stringify([board?.origin ?? null, board?.takenFrom ?? null, board?.rankingChoice ?? null,
    (board?.items ?? []).filter((item) => item.sourceIndex !== undefined).map((item) => [item.uid, item.sourceIndex] as const).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Omission preserves the positional binding by local uid; explicit null clears a replaced card's binding. */
export function sourceIndexAfterWrite(item: Record<string, unknown>, previous?: number): number | null | "invalid" {
  if (item.sourceIndex === null) return null;
  if (item.sourceIndex === undefined) return previous ?? null;
  return Number.isSafeInteger(item.sourceIndex) && (item.sourceIndex as number) >= 0 && (item.sourceIndex as number) < MAX_ITEMS_PER_LIST
    ? item.sourceIndex as number : "invalid";
}
