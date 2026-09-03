import { getAppCheck } from "firebase-admin/app-check";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";

/**
 * Sent with both refusals so the app can tell them from the other 401 it can
 * get, which is about the person's sign-in and is fixed by signing in again.
 * This one is about the installation, and signing in does nothing for it.
 */
export const APP_UNVERIFIED = "APP_UNVERIFIED";

export async function requireAppCheck(
  request: Request,
  response: Response,
): Promise<boolean> {
  const token = request.header("X-Firebase-AppCheck");
  if (!token) {
    response.status(401).json({ error: "Missing App Check token", code: APP_UNVERIFIED });
    return false;
  }
  try {
    await getAppCheck().verifyToken(token);
    return true;
  } catch {
    response.status(401).json({ error: "Invalid App Check token", code: APP_UNVERIFIED });
    return false;
  }
}
