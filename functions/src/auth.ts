import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";
import { identityKeys, signInsOfToken } from "./banIdentities";

export interface Identity {
  uid: string;
  /** True while the caller has never attached a real account. */
  isAnonymous: boolean;
  name: string | null;
  /** The author's face, as they last set it. Only ever an https URL. */
  picture: string | null;
  /**
   * Only ever set when the provider says it verified it. An address the caller
   * merely claims is worth nothing here -- it is one of the two things that
   * make somebody the moderator.
   */
  email: string | null;
  /** Who the person is to their sign-in provider, hashed: what a ban outlives an erased account by. */
  banKeys: string[];
}

/**
 * One document per erased account, `{erasedAt}` and nothing else. Its ID
 * tokens stay good for up to an hour after the erasure, on another phone too,
 * and this is what refuses them.
 */
export const ERASED_ACCOUNTS = "erasedAccounts";

export async function markErased(uid: string): Promise<void> {
  await getFirestore().collection(ERASED_ACCOUNTS).doc(uid).set({ erasedAt: FieldValue.serverTimestamp() });
}

export async function isErased(uid: string): Promise<boolean> {
  return (await getFirestore().collection(ERASED_ACCOUNTS).doc(uid).get()).exists;
}

/** Reads find nothing of an erased account; anything else could bring some of it back. */
export function writes(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export interface UserChecks {
  verify: (token: string) => Promise<DecodedIdToken>;
  erased: (uid: string) => Promise<boolean>;
}

const LIVE_CHECKS: UserChecks = { verify: (token) => getAuth().verifyIdToken(token), erased: isErased };

/**
 * App Check answers "is this the released app"; this answers "which install".
 * The uid comes out of a token Firebase signed, never the body. A write by an
 * account erased since its token was issued is refused, except the erasure
 * itself, which has to stay safe to repeat.
 */
export async function requireUser(
  request: Request,
  response: Response,
  options: { evenIfErased?: boolean } = {},
  checks: UserChecks = LIVE_CHECKS,
): Promise<Identity | null> {
  const header = request.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (!token) {
    response.status(401).json({ error: "Missing ID token", code: "UNAUTHENTICATED" });
    return null;
  }

  let identity: Identity;
  try {
    identity = identityOf(await checks.verify(token));
  } catch {
    response.status(401).json({ error: "Invalid ID token", code: "UNAUTHENTICATED" });
    return null;
  }
  // Guests too: a guest that linked a provider keeps its uid, and its anonymous token stays good for an hour.
  if (options.evenIfErased === true || !writes(request.method)) {
    return identity;
  }
  try {
    if (await checks.erased(identity.uid)) {
      response.status(401).json({ error: "This account was deleted", code: "ACCOUNT_ERASED" });
      return null;
    }
  } catch (error) {
    console.error("Erased-account check failed", error);
    response.status(503).json({ error: "Unavailable", code: "UNAVAILABLE" });
    return null;
  }
  return identity;
}

function identityOf(decoded: DecodedIdToken): Identity {
  const provider = decoded.firebase?.sign_in_provider;
  const name = typeof decoded.name === "string" ? decoded.name : null;
  const picture =
    typeof decoded.picture === "string" && decoded.picture.startsWith("https://")
      ? decoded.picture
      : null;
  // Lower-cased because addresses are compared, not displayed, and the two
  // halves of an address disagree about case in theory but never in life.
  const email =
    decoded.email_verified === true && typeof decoded.email === "string"
      ? decoded.email.trim().toLowerCase()
      : null;
  const isAnonymous = provider === "anonymous";
  const banKeys = isAnonymous ? [] : identityKeys(email, signInsOfToken(decoded.firebase?.identities));
  return { uid: decoded.uid, isAnonymous, name, picture, email, banKeys };
}
