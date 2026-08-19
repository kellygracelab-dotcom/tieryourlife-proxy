import { getAppCheck } from "firebase-admin/app-check";
import type { Request } from "firebase-functions/https";
import type { Response } from "express";

export async function requireAppCheck(
  request: Request,
  response: Response,
): Promise<boolean> {
  const token = request.header("X-Firebase-AppCheck");
  if (!token) {
    response.status(401).json({ error: "Missing App Check token" });
    return false;
  }
  try {
    await getAppCheck().verifyToken(token);
    return true;
  } catch {
    response.status(401).json({ error: "Invalid App Check token" });
    return false;
  }
}
