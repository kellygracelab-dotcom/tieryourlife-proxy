import { getAuth } from "firebase-admin/auth";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";

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
}

/**
 * App Check answers "is this the released app"; this answers "which install".
 * The uid comes out of a token Firebase signed, never the body.
 */
export async function requireUser(request: Request, response: Response): Promise<Identity | null> {
  const header = request.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (!token) {
    response.status(401).json({ error: "Missing ID token", code: "UNAUTHENTICATED" });
    return null;
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
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
    return { uid: decoded.uid, isAnonymous: provider === "anonymous", name, picture, email };
  } catch {
    response.status(401).json({ error: "Invalid ID token", code: "UNAUTHENTICATED" });
    return null;
  }
}
