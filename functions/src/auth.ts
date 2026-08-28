import { getAuth } from "firebase-admin/auth";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";

export interface Identity {
  uid: string;
  /** True while the caller has never attached a real account. */
  isAnonymous: boolean;
  name: string | null;
}

/**
 * Who is calling. App Check answers "is this the released app"; this answers
 * "which install", which is what the ledger counts against.
 *
 * The uid is never taken from the request body — a caller who could name itself
 * could name someone else. It comes out of a token Firebase signed.
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
    return { uid: decoded.uid, isAnonymous: provider === "anonymous", name };
  } catch {
    response.status(401).json({ error: "Invalid ID token", code: "UNAUTHENTICATED" });
    return null;
  }
}
