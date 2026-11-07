/**
 * A one-off after publishing began to copy pictures from other sites and show
 * them through SafeSearch (QA S11, #97): every picture already published from
 * another site, on a list's cards, cover and collage, and every author's face
 * on a list or a ranking, goes through the same code publish uses now. It is
 * replaced by our copy, or by nothing when it is refused, dropped, or cannot
 * be fetched. The daily allowance and the publish deadline do not apply;
 * four fetches at once still do. A dry run unless `--apply`: the dry run
 * fetches, copies and asks Vision nothing, and only lists what is there.
 *
 *   npm run check-outside-pictures -- --project tieryourlife
 *   npm run check-outside-pictures -- --project tieryourlife --apply
 *
 * Runs on application default credentials; `--apply` also needs Vision
 * (the project's quota) on them.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  checkedFace,
  copyOutside,
  MAX_OUTSIDE_PICTURES_PER_LIST,
  outsideAddressesIn,
  realOutsideTools,
  withCopies,
  type OutsideCopies,
  type OutsideTools,
} from "../src/outsidePictures";
import type { SafetyRefusal } from "../src/safety";
import { readBackfillOptions, Samples, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const PUBLISHED = "publishedLists";
const RANKINGS = "rankings";
const FETCHING_AT_ONCE = 4;
/** Instead of publish's twelve seconds: a picture is given up on by `downloadPicture`'s own timeouts, not by ours. */
const GENEROUS_MS = 5 * 60_000;

export type PictureOutcome =
  /** Ours already, catalogue art, or a Google account photo: nothing to do. */
  | { kind: "kept" }
  /** Copied earlier, by publish or by a run of this: no fetch. */
  | { kind: "reused"; address: string }
  | { kind: "copied"; address: string }
  /** Not fetched, not a still picture, or Vision said nothing; also a face whose address is not one we fetch. */
  | { kind: "dropped" }
  | { kind: "refused"; because: SafetyRefusal | null }
  /** Dry run: this one would be fetched and looked at. */
  | { kind: "would_fetch" };

export interface Attempt {
  url: string;
  /** What the module answered: the address to show, or null. */
  address: string | null;
  /** SafeSearch refused it (a list's picture; a face says only null). */
  refused?: SafetyRefusal;
  fetched: boolean;
  saved: boolean;
  dryRun: boolean;
}

/** What one picture's run through `copyOutside` or `checkedFace` comes to. */
export function decidePicture(attempt: Attempt): PictureOutcome {
  if (attempt.refused !== undefined) return { kind: "refused", because: attempt.refused };
  if (attempt.address === attempt.url) return { kind: "kept" };
  if (attempt.address !== null) return attempt.saved ? { kind: "copied", address: attempt.address } : { kind: "reused", address: attempt.address };
  return attempt.dryRun && attempt.fetched ? { kind: "would_fetch" } : { kind: "dropped" };
}

/** What a document holds in its place: undefined while the dry run cannot know. */
export function replacementOf(outcome: PictureOutcome, url: string): string | null | undefined {
  switch (outcome.kind) {
    case "kept":
      return url;
    case "reused":
    case "copied":
      return outcome.address;
    case "dropped":
    case "refused":
      return null;
    case "would_fetch":
      return undefined;
  }
}

/** A single answer from `copyOutside` for one address, as an attempt. */
export function attemptOf(url: string, result: OutsideCopies, seen: { fetched: boolean; saved: boolean }, dryRun: boolean): Attempt {
  if (!result.ok && "overDailyLimit" in result) throw new Error("The daily allowance was asked for, and it should not have been");
  if (!result.ok) return { url, address: null, refused: result.refused.because, ...seen, dryRun };
  return { url, address: result.copies.get(url) ?? null, ...seen, dryRun };
}

export interface ListPictures {
  items: { imageUrl: string | null }[];
  coverImageUrl: string | null;
  previewImages: string[];
}

/** A stored list's pictures, with anything that is not a string read as no picture. */
export function picturesOf(data: Record<string, unknown>): ListPictures & { rawItems: Record<string, unknown>[] } {
  const rawItems = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    rawItems,
    items: rawItems.map((item) => ({ imageUrl: text(item?.imageUrl) })),
    coverImageUrl: text(data.coverImageUrl),
    previewImages: Array.isArray(data.previewImages) ? data.previewImages.filter((url): url is string => typeof url === "string") : [],
  };
}

/** The fields of a list that change once [copies] are in, or null when none does. */
export function listFieldsAfter(data: Record<string, unknown>, copies: ReadonlyMap<string, string | null>): Record<string, unknown> | null {
  const before = picturesOf(data);
  const after = withCopies({ items: before.rawItems as { imageUrl: string | null }[], coverImageUrl: before.coverImageUrl, previewImages: before.previewImages }, copies);
  // A card that had no picture keeps having none, rather than an undefined one.
  const items = after.items.map((item, at) => (before.items[at]?.imageUrl === null ? before.rawItems[at] : item));
  const fields: Record<string, unknown> = {};
  if (JSON.stringify(items) !== JSON.stringify(before.rawItems)) fields.items = items;
  if (after.coverImageUrl !== before.coverImageUrl) fields.coverImageUrl = after.coverImageUrl;
  if (JSON.stringify(after.previewImages) !== JSON.stringify(before.previewImages)) fields.previewImages = after.previewImages;
  return Object.keys(fields).length > 0 ? fields : null;
}

/** An address as a sample line shows it: no query, nothing after the path; a face by its site only. */
export function shown(url: string, face: boolean): string {
  try {
    const parsed = new URL(url);
    return face ? `a face at ${parsed.host || "(no host)"}` : `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 120);
  } catch {
    return face ? "a face at (not an address)" : "(not an address)";
  }
}

function outcomeShown(outcome: PictureOutcome): string {
  switch (outcome.kind) {
    case "would_fetch":
      return "fetch, SafeSearch, then our copy or null";
    case "reused":
    case "copied":
      return `our copy (${outcome.kind})`;
    case "refused":
      return `null (refused${outcome.because ? `: ${outcome.because}` : ""})`;
    default:
      return outcome.kind === "dropped" ? "null (dropped)" : "unchanged";
  }
}

/** Runs [work] over [items], [atOnce] at a time. */
async function eachAtMost<T>(items: readonly T[], atOnce: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
}

/** One folder listed once for the whole run; each address is tried once, so a cached listing is never stale for it. */
function listingOnce(namesIn: OutsideTools["namesIn"]): OutsideTools["namesIn"] {
  const listed = new Map<string, Promise<Set<string>>>();
  return (folder) => {
    if (!listed.has(folder)) listed.set(folder, namesIn(folder));
    return listed.get(folder) as Promise<Set<string>>;
  };
}

/** The real tools without the account's daily allowance, or, for a dry run, ones that only read the bucket's listings. */
function backfillTools(dryRun: boolean): OutsideTools {
  const real = realOutsideTools("backfill");
  const namesIn = listingOnce(real.namesIn);
  const unlimited = { reserve: async () => true, giveBack: async () => undefined };
  if (!dryRun) return { ...real, namesIn, ...unlimited };
  const never = async (): Promise<never> => {
    throw new Error("The dry run writes nothing");
  };
  return { bucket: real.bucket, namesIn, ...unlimited, save: never, remove: never, lookAt: never, fetch: async () => ({ error: "DRY_RUN" }) };
}

/** [tools], noting whether this one attempt fetched and saved. */
function watched(tools: OutsideTools): { tools: OutsideTools; seen: { fetched: boolean; saved: boolean } } {
  const seen = { fetched: false, saved: false };
  return {
    seen,
    tools: {
      ...tools,
      fetch: (url, stop) => {
        seen.fetched = true;
        return tools.fetch(url, stop);
      },
      save: async (path, bytes, type) => {
        await tools.save(path, bytes, type);
        seen.saved = true;
      },
    },
  };
}

interface Job {
  kind: "picture" | "face";
  /** The list's id for a picture, the account's uid for a face. */
  owner: string;
  url: string;
  outcome?: PictureOutcome;
}

const jobKey = (kind: Job["kind"], owner: string, url: string) => `${kind}\n${owner}\n${url}`;

async function main(): Promise<number> {
  const options = readBackfillOptions(process.argv.slice(2));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const dryRun = !options.apply;
  console.log(`Project ${options.projectId}, bucket ${options.bucket}. ${dryRun ? "Dry run: nothing is fetched, copied, looked at or changed." : "APPLY: pictures are fetched, looked at, copied and written."}`);
  // The default app: `realOutsideTools` asks for the default Firestore and bucket.
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();
  const tools = backfillTools(dryRun);

  const listDocs = (await db.collection(PUBLISHED).get()).docs;
  const rankingDocs = (await db.collection(RANKINGS).get()).docs;

  const jobs = new Map<string, Job>();
  const want = (kind: Job["kind"], owner: string, url: string) => {
    const key = jobKey(kind, owner, url);
    if (!jobs.has(key)) jobs.set(key, { kind, owner, url });
  };
  let listsWithOutside = 0;
  let overLimit = 0;
  let outsideOnLists = 0;
  for (const doc of listDocs) {
    const urls = outsideAddressesIn(picturesOf(doc.data()), doc.id, tools.bucket);
    if (urls.length > 0) listsWithOutside++;
    if (urls.length > MAX_OUTSIDE_PICTURES_PER_LIST) overLimit++;
    outsideOnLists += urls.length;
    urls.forEach((url) => want("picture", doc.id, url));
  }
  const faceOf = (data: Record<string, unknown>, uidField: string): { uid: string; url: string } | null => {
    const url = data.authorPhotoUrl;
    const uid = data[uidField];
    return typeof url === "string" && typeof uid === "string" && uid !== "" ? { uid, url } : null;
  };
  let facesWithoutOwner = 0;
  for (const [docs, uidField] of [[listDocs, "authorUid"], [rankingDocs, "uid"]] as const) {
    for (const doc of docs) {
      const face = faceOf(doc.data(), uidField);
      if (face !== null) want("face", face.uid, face.url);
      else if (typeof doc.get("authorPhotoUrl") === "string") facesWithoutOwner++;
    }
  }

  const all = [...jobs.values()];
  let done = 0;
  await eachAtMost(all, FETCHING_AT_ONCE, async (job) => {
    const one = watched(tools);
    const until = AbortSignal.timeout(GENEROUS_MS);
    if (job.kind === "face") {
      const address = await checkedFace(job.owner, job.url, one.tools, { until });
      job.outcome = decidePicture({ url: job.url, address, ...one.seen, dryRun });
    } else {
      const result = await copyOutside(`published/${job.owner}/`, [job.url], one.tools, { atOnce: 1, until });
      job.outcome = decidePicture(attemptOf(job.url, result, one.seen, dryRun));
    }
    done++;
    if (!dryRun && done % 50 === 0) console.log(`  ${done} of ${all.length} pictures`);
  });

  const outcomeFor = (kind: Job["kind"], owner: string, url: string) => jobs.get(jobKey(kind, owner, url))?.outcome;
  const tally = (kind: Job["kind"]) => {
    const counts: Record<PictureOutcome["kind"], number> = { kept: 0, reused: 0, copied: 0, dropped: 0, refused: 0, would_fetch: 0 };
    for (const job of all) if (job.kind === kind && job.outcome) counts[job.outcome.kind]++;
    return Object.entries(counts).filter(([, n]) => n > 0).map(([what, n]) => `${what} ${n}`).join(", ") || "none";
  };

  const samples = new Samples();
  const updates: GuardedUpdate[] = [];
  let listsChanging = 0;
  let rankingsChanging = 0;
  const faceChange = (doc: FirebaseFirestore.QueryDocumentSnapshot, uidField: string, fields: Record<string, unknown>): boolean => {
    const face = faceOf(doc.data(), uidField);
    if (face === null) return false;
    const outcome = outcomeFor("face", face.uid, face.url);
    if (outcome === undefined || outcome.kind === "kept") return false;
    samples.add(`${doc.ref.path}  authorPhotoUrl: ${shown(face.url, true)} -> ${outcomeShown(outcome)}`);
    const next = replacementOf(outcome, face.url);
    if (next !== undefined) fields.authorPhotoUrl = next;
    return true;
  };

  for (const doc of listDocs) {
    const data = doc.data();
    const fields: Record<string, unknown> = {};
    let changes = faceChange(doc, "authorUid", fields);
    const copies = new Map<string, string | null>();
    for (const url of outsideAddressesIn(picturesOf(data), doc.id, tools.bucket)) {
      const outcome = outcomeFor("picture", doc.id, url);
      if (outcome === undefined || outcome.kind === "kept") continue;
      changes = true;
      samples.add(`${doc.ref.path}  ${shown(url, false)} -> ${outcomeShown(outcome)}`);
      const next = replacementOf(outcome, url);
      if (next !== undefined) copies.set(url, next);
    }
    Object.assign(fields, listFieldsAfter(data, copies) ?? {});
    if (changes) listsChanging++;
    if (Object.keys(fields).length > 0) updates.push({ ref: doc.ref, fields, readAt: doc.updateTime });
  }
  for (const doc of rankingDocs) {
    const fields: Record<string, unknown> = {};
    if (faceChange(doc, "uid", fields)) rankingsChanging++;
    if (Object.keys(fields).length > 0) updates.push({ ref: doc.ref, fields, readAt: doc.updateTime });
  }

  const faces = all.filter((job) => job.kind === "face").length;
  console.log(`${listDocs.length} published lists: ${listsWithOutside} hold ${outsideOnLists} pictures from other sites (${jobs.size - faces} distinct per list)${overLimit > 0 ? `, ${overLimit} over publish's ${MAX_OUTSIDE_PICTURES_PER_LIST}` : ""}.`);
  console.log(`  pictures: ${tally("picture")}`);
  console.log(`${rankingDocs.length} rankings. Faces on lists and rankings: ${faces} distinct per account${facesWithoutOwner > 0 ? ` (${facesWithoutOwner} more with no account to keep them under, left alone)` : ""}.`);
  console.log(`  faces: ${tally("face")}`);
  console.log(`Documents to change: ${listsChanging} lists, ${rankingsChanging} rankings.`);
  console.log(`Changes${samples.count > samples.lines.length ? `, the first ${samples.lines.length} of ${samples.count}` : ""}:`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

  if (dryRun) {
    console.log("Dry run: nothing was fetched, copied or changed. Add --apply to do it.");
    return 0;
  }
  const { written, leftAlone } = await writeGuarded(db, updates, (line) => console.log(line));
  console.log(`Done: ${written} documents written, ${leftAlone} left alone. Run it again to pick those up; copies made are reused.`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
