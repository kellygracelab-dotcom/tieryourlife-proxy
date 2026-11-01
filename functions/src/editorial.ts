/**
 * Lists the house publishes: always anonymous, stored under an author id no
 * Auth account can hold, so they belong to nobody's account, outlive any of
 * them and never show who wrote them. Pure: `community.ts` does the I/O.
 */
import type { Identity } from "./auth";

/** Not a Firebase uid (those are 28 characters with no hyphen), so no sign-in can become it. */
export const EDITORIAL_UID = "tyl-editorial";

/** Who a list is stored under: the person publishing, or the house. */
export interface Byline {
  uid: string;
  name: string;
  photoUrl: string | null;
  editorial: boolean;
}

export function bylineOf(identity: Identity): Byline {
  return { uid: identity.uid, name: identity.name ?? "Anonymous", photoUrl: identity.picture, editorial: false };
}

export const EDITORIAL_BYLINE: Byline = { uid: EDITORIAL_UID, name: "", photoUrl: null, editorial: true };

/** Only the owner speaks for the house; a moderator is told why, anybody else just no. */
export function decideEditorialAccess(role: "owner" | "moderator" | null): { ok: true } | { ok: false; detail?: "owner_only" } {
  if (role === "owner") return { ok: true };
  return role === null ? { ok: false } : { ok: false, detail: "owner_only" };
}
