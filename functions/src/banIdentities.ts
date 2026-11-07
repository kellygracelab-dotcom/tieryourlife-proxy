import { createHash } from "node:crypto";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { auditEntry } from "./audit";
import { isBanned, type Ban } from "./bans";

/**
 * A ban that outlives the account it was given to. Erasing an account and
 * signing in again makes a new uid for the same person, so a ban in force
 * when the account is erased is kept by who the person is to their sign-in
 * provider, hashed, and read beside `bans/{uid}`.
 *
 *   bannedIdentities/{sha256 of key}   {until, bannedAt}
 *   bans/{erased uid}.identityKeys      the keys it left, so it can be lifted
 */
export const BANNED_IDENTITIES = "bannedIdentities";
const BANS = "bans";
const AUDIT_LOG = "auditLog";
/** Firestore's own ceiling for one batch. */
const SWEEP_PAGE = 500;

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

/** A record whose ban has run out: nothing reads it as a ban any more, so it can go. */
export function expiredRecord(data: unknown, nowMs: number): boolean {
  const ban = banOfRecord(data);
  return ban !== null && !isBanned(ban, nowMs);
}

/** Whether this person may not publish now: their own `bans/{uid}`, or a ban kept from an account they erased. */
export async function readBan(identity: { uid: string; banKeys: readonly string[] }): Promise<Ban | null> {
  const db = getFirestore();
  const nowMs = Date.now();
  const [own, ...kept] = await db.getAll(
    db.collection(BANS).doc(identity.uid),
    ...identity.banKeys.map((key) => db.collection(BANNED_IDENTITIES).doc(key)),
  );
  // A record that ran out goes now, unless it was written again since it was read.
  await Promise.all(
    kept
      .filter((doc) => doc.exists && expiredRecord(doc.data(), nowMs))
      .map((doc) => doc.ref.delete({ lastUpdateTime: doc.updateTime }).catch(() => undefined)),
  );
  const bans = [own.exists ? (own.data() as Ban) : null, ...kept.map((doc) => (doc.exists ? banOfRecord(doc.data()) : null))];
  return liveBan(bans, nowMs);
}

/** The keys of the Auth user [uid] is now, or null when there is none. */
async function keysOfUser(uid: string): Promise<string[] | null> {
  let user: UserRecord;
  try {
    user = await getAuth().getUser(uid);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "auth/user-not-found") return null;
    throw error;
  }
  return identityKeys(user.emailVerified ? user.email ?? null : null, user.providerData);
}

function keysListedOn(data: unknown): string[] {
  const listed = ((data ?? {}) as Record<string, unknown>).identityKeys;
  return Array.isArray(listed) ? listed.filter((key): key is string => typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) : [];
}

/**
 * Before the Auth user goes: a ban in force on [uid] is kept by the person's
 * hashed sign-ins, and `bans/{uid}` lists those keys so the ban can still be
 * lifted by the old uid.
 */
export async function keepBanPastErasure(uid: string): Promise<void> {
  const db = getFirestore();
  const ownRef = db.collection(BANS).doc(uid);
  const own = await ownRef.get();
  const ban = own.exists ? (own.data() as Ban) : null;
  if (!isBanned(ban, Date.now())) return;

  // A repeated erasure whose first attempt got as far as deleting the user kept the ban then.
  const keys = await keysOfUser(uid);
  if (keys === null) return;
  for (const key of keys) {
    const ref = db.collection(BANNED_IDENTITIES).doc(key);
    await db.runTransaction(async (transaction) => {
      const there = await transaction.get(ref);
      transaction.set(ref, recordToKeep(there.exists ? banOfRecord(there.data()) : null, ban));
    });
  }
  const batch = db.batch();
  batch.update(ownRef, { identityKeys: keys });
  batch.set(db.collection(AUDIT_LOG).doc(), {
    ...auditEntry(uid, "account", "ban.kept_past_erasure", `${BANS}/${uid}`, null, { until: ban.until, keys: keys.length }),
    at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

/**
 * A ban set on [uid] now speaks for the person too: a record kept from an
 * account they erased before takes this ban's length, shorter or longer, so
 * the newest decision is the one in force.
 */
export async function replaceKeptBans(uid: string, ban: Ban): Promise<void> {
  const keys = await keysOfUser(uid);
  if (keys === null || keys.length === 0) return;
  const db = getFirestore();
  const refs = keys.map((key) => db.collection(BANNED_IDENTITIES).doc(key));
  const there = await db.getAll(...refs);
  const batch = db.batch();
  there.filter((doc) => doc.exists).forEach((doc) => batch.set(doc.ref, recordToKeep(null, ban)));
  await batch.commit();
}

/**
 * Lifts the ban on [uid], an erased account's or a live one's: `bans/{uid}`,
 * every record its keys name, and the records of the person signed in as
 * [uid] now, so lifting by the old uid or the new one both work. Says what
 * was there, for the log.
 */
export async function liftBan(uid: string): Promise<{ ban: Ban | null; keptRecords: number }> {
  const db = getFirestore();
  const ownRef = db.collection(BANS).doc(uid);
  const own = await ownRef.get();
  const keys = new Set([...keysListedOn(own.data()), ...((await keysOfUser(uid)) ?? [])]);
  const records = keys.size === 0 ? [] : await db.getAll(...[...keys].map((key) => db.collection(BANNED_IDENTITIES).doc(key)));
  const batch = db.batch();
  batch.delete(ownRef);
  records.filter((doc) => doc.exists).forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  const ban = own.exists ? (own.data() as Ban) : null;
  return {
    ban: ban === null ? null : { until: ban.until, bannedAt: ban.bannedAt, reason: ban.reason ?? null },
    keptRecords: records.filter((doc) => doc.exists).length,
  };
}

/** [liftBan] on the owner's word, logged as `ban.lift` when there was anything to lift. Whether there was. */
export async function liftBanLogged(who: string, role: string, uid: string): Promise<boolean> {
  const { ban, keptRecords } = await liftBan(uid);
  if (ban === null && keptRecords === 0) return false;
  await getFirestore().collection(AUDIT_LOG).doc().set({
    ...auditEntry(who, role, "ban.lift", `${BANS}/${uid}`, { ...(ban ?? {}), keptRecords }, null),
    at: FieldValue.serverTimestamp(),
  });
  return true;
}

/** Records whose ban has run out, a page at a time; a ban for ever has no `until` to run out by. */
export async function sweepExpiredBans(nowMs: number): Promise<number> {
  const db = getFirestore();
  let removed = 0;
  for (;;) {
    const page = await db.collection(BANNED_IDENTITIES).where("until", "<=", nowMs).limit(SWEEP_PAGE).get();
    if (page.empty) return removed;
    const batch = db.batch();
    page.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    removed += page.size;
    if (page.size < SWEEP_PAGE) return removed;
  }
}
