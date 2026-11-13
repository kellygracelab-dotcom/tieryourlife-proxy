import { FieldValue } from "firebase-admin/firestore";

/**
 * A published list's revision: a whole number that moves with every write to
 * what the list shows, whoever makes it (the author, the house, staff moving
 * it, the picture refresh, a maintenance script). `updatedAt` is not it: it
 * orders "recently updated" and stands for the version a ranking was made
 * against, so writes the author did not make leave it alone. A list stored
 * before revisions existed is at 0.
 */
export function revisionOf(data: { revision?: unknown } | null | undefined): number {
  const value = data?.revision;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The field a write outside a transaction adds to move the revision on. */
export function nextRevision(): { revision: FieldValue } {
  return { revision: FieldValue.increment(1) };
}

/**
 * `baseRevision` in a body that replaces a list: the revision the client's
 * copy was read at. Absent or null: the client does not say (older clients),
 * and the write is not checked. Anything but a whole number from 0 is "invalid".
 */
export function readBaseRevision(body: unknown): number | null | "invalid" {
  if (body === null || typeof body !== "object" || !("baseRevision" in body)) return null;
  const value = (body as { baseRevision?: unknown }).baseRevision;
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "invalid";
}

/** Whether a replacement read at [base] would write over a newer revision. */
export function staleBase(base: number | null, stored: { revision?: unknown } | null | undefined): boolean {
  return base !== null && base !== revisionOf(stored);
}
