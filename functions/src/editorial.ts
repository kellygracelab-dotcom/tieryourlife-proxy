/**
 * Lists the house publishes: always anonymous, stored under an author id no
 * Auth account can hold, so they belong to nobody's account, outlive any of
 * them and never show who wrote them. Pure: `community.ts` does the I/O.
 */
import type { Identity } from "./auth";

/** Not a Firebase uid (those are 28 characters with no hyphen), so no sign-in can become it. */
export const EDITORIAL_UID = "tyl-editorial";

export type StaffRole = "owner" | "moderator";

/** Who a list is stored under: the person publishing, or the house. */
export interface Byline {
  uid: string;
  name: string;
  photoUrl: string | null;
  /** Set only for the house: the role of whoever speaks for it, for the audit log. */
  speaker: StaffRole | null;
}

export function bylineOf(identity: Identity): Byline {
  return { uid: identity.uid, name: identity.name ?? "Anonymous", photoUrl: identity.picture, speaker: null };
}

export function editorialByline(speaker: StaffRole): Byline {
  return { uid: EDITORIAL_UID, name: "", photoUrl: null, speaker };
}

/** The owner and the moderators speak for the house; anybody else is turned away. */
export function decideEditorialAccess(role: StaffRole | null): { ok: true; speaker: StaffRole } | { ok: false } {
  return role === null ? { ok: false } : { ok: true, speaker: role };
}
