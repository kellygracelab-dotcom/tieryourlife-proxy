/**
 * How many pictures this account may still upload today (since 19.11.2026). `checkUpload` removes every
 * upload past the day's limit after it lands, without telling anybody, and the card loses its picture; a
 * client asks here first, once for a whole selection, so a guest can be asked to sign in instead.
 */
import type { Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import type { Identity } from "./auth";
import { GUEST_UPLOADS_PER_DAY, UPLOADS_PER_DAY } from "./pictureBytes";
import { nextDayMs } from "./dailyCount";
import { dayKey } from "./quota";

/** Where `checkUpload` counts a day's uploads of one account. */
export function uploadUsagePath(uid: string, nowMs: number): string {
  return `pictureUploads/${dayKey(nowMs)}/uploads/${uid}`;
}

/** A guest is offered to sign in this many uploads before the limit. */
export const GUEST_WARNING_BEFORE = 20;

export interface UploadQuota {
  used: number;
  left: number;
  limit: number;
  guest: boolean;
  /** A guest at `warnAt` or more is offered to sign in, softly; null for an account. */
  warnAt: number | null;
  resetsAt: number;
}

export function uploadQuota(count: unknown, guest: boolean, nowMs: number): UploadQuota {
  const used = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const limit = guest ? GUEST_UPLOADS_PER_DAY : UPLOADS_PER_DAY;
  return { used, left: Math.max(0, limit - used), limit, guest, warnAt: guest ? limit - GUEST_WARNING_BEFORE : null, resetsAt: nextDayMs(nowMs) };
}

/** The `count` a client is about to upload, 1-100; null when none was sent. */
function countOf(raw: unknown): number | null | "bad" {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return "bad";
  const count = Number(value);
  return count >= 1 && count <= 100 ? count : "bad";
}

/**
 * `GET /lists/pictures/uploads[?count=n]`: `200 {uploads}`; with `count`, `429` when that many no longer
 * fit: `SIGN_IN_FOR_MORE_UPLOADS` for a guest, `UPLOAD_DAILY_LIMIT` for an account, with `retryAt`.
 */
export async function routeUploadQuota(query: Record<string, unknown>, response: Response, identity: Identity): Promise<void> {
  const count = countOf(query.count);
  response.setHeader("Cache-Control", "no-store");
  if (count === "bad") {
    response.status(400).json({ error: "Ask for 1 to 100 pictures", code: "INVALID" });
    return;
  }
  const now = Date.now();
  const stored = (await getFirestore().doc(uploadUsagePath(identity.uid, now)).get()).get("count");
  const uploads = uploadQuota(stored, identity.isAnonymous === true, now);
  if (count !== null && count > uploads.left) {
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil((uploads.resetsAt - now) / 1000))));
    response.status(429).json(
      uploads.guest
        ? { error: "Sign in to add more pictures", code: "SIGN_IN_FOR_MORE_UPLOADS", retryAt: uploads.resetsAt, uploads }
        : { error: "No more pictures today; try again tomorrow", code: "UPLOAD_DAILY_LIMIT", retryAt: uploads.resetsAt, uploads },
    );
    return;
  }
  response.status(200).json({ uploads });
}
