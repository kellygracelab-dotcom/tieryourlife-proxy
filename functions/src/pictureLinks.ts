/**
 * A card's picture by its address (`POST /lists/pictures/link`), for anybody
 * signed in. A catalogue's own address is answered as it is, with its
 * attribution, and nothing is fetched: the catalogue keeps its pictures. Any
 * other picture is fetched once, looked at by Vision, and kept in the person's
 * own folder like `/keep`, with the page it was found on as the card's
 * `attribution.link`. Publishing looks at it again and copies it.
 *
 * Each fetch counts against the person's day and hour (`chargeLink`); the same
 * address again on the same day answers what it did before, for nothing.
 */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Identity } from "./auth";
import { askCommons } from "./cataloguePictures";
import { isDemoEmulator, STUB_PICTURE } from "./emulator";
import {
  attributionOf,
  catalogueSourceOf,
  cleanAttribution,
  commonsFileOf,
  outsideName,
  pageLink,
  type AttributionSource,
  type PictureAttribution,
} from "./pictureAttribution";
import { MAX_CREDIT_LENGTH } from "./pictureCredit";
import { downloadPicture } from "./pictureSearch";
import { chargeLink, linkQuota, retryAfterSeconds, unchargeLink, type SearchCount } from "./pictureSearchLimit";
import { safeSearchOrNothing } from "./publishedPictures";
import { dayKey } from "./quota";
import { decideSafe } from "./safety";

const MAX_URL_LENGTH = 2000;

export type LinkRequest =
  | { error: "NO_URL" | "BAD_URL" | "NOT_ALLOWED" | "BAD_LINK" }
  | { url: string; catalogue: AttributionSource | null; link: string | null; credit: string | null };

/** What a request asks for, before anything is fetched or counted. */
export function readLinkRequest(body: unknown): LinkRequest {
  const value = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (typeof value.url !== "string" || value.url.trim() === "") return { error: "NO_URL" };
  const raw = value.url.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: "BAD_URL" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "BAD_URL" };
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return { error: "NOT_ALLOWED" };
  const given = value.link === undefined || value.link === null || (typeof value.link === "string" && value.link.trim() === "") ? null : value.link;
  const link = given === null ? null : pageLink(given);
  if (given !== null && link === null) return { error: "BAD_LINK" };
  const credit = typeof value.credit === "string" ? value.credit.replace(/\s+/g, " ").trim().slice(0, MAX_CREDIT_LENGTH) : "";
  return { url: url.href, catalogue: catalogueSourceOf(url.href), link, credit: credit || null };
}

/** A catalogue's own address, answered as it is: the page it names, or the one sent when it is that catalogue's. */
export function catalogueAnswer(url: string, link: string | null, credit: string | null, commons?: Parameters<typeof attributionOf>[1]["commons"]): PictureAttribution | null {
  const found = attributionOf(url, { credit: credit ?? undefined, sentLink: link, commons });
  return found === null ? null : cleanAttribution(found);
}

function refuse(response: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  response.setHeader("Cache-Control", "no-store");
  response.status(status).json({ error: "That picture could not be kept", code, ...extra });
}

/** `GET /lists/pictures/link`: what the caller has left today, before anything is sent. */
export async function routeLinkQuota(response: Response, identity: Identity): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return;
  }
  const now = Date.now();
  const count = (await getFirestore().doc(usagePath(identity.uid, now)).get()).get("count") as number | undefined;
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ quota: linkQuota(count, now) });
}

function usagePath(uid: string, nowMs: number): string {
  return `pictureWeb/${dayKey(nowMs)}/links/${uid}`;
}

export async function routeLinkPicture(body: unknown, response: Response, identity: Identity): Promise<void> {
  if (identity.isAnonymous) {
    response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    return;
  }
  const asked = readLinkRequest(body);
  if ("error" in asked) {
    refuse(response, asked.error === "NO_URL" ? 400 : 422, asked.error);
    return;
  }
  const credit = asked.credit ? { credit: asked.credit } : {};
  response.setHeader("Cache-Control", "no-store");
  const uid = identity.uid;
  const db = getFirestore();
  const usage = db.doc(usagePath(uid, Date.now()));
  // How many of today's fetches are used, as last read or written: every answer from here says what is left.
  let used: number | undefined;
  const quota = () => ({ quota: linkQuota(used, Date.now()) });

  if (asked.catalogue !== null) {
    const file = commonsFileOf(asked.url);
    const [commons, today] = await Promise.all([
      file !== null && !isDemoEmulator() ? askCommons([file]) : Promise.resolve(undefined),
      usage.get().catch(() => null),
    ]);
    used = today?.get("count") as number | undefined;
    const attribution = catalogueAnswer(asked.url, asked.link, asked.credit, commons) ?? { source: asked.catalogue };
    response.status(200).json({ imageUrl: asked.url, attribution, ...credit, ...quota() });
    return;
  }

  const attribution: PictureAttribution = asked.link ? { source: "web", link: asked.link } : { source: "web" };
  const key = outsideName(asked.url);
  // The hour the fetch was charged in, to give it back to.
  let chargedHour = 0;
  // What this address got today, or a charge for fetching it.
  const count = (again: boolean) => db.runTransaction(async (transaction): Promise<{ before: string } | { retryAtMs: number } | null> => {
    const data = (await transaction.get(usage)).data() as (Partial<SearchCount> & { seen?: Record<string, unknown> }) | undefined;
    used = data?.count;
    const before = data?.seen?.[key];
    if (!again && typeof before === "string") return { before };
    const charge = chargeLink(data, Date.now());
    if (!charge.allowed) return { retryAtMs: charge.retryAtMs };
    transaction.set(usage, charge.next, { merge: true });
    used = charge.next.count;
    chargedHour = charge.next.hour;
    return null;
  });
  const bucket = getStorage().bucket();
  let counted = await count(false);
  if (counted !== null && "before" in counted) {
    if (counted.before.startsWith("!")) {
      refuse(response, 422, "PICTURE_REFUSED", { because: counted.before.slice(1), ...quota() });
      return;
    }
    const [there] = await bucket.file(`users/${uid}/pictures/${counted.before}`).exists().catch((): [boolean] => [false]);
    if (there) {
      response.status(200).json({ pictureId: counted.before, attribution, ...credit, ...quota() });
      return;
    }
    // Deleted since: fetched, and counted, again.
    counted = await count(true);
  }
  if (counted !== null && "retryAtMs" in counted) {
    response.setHeader("Retry-After", String(retryAfterSeconds(counted.retryAtMs, Date.now())));
    refuse(response, 429, "LINK_LIMIT", { retryAt: counted.retryAtMs, ...quota() });
    return;
  }
  const remember = (value: string) => usage.set({ seen: { [key]: value } }, { merge: true }).catch(() => undefined);

  const fetched = isDemoEmulator() ? { bytes: STUB_PICTURE, type: "image/png" } : await downloadPicture(new URL(asked.url));
  if ("error" in fetched && fetched.error === "SOURCE_BUSY") {
    // Only busy for now (429, 5xx): the fetch is given back and nothing is remembered, so the same address may come again.
    await db.runTransaction(async (transaction) => {
      const next = unchargeLink((await transaction.get(usage)).data() as Partial<SearchCount> | undefined, chargedHour);
      if (next === null) return;
      transaction.set(usage, next, { merge: true });
      used = next.count;
    }).catch(() => undefined);
    const retryAt = fetched.retryAtMs ?? Date.now() + 60_000;
    response.setHeader("Retry-After", String(retryAfterSeconds(retryAt, Date.now())));
    refuse(response, 503, "SOURCE_BUSY", { retryAt, ...quota() });
    return;
  }
  if ("error" in fetched) {
    refuse(response, 422, fetched.error, quota());
    return;
  }
  // Vision out of reach: kept all the same, and publishing looks again.
  const verdict = isDemoEmulator() ? null : (await safeSearchOrNothing([fetched.bytes]).catch(() => [null]))[0] ?? null;
  const decision = verdict === null ? { ok: true as const } : decideSafe(verdict);
  if (!decision.ok) {
    await remember(`!${decision.because}`);
    refuse(response, 422, "PICTURE_REFUSED", { because: decision.because, ...quota() });
    return;
  }
  const pictureId = randomUUID();
  await bucket.file(`users/${uid}/pictures/${pictureId}`).save(fetched.bytes, { contentType: fetched.type, resumable: false });
  await remember(pictureId);
  response.status(200).json({ pictureId, attribution, ...credit, ...quota() });
}
