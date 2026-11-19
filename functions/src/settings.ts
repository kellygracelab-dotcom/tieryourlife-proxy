/**
 * What a person chose for how the app looks, kept with the account so the
 * phone and the website show the same (Danylo, 18.11.2026: colour themes,
 * artboards 58-59 of `qa-results/design-audit-2026-11-16/LIGHT-THEME-2026-11-18.md`).
 * One document, `accounts/{uid}/settings/appearance`, no client Firestore access.
 * Light or dark is not here: it stays with each device.
 *
 * The colour is a name and, for "custom", a hue. Each client builds the palette
 * itself from the hue with Material Color Utilities; `test/theme-vectors.json`
 * holds the colours both must get. Whoever changed it later on their device
 * wins; a write that lost is answered with what the account keeps.
 */
import { getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { ERASED_ACCOUNTS, type Identity } from "./auth";
import { changedAtOf, nextVersion } from "./started";
import { finishRemoval, readPhotoSlot, type PhotoSlot } from "./facePhoto";

export const SETTINGS_PATH = "settings";
export const SETTINGS_COLLECTION = "settings";
export const APPEARANCE_DOCUMENT = "appearance";

/** Lavender is today's look and the default; "phone" is Android 12+'s wallpaper colours. */
export const COLOUR_NAMES = ["lavender", "matcha", "peach", "sky", "phone", "custom"] as const;
export type ColourName = (typeof COLOUR_NAMES)[number];

/** The ready colours with fixed tables in test/theme-vectors.json; lavender keeps each client's own hand-made colours. */
export const PRESET_NAMES = ["matcha", "peach", "sky"] as const;

export interface ColourChoice {
  name: ColourName;
  /** The person's own hue, 0-359; kept while another colour is chosen, so the slider starts there. */
  hue: number | null;
}

export interface ColourSetting extends ColourChoice {
  /** When it was chosen, the device's clock in ms (one far ahead is taken as the server's). */
  changedAt: number;
  /** The server's version, growing with every write. */
  updatedAt: number;
}

export interface AppearanceDocument {
  colour?: ColourSetting;
  /** The uploaded face photo's slot (`facePhoto.ts`); null once removed. */
  photo?: PhotoSlot | null;
}

export type ColourBody = { ok: true; choice: ColourChoice; changedAt: number } | { ok: false; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readColourBody(body: unknown, nowMs: number): ColourBody {
  if (!isRecord(body)) return { ok: false, detail: "body" };
  const name = body.name;
  if (typeof name !== "string" || !(COLOUR_NAMES as readonly string[]).includes(name)) return { ok: false, detail: "name" };
  const hue = body.hue ?? null;
  if (hue !== null && !(typeof hue === "number" && Number.isInteger(hue) && hue >= 0 && hue <= 359)) return { ok: false, detail: "hue" };
  if (name === "custom" && hue === null) return { ok: false, detail: "hue" };
  const changedAt = changedAtOf(body.changedAt, nowMs);
  if (changedAt === null) return { ok: false, detail: "changedAt" };
  return { ok: true, choice: { name: name as ColourName, hue }, changedAt };
}

/** A later change lands; an equal one too, so a device repeating its write gets the same answer. */
export const colourLands = (stored: ColourSetting | null | undefined, changedAt: number): boolean =>
  !stored || changedAt >= stored.changedAt;

export function settingsWire(stored: AppearanceDocument | null): { colour: ColourSetting | null; photo: PhotoSlot | null } {
  const colour = stored?.colour;
  return {
    colour: colour ? { name: colour.name, hue: colour.hue ?? null, changedAt: colour.changedAt, updatedAt: colour.updatedAt } : null,
    photo: readPhotoSlot(stored?.photo ?? null),
  };
}

const appearanceOf = (uid: string) =>
  getFirestore().collection("accounts").doc(uid).collection(SETTINGS_COLLECTION).doc(APPEARANCE_DOCUMENT);

export async function settingsRoute(
  request: { method: string; body: unknown },
  response: Response,
  identity: Identity,
  segments: readonly string[],
): Promise<void> {
  if (identity.isAnonymous) {
    return void response.status(403).json({ error: "Sign in to keep settings with your account", code: "NOT_SIGNED_IN" });
  }
  if (segments.length === 1) {
    if (request.method !== "GET") return void response.status(405).json({ error: "Use GET" });
    const doc = await appearanceOf(identity.uid).get();
    // A removed photo past Undo's window goes as it is read; the daily sweep takes the rest.
    if (doc.exists) await finishRemoval(identity.uid, doc.get("removedPhoto")).catch((error) => console.warn("Removed photo not finished", error));
    response.setHeader("Cache-Control", "no-store");
    return void response.status(200).json(settingsWire(doc.exists ? (doc.data() as AppearanceDocument) : null));
  }
  if (segments.length !== 2 || segments[1] !== "colour") return void response.status(404).json({ error: "No such setting", code: "NOT_FOUND" });
  if (request.method !== "PUT") return void response.status(405).json({ error: "Use PUT" });
  await writeColour(response, identity, request.body);
}

async function writeColour(response: Response, identity: Identity, body: unknown): Promise<void> {
  const now = Date.now();
  const read = readColourBody(body, now);
  if (!read.ok) return void response.status(400).json({ error: "That is not a colour", code: "INVALID", detail: read.detail });
  const db = getFirestore();
  const ref = appearanceOf(identity.uid);
  const answer = await db.runTransaction(async (transaction): Promise<{ status: number; body: object }> => {
    if ((await transaction.get(db.collection(ERASED_ACCOUNTS).doc(identity.uid))).exists) {
      return { status: 401, body: { error: "This account was deleted", code: "ACCOUNT_ERASED" } };
    }
    const existing = await transaction.get(ref);
    const stored = existing.exists ? ((existing.data() as AppearanceDocument).colour ?? null) : null;
    if (!colourLands(stored, read.changedAt)) return { status: 200, body: { ...settingsWire({ colour: stored! }).colour!, landed: false } };
    const colour: ColourSetting = { ...read.choice, changedAt: read.changedAt, updatedAt: nextVersion(stored?.updatedAt ?? null, now) };
    transaction.set(ref, { colour }, { merge: true });
    return { status: 200, body: { ...colour, landed: true } };
  });
  response.status(answer.status).json(answer.body);
}
