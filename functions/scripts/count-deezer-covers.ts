/**
 * Read-only: how much Deezer art public data still holds, now that Deezer is
 * no longer searched. Counts the cards, covers and collages of published
 * lists and of rankings that point at `*.dzcdn.net`, the copies in
 * `published/` that came from there, and the cached picture searches that
 * hold Deezer's hits. Prints ids and counts only; writes nothing.
 *
 *   npm run count-deezer-covers -- --project tieryourlife
 *
 * Runs on application default credentials.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { outsideName } from "../src/outsidePictures";
import { readBackfillOptions } from "./backfillOptions";

const CACHE_FRESH_MS = 3 * 24 * 60 * 60 * 1000;

export function isDeezerAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "dzcdn.net" || host.endsWith(".dzcdn.net") || host === "deezer.com" || host.endsWith(".deezer.com");
  } catch {
    return false;
  }
}

/** Every Deezer address anywhere in [value], by the path it was found at (`items[3].imageUrl`). */
export function deezerAddressesIn(value: unknown, path = ""): { path: string; url: string }[] {
  if (isDeezerAddress(value)) return [{ path, url: value }];
  if (Array.isArray(value)) return value.flatMap((one, at) => deezerAddressesIn(one, `${path}[${at}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, one]) => deezerAddressesIn(one, path ? `${path}.${key}` : key));
  }
  return [];
}

/** What a published list holds of Deezer's: its cards with such art, and which other fields hold some. */
export function deezerOnList(data: Record<string, unknown>): { items: number; fields: Set<string>; urls: Set<string> } {
  const found = deezerAddressesIn(data);
  const items = new Set(found.flatMap(({ path }) => /^items\[(\d+)\]/.exec(path)?.[1] ?? []));
  const fields = new Set(found.map(({ path }) => path.replace(/\[\d+\]/g, "[]")));
  return { items: items.size, fields, urls: new Set(found.map(({ url }) => url)) };
}

/** A cached search answer that holds anything of Deezer's. */
export function cacheHoldsDeezer(data: Record<string, unknown>): boolean {
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  return items.some((hit) => hit?.source === "deezer" || deezerAddressesIn(hit).length > 0);
}

async function main(): Promise<number> {
  const options = readBackfillOptions(process.argv.slice(2));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  if (options.apply) {
    console.error("This only counts; there is nothing to apply.");
    return 2;
  }
  initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket });
  const db = getFirestore();
  console.log(`Project ${options.projectId}, bucket ${options.bucket}. Read only.`);

  const knownUrls = new Set<string>();
  for (const name of ["publishedLists", "rankings"]) {
    const docs = (await db.collection(name).get()).docs;
    const holding: string[] = [];
    let items = 0;
    const fields = new Map<string, number>();
    for (const doc of docs) {
      const found = deezerOnList(doc.data());
      if (found.urls.size === 0) continue;
      holding.push(`${doc.id} (${found.items})`);
      items += found.items;
      found.urls.forEach((url) => knownUrls.add(url));
      found.fields.forEach((field) => fields.set(field, (fields.get(field) ?? 0) + 1));
    }
    console.log(`${name}: ${docs.length} documents, ${holding.length} hold Deezer art, ${items} cards with it.`);
    if (fields.size > 0) console.log(`  fields: ${[...fields].map(([field, n]) => `${field} on ${n}`).join(", ")}`);
    if (holding.length > 0) console.log(`  ids (cards): ${holding.join(" ")}`);
  }

  const cache = (await db.collection("pictureCache").get()).docs;
  let withDeezer = 0;
  let freshWithDeezer = 0;
  for (const doc of cache) {
    if (!cacheHoldsDeezer(doc.data())) continue;
    withDeezer++;
    const at = doc.get("at")?.toMillis?.() ?? 0;
    if (Date.now() - at < CACHE_FRESH_MS) freshWithDeezer++;
    for (const hit of doc.get("items") ?? []) deezerAddressesIn(hit).forEach(({ url }) => knownUrls.add(url));
  }
  console.log(`pictureCache: ${cache.length} entries, ${withDeezer} hold Deezer hits (${freshWithDeezer} under three days old). None is served after the change: their keys are of the old cache shape.`);

  // A copy is named after the address it came from and records nothing else: it can only be matched by name.
  const [files] = await getStorage().bucket().getFiles({ prefix: "published/" });
  const copies = files.filter((file) => /(^|-)w-[0-9a-f]{32}$/.test(file.name.split("/").pop() ?? ""));
  const withSource = copies.filter((file) => Object.keys(file.metadata.metadata ?? {}).length > 0).length;
  const wanted = new Map([...knownUrls].map((url) => [outsideName(url), url]));
  const fromDeezer = copies.filter((file) => wanted.has((file.name.split("/").pop() ?? "").replace(/^.*?(w-[0-9a-f]{32})$/, "$1")));
  console.log(`published/: ${copies.length} copies of pictures from other sites, ${withSource} with custom metadata; ${fromDeezer.length} named after one of the ${knownUrls.size} Deezer addresses seen above.`);
  if (fromDeezer.length > 0) console.log(`  lists: ${[...new Set(fromDeezer.map((file) => file.name.split("/")[1]))].join(" ")}`);
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
