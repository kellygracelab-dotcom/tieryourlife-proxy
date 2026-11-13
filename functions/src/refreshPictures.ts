/**
 * Once a day: the catalogue pictures of published lists and ranking snapshots
 * asked again where a catalogue's terms want it (IGDB daily, TMDB every 90
 * days), every other address looked at weekly, and a card whose address died
 * moved to the catalogue's new one, found by its id. The decisions are in
 * `catalogueRefresh.ts`; what each run did is in `pictureChecks`.
 *
 * Each catalogue that refuses (429, 5xx) is left alone for the rest of the run
 * and rests as it does for searches. Private boards are not touched yet.
 */
import { createHash } from "node:crypto";
import { getFirestore, type DocumentReference } from "firebase-admin/firestore";
import { nextRevision } from "./listRevision";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  anilistPictures,
  anilistQuery,
  checkKey,
  IDS_PER_ASK,
  igdbCovers,
  movedFields,
  openLibraryCover,
  PICTURE_CHECKS,
  picturesIn,
  planRun,
  probeVerdict,
  steamPictures,
  tmdbPictureOf,
  type CataloguePicture,
  type PictureCheck,
} from "./catalogueRefresh";
import { isDemoEmulator, secretsOutsideDemo } from "./emulator";
import type { AttributionSource } from "./pictureAttribution";
import {
  CatalogueRefusal,
  getJson,
  igdbAccess,
  igdbClientId,
  igdbClientSecret,
  pictureTmdbToken,
  rest,
  restingUntil,
} from "./pictureSearch";
import { USER_AGENT, type PictureSource } from "./pictureSources";

const LISTS = "publishedLists";
const RANKINGS = "rankings";
const PROBE_TIMEOUT_MS = 10_000;
const AT_ONCE = 4;
/** Probes of one host that may fail without an answer before that host is left for the next run. */
const UNSURE_PER_HOST = 3;

export const refreshPictures = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Etc/UTC",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: secretsOutsideDemo([pictureTmdbToken, igdbClientId, igdbClientSecret]),
  },
  async () => {
    if (isDemoEmulator()) return;
    const summary = await refreshCataloguePictures(Date.now());
    console.log(`Picture refresh: ${JSON.stringify(summary)}`);
  },
);

const keyOf = (url: string) => checkKey(url, (text) => createHash("sha256").update(text).digest("hex"));

async function inBatches<T>(items: readonly T[], size: number, each: (batch: T[]) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += size) await each(items.slice(at, at + size));
}

async function eachAtOnce<T>(items: readonly T[], each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    while (next < items.length) await each(items[next++]);
  }));
}

export async function refreshCataloguePictures(nowMs: number): Promise<Record<string, number>> {
  const db = getFirestore();
  const [lists, rankings] = await Promise.all([
    db.collection(LISTS).select("items").get(),
    db.collection(RANKINGS).select("snapshot.items").get(),
  ]);
  const pictures = picturesIn([...lists.docs, ...rankings.docs].map((doc) => doc.data()));
  const refs = pictures.map((one) => db.collection(PICTURE_CHECKS).doc(keyOf(one.url)));
  const checks = new Map<string, PictureCheck>();
  await inBatches(refs, 300, async (batch) => {
    for (const doc of await db.getAll(...batch)) if (doc.exists) checks.set(doc.get("url") as string, doc.data() as PictureCheck);
  });
  const plan = planRun(pictures, checks, nowMs);

  const written = new Map<string, Partial<PictureCheck>>();
  const note = (url: string, check: Partial<PictureCheck>) => written.set(url, { ...written.get(url), ...check, url });
  const moves = new Map<string, string>();
  const resting = await restingUntil();
  const stopped = new Set<AttributionSource>();
  const usable = (source: AttributionSource) => !stopped.has(source) && (resting.get(source as PictureSource) ?? 0) <= Date.now();
  const refused = async (source: AttributionSource, error: unknown) => {
    stopped.add(source);
    if (error instanceof CatalogueRefusal) await rest(source as PictureSource, error);
  };
  // What the catalogue says the picture is now: moved when it differs, dead when it has none.
  const settle = (picture: CataloguePicture, found: string | null | undefined, asked: { refreshed: boolean }) => {
    if (found === undefined) return;
    const stamp = { checkedAt: nowMs, ...(asked.refreshed ? { refreshedAt: nowMs } : {}) };
    if (found === null) note(picture.url, { ...stamp, status: "gone" });
    else if (found !== picture.url) {
      moves.set(picture.url, found);
      note(picture.url, { ...stamp, status: "moved", movedTo: found });
    } else note(picture.url, { ...stamp, status: "ok" });
  };

  // IGDB, every day, many ids a request.
  if (plan.igdb.length > 0 && usable("igdb")) {
    try {
      const token = await igdbAccess(igdbClientId.value(), igdbClientSecret.value());
      await inBatches(plan.igdb, 500, async (batch) => {
        const ids = batch.map((one) => Number(one.id!.slice("igdb:".length)));
        const body = await getJson("https://api.igdb.com/v4/games", {
          method: "POST",
          headers: { "Client-ID": igdbClientId.value(), Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
          body: `fields cover.image_id; where id = (${ids.join(",")}); limit 500;`,
        });
        const covers = igdbCovers(body);
        for (const one of batch) settle(one, covers.get(one.id!) ?? null, { refreshed: true });
      });
    } catch (error) {
      await refused("igdb", error);
    }
  }

  // TMDB, each id on its own, every 90 days.
  await eachAtOnce(plan.tmdb, async (one) => {
    if (!usable("tmdb")) return;
    try {
      const [, kind, id] = one.id!.split(":");
      settle(one, await askById(`https://api.themoviedb.org/3/${kind}/${id}`, { headers: { Authorization: `Bearer ${pictureTmdbToken.value()}` } }, (body) => tmdbPictureOf(one.id!, body)), { refreshed: true });
    } catch (error) {
      await refused("tmdb", error);
    }
  });

  // Every other address, once a week; a dead one is looked up by its id.
  const unsure = new Map<string, number>();
  const dead: CataloguePicture[] = [];
  await eachAtOnce(plan.probe, async (one) => {
    const host = new URL(one.url).hostname;
    if ((unsure.get(host) ?? 0) >= UNSURE_PER_HOST) return;
    const verdict = probeVerdict(await probe(one.url));
    if (verdict === "unsure") {
      unsure.set(host, (unsure.get(host) ?? 0) + 1);
      return;
    }
    if (verdict === "ok") note(one.url, { checkedAt: nowMs, status: "ok" });
    else if (one.id === null) note(one.url, { checkedAt: nowMs, status: "dead" });
    else dead.push(one);
  });
  await lookUp(dead, usable, refused, (one, found) => settle(one, found, { refreshed: true }));
  for (const one of dead) if (!written.has(one.url)) note(one.url, { checkedAt: nowMs, status: "dead" });

  // Lists and rankings moved to the new addresses, each in a transaction of its own.
  let listsMoved = 0;
  if (moves.size > 0) {
    const touches = (data: Record<string, unknown>, prefix: string) => Object.keys(movedFields(prefix ? data.snapshot : data, moves, prefix)).length > 0;
    const targets: [DocumentReference, string][] = [
      ...lists.docs.filter((doc) => touches(doc.data(), "")).map((doc): [DocumentReference, string] => [doc.ref, ""]),
      ...rankings.docs.filter((doc) => touches(doc.data(), "snapshot.")).map((doc): [DocumentReference, string] => [doc.ref, "snapshot."]),
    ];
    for (const [ref, prefix] of targets) {
      const changed = await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(ref);
        if (!fresh.exists) return false;
        const fields = movedFields(prefix ? fresh.get("snapshot") : fresh.data(), moves, prefix);
        if (Object.keys(fields).length === 0) return false;
        // A list's revision moves, so an editor's copy from before cannot put the old addresses back.
        transaction.update(ref, prefix ? fields : { ...fields, ...nextRevision() });
        return true;
      }).catch((error) => {
        console.error(`Picture refresh: ${ref.path} not moved: ${(error as Error).message}`);
        return false;
      });
      if (changed) listsMoved++;
    }
  }

  await inBatches([...written.values()], 400, async (batch) => {
    const writer = db.batch();
    for (const check of batch) writer.set(db.collection(PICTURE_CHECKS).doc(keyOf(check.url!)), check, { merge: true });
    await writer.commit();
  });
  const count = (status: PictureCheck["status"]) => [...written.values()].filter((one) => one.status === status).length;
  return {
    addresses: pictures.length,
    igdb: plan.igdb.length,
    tmdb: plan.tmdb.length,
    probed: plan.probe.length,
    ok: count("ok"),
    moved: count("moved"),
    dead: count("dead"),
    gone: count("gone"),
    docsMoved: listsMoved,
  };
}

/** A catalogue's answer about one id: a 404 is an answer (it has nothing), a refusal stops that catalogue. */
async function askById(url: string, init: RequestInit, read: (body: unknown) => string | null): Promise<string | null | undefined> {
  const reply = await fetch(url, { ...init, headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (reply.status === 404) return null;
  if (reply.status === 429 || reply.status >= 500) throw new CatalogueRefusal(new URL(url).host, reply.status, reply.headers.get("retry-after"));
  if (!reply.ok) return undefined;
  return read(await reply.json());
}

/** The status an address answers, or null when it answers nothing in time. HEAD first; GET of one byte where HEAD is not allowed. */
async function probe(url: string): Promise<number | null> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const reply = await fetch(url, {
        method,
        headers: { "User-Agent": USER_AGENT, ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await reply.body?.cancel().catch(() => undefined);
      if (method === "HEAD" && (reply.status === 403 || reply.status === 405)) continue;
      return reply.status;
    } catch {
      if (method === "GET") return null;
    }
  }
  return null;
}

/** The dead addresses' catalogues asked by id: AniList and Steam several at once, Open Library one by one, TMDB and IGDB as above. */
async function lookUp(
  dead: readonly CataloguePicture[],
  usable: (source: AttributionSource) => boolean,
  refused: (source: AttributionSource, error: unknown) => Promise<void>,
  found: (picture: CataloguePicture, url: string | null) => void,
): Promise<void> {
  const by = (source: AttributionSource) => dead.filter((one) => one.source === source && one.id !== null);
  const ask = async (source: AttributionSource, work: () => Promise<void>) => {
    if (!usable(source)) return;
    try {
      await work();
    } catch (error) {
      await refused(source, error);
    }
  };
  await ask("anilist", () => inBatches(by("anilist"), IDS_PER_ASK, async (batch) => {
    const ids = batch.map((one) => one.id!);
    const body = await getJson("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: anilistQuery(ids) }) });
    const pictures = anilistPictures(ids, body);
    for (const one of batch) found(one, pictures.get(one.id!) ?? null);
  }));
  await ask("steam", () => inBatches(by("steam"), IDS_PER_ASK, async (batch) => {
    const ids = batch.map((one) => one.id!);
    const request = { ids: ids.map((id) => ({ appid: Number(id.slice("steam:".length)) })), context: { language: "english", country_code: "US" }, data_request: { include_assets: true } };
    const body = await getJson(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?${new URLSearchParams({ input_json: JSON.stringify(request) })}`);
    const pictures = steamPictures(ids, body);
    for (const one of batch) found(one, pictures.get(one.id!) ?? null);
  }));
  await ask("openlibrary", async () => {
    for (const one of by("openlibrary")) {
      const key = one.id!.slice("openlibrary:".length);
      const answer = await askById(`https://openlibrary.org/${key.endsWith("W") ? "works" : "books"}/${key}.json`, {}, openLibraryCover);
      if (answer !== undefined) found(one, answer);
    }
  });
  await ask("tmdb", async () => {
    for (const one of by("tmdb")) {
      const [, kind, id] = one.id!.split(":");
      const answer = await askById(`https://api.themoviedb.org/3/${kind}/${id}`, { headers: { Authorization: `Bearer ${pictureTmdbToken.value()}` } }, (body) => tmdbPictureOf(one.id!, body));
      if (answer !== undefined) found(one, answer);
    }
  });
}
