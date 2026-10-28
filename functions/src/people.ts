/**
 * Finding a person to appoint. Names and addresses live in Firebase Auth and
 * nowhere else, and Auth can only be listed, not searched, so `community.ts`
 * keeps a small index of the accounts for a few minutes and this looks in it.
 */

export interface Person {
  uid: string;
  name: string;
  email: string;
  photoUrl: string | null;
}

/** As much of an Auth user as the index needs. */
export interface AuthUserLike {
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  disabled: boolean;
  providerData: readonly unknown[];
}

export const MAX_CANDIDATES = 10;

/** Fewer characters than this ask nothing: two letters already narrow a few thousand people to a handful. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Somebody who could be appointed: signed in with a real provider, so the
 * account survives the phone, and not switched off. A guest has no provider.
 */
export function personOf(user: AuthUserLike): Person | null {
  if (user.disabled || user.providerData.length === 0) return null;
  return {
    uid: user.uid,
    name: user.displayName ?? "",
    email: (user.email ?? "").toLowerCase(),
    photoUrl: user.photoURL?.startsWith("https://") ? user.photoURL : null,
  };
}

/**
 * The people whose name, any word of their name, or address starts with what
 * was typed, without caring about case. At most ten, names first in the order
 * the index holds them.
 */
export function matchPeople(index: readonly Person[], query: unknown, limit = MAX_CANDIDATES): Person[] {
  if (typeof query !== "string") return [];
  const wanted = query.trim().toLowerCase();
  if (wanted.length < MIN_QUERY_LENGTH) return [];
  const matches = (person: Person) => {
    const name = person.name.toLowerCase();
    return name.startsWith(wanted) || name.split(/\s+/).some((word) => word.startsWith(wanted)) || person.email.startsWith(wanted);
  };
  return index.filter(matches).slice(0, limit);
}
