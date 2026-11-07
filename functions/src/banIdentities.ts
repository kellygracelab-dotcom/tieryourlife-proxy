import { createHash } from "node:crypto";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { isBanned, type Ban } from "./bans";

/**
 * A ban that outlives the account it was given to. Erasing an account and
 * signing in again makes a new uid for the same person, so a ban in force
 * when the account is erased is kept by who the person is to their sign-in
 * provider, hashed, and read beside `bans/{uid}`.
 *
 *   bannedIdentities/{sha256 of key}   {until, bannedAt}
 */
export const BANNED_IDENTITIES = "bannedIdentities";
const BANS = "bans";

/** Sign-in methods whose id is not a person's: a guest, and an address the provider never checked. */
const NOT_A_PERSON = new Set(["anonymous", "password", "email", "custom"]);

export interface SignIn {
  providerId: string;
  uid: string;
}

export function hashedKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** `email:<address>` for a verified address, `<provider>:<id>` for each provider, hashed. */
export function identityKeys(verifiedEmail: string | null, signIns: readonly SignIn[]): string[] {
  const keys = new Set<string>();
  const email = verifiedEmail?.trim().toLowerCase() ?? "";
  if (email.length > 0) keys.add(`email:${email}`);
  for (const one of signIns) {
    if (!NOT_A_PERSON.has(one.providerId) && one.uid.length > 0) keys.add(`${one.providerId}:${one.uid}`);
  }
  return [...keys].map(hashedKey);
}

/** The sign-ins an ID token names in `firebase.identities`, `{"google.com": ["<sub>"]}`. */
export function signInsOfToken(identities: unknown): SignIn[] {
  if (typeof identities !== "object" || identities === null) return [];
  return Object.entries(identities as Record<string, unknown>).flatMap(([providerId, ids]) =>
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").map((uid) => ({ providerId, uid })) : [],
  );
}

/** What a hashed record keeps: when the ban began and when it lifts. */
export interface IdentityBan {
  until: number | null;
  bannedAt: number;
}

export function banOfRecord(data: unknown): Ban | null {
  const record = (data ?? {}) as Record<string, unknown>;
  const until = record.until === null ? null : typeof record.until === "number" ? record.until : undefined;
  if (until === undefined || typeof record.bannedAt !== "number") return null;
  return { until, bannedAt: record.bannedAt, reason: null };
}

/** The one that lifts last. */
export function longerBan(left: Ban, right: Ban): Ban {
  if (left.until === null) return left;
  if (right.until === null) return right;
  return left.until >= right.until ? left : right;
}

/** The ban in force that lifts last, or null when none is. */
export function liveBan(bans: readonly (Ban | null)[], nowMs: number): Ban | null {
  return bans.filter((ban): ban is Ban => isBanned(ban, nowMs)).reduce<Ban | null>((kept, ban) => (kept ? longerBan(kept, ban) : ban), null);
}

/** What a record holds once an account banned with [ending] is erased beside the [kept] one. */
export function recordToKeep(kept: Ban | null, ending: Ban): IdentityBan {
  const ban = kept === null ? ending : longerBan(kept, ending);
  return { until: ban.until, bannedAt: ban.bannedAt };
}

/** Whether this person may not publish now: their own `bans/{uid}`, or a ban kept from an account they erased. */
export async function readBan(identity: { uid: string; banKeys: readonly string[] }): Promise<Ban | null> {
  const db = getFirestore();
  const [own, ...kept] = await db.getAll(
    db.collection(BANS).doc(identity.uid),
    ...identity.banKeys.map((key) => db.collection(BANNED_IDENTITIES).doc(key)),
  );
  const bans = [own.exists ? (own.data() as Ban) : null, ...kept.map((doc) => (doc.exists ? banOfRecord(doc.data()) : null))];
  return liveBan(bans, Date.now());
}

/** Before the Auth user goes: a ban in force on [uid] is kept by the person's hashed sign-ins. */
export async function keepBanPastErasure(uid: string): Promise<void> {
  const db = getFirestore();
  const own = await db.collection(BANS).doc(uid).get();
  const ban = own.exists ? (own.data() as Ban) : null;
  if (!isBanned(ban, Date.now())) return;

  let user: UserRecord;
  try {
    user = await getAuth().getUser(uid);
  } catch (error) {
    // A repeated erasure whose first attempt got as far as deleting the user kept the ban then.
    if ((error as { code?: unknown } | null)?.code === "auth/user-not-found") return;
    throw error;
  }
  const keys = identityKeys(user.emailVerified ? user.email ?? null : null, user.providerData);
  for (const key of keys) {
    const ref = db.collection(BANNED_IDENTITIES).doc(key);
    await db.runTransaction(async (transaction) => {
      const there = await transaction.get(ref);
      transaction.set(ref, recordToKeep(there.exists ? banOfRecord(there.data()) : null, ban));
    });
  }
}
