import type { Identity } from "./auth";
import { isSectionId, RESERVED_SECTION_IDS } from "./sections";
import { isTopicId } from "./topics";

/**
 * Public reads a guest may make with App Check alone, without an ID token (28.11.2026).
 *
 * A new visitor's site waited for App Check and then an anonymous sign-in before its first
 * request here; the sign-in alone cost 0.4-0.7 s on a slow phone. It gated nothing App Check
 * did not: anybody who passes App Check is given an anonymous uid on asking, and no read below
 * is limited by uid. So these reads answer a request with App Check and no Authorization
 * header exactly as they answer a guest's token: nothing of anybody's own, nothing hidden.
 * A request that sends Authorization is checked as before, a bad token is still `401`, and
 * every other route, every write and everything personal still needs the token.
 */

/** The reader of a public read without a token. No Firebase uid has a "~", so no stored uid equals it. */
export const GUEST_READER_UID = "~app-check-guest";

export function guestReader(): Identity {
  return { uid: GUEST_READER_UID, isAnonymous: true, name: null, picture: null, email: null, banKeys: [] };
}

/** A published list's id: Firestore's own, twenty letters and digits, so no word of a route is one. */
const LIST_ID = /^[A-Za-z0-9]{20}$/;

/** The words under /lists/topics that are not a topic, and not public; sections keep theirs in `sections.ts`. */
const TOPIC_WORDS = new Set(["mine", "pending"]);

/**
 * Whether this request is one of the public reads above. `segments` are the path after
 * /lists; `query` is the request's. Anything not named here is not one.
 */
export function guestReadable(method: string, segments: readonly string[], query: Record<string, unknown>): boolean {
  if (method !== "GET") return false;
  const [first = "", second = ""] = segments;
  // The feed of the people, topics and sections one follows is the only feed that is somebody's own.
  if (segments.length === 0) return query.following !== "1";
  if (segments.length === 1) return first === "sections" || first === "topics" || LIST_ID.test(first);
  if (segments.length === 2 && first === "sections") return isSectionId(second) && !RESERVED_SECTION_IDS.includes(second);
  if (segments.length === 2 && first === "topics") return isTopicId(second) && !TOPIC_WORDS.has(second);
  return false;
}

/** No Authorization header at all: an empty or malformed one is still a token to refuse. */
export function sendsNoToken(header: string | undefined): boolean {
  return header === undefined;
}
