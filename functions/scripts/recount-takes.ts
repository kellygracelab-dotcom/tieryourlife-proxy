/**
 * A one-off after a take began to count only when the taker's report would
 * weigh (QA S14, #96): every published list's takeCount is counted again
 * from the takes documents by that rule, judged at the moment of each take.
 * Only lists whose count changes are written. A dry run unless `--apply`.
 *
 *   npm run recount-takes -- --project tieryourlife
 *   npm run recount-takes -- --project tieryourlife --apply
 *
 * Runs on application default credentials.
 *
 * What an old take is judged by, since only its time and its taker were kept:
 * - the taker's account as Auth has it now: none (deleted) never counts, a
 *   guest is one with no sign-in provider, and its age is the take's time
 *   minus the account's creation;
 * - a ban counts when one still on record (`bans/{uid}`, or a ban kept by the
 *   person's hashed sign-ins in `bannedIdentities`) had begun and not run out
 *   at the take's time. A ban lifted by deleting it, or replaced by a later
 *   one, is no longer known and does not count.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { BANNED_IDENTITIES, banOfRecord, identityKeys } from "../src/banIdentities";
import { isBanned, type Ban } from "../src/bans";
import { ACCOUNT_AGE_TO_HIDE_MS, weighsOnHiding } from "../src/moderation";
import { countsAsTake } from "../src/takes";
import { readBackfillOptions, Samples, writeGuarded, type GuardedUpdate } from "./backfillOptions";

const PUBLISHED = "publishedLists";
const TAKES = "takes";
const BANS = "bans";
/** Auth's own ceiling for one `getUsers`. */
const USERS_PER_READ = 100;

export interface TakeRecord {
  listId: string;
  taker: string;
  atMs: number;
}

/** What is known of a taker now. */
export interface Taker {
  guest: boolean;
  createdAtMs: number;
  /** Every ban on record that applies to them, run out or not. */
  bans: Ban[];
}

/** A ban that had begun and had not run out at [atMs]. */
export function bannedAt(bans: readonly Ban[], atMs: number): boolean {
  return bans.some((ban) => ban.bannedAt <= atMs && isBanned(ban, atMs));
}

/** `weighsNow`, asked of a take at the time it was made; no account, no weight. */
export function weighedAt(taker: Taker | undefined, atMs: number): boolean {
  if (taker === undefined) return false;
  return weighsOnHiding({ isAnonymous: taker.guest, banned: bannedAt(taker.bans, atMs), accountAgeMs: atMs - taker.createdAtMs });
}

export type NotCounted = "own_list" | "guest" | "young" | "banned" | "no_account" | "repeat";

/** Why a take does not count, for the totals only; the decision itself is `countsAsTake`'s. */
export function whyNot(take: TakeRecord, authorUid: unknown, taker: Taker | undefined, alreadyTaken: boolean): NotCounted {
  if (authorUid === take.taker) return "own_list";
  if (alreadyTaken) return "repeat";
  if (taker === undefined) return "no_account";
  if (taker.guest) return "guest";
  if (bannedAt(taker.bans, take.atMs)) return "banned";
  if (take.atMs - taker.createdAtMs < ACCOUNT_AGE_TO_HIDE_MS) return "young";
  return "repeat";
}

export interface Recount {
  /** listId to the count the rule gives. Every list is here, with zero when nothing counts. */
  counts: Map<string, number>;
  notCounted: Record<NotCounted | "no_list", number>;
}

/** The takes in the order they were made, each counted as `recordTake` would have counted it then. */
export function recount(
  lists: ReadonlyMap<string, { authorUid: unknown }>,
  takes: readonly TakeRecord[],
  takers: ReadonlyMap<string, Taker>,
): Recount {
  const counts = new Map([...lists.keys()].map((id) => [id, 0]));
  const notCounted: Recount["notCounted"] = { own_list: 0, guest: 0, young: 0, banned: 0, no_account: 0, repeat: 0, no_list: 0 };
  const counted = new Set<string>();
  for (const take of [...takes].sort((left, right) => left.atMs - right.atMs)) {
    const list = lists.get(take.listId);
    if (list === undefined) {
      notCounted.no_list++;
      continue;
    }
    const key = `${take.listId}_${take.taker}`;
    const taker = takers.get(take.taker);
    const alreadyTaken = counted.has(key);
    if (countsAsTake({ takerUid: take.taker, authorUid: list.authorUid, weighs: weighedAt(taker, take.atMs), alreadyTaken })) {
      counted.add(key);
      counts.set(take.listId, (counts.get(take.listId) ?? 0) + 1);
    } else {
      notCounted[whyNot(take, list.authorUid, taker, alreadyTaken)]++;
    }
  }
  return { counts, notCounted };
}

/** The lists whose stored count differs from [counts]; a missing or non-number count differs from any. */
export function changedCounts(stored: ReadonlyMap<string, unknown>, counts: ReadonlyMap<string, number>): { listId: string; from: unknown; to: number }[] {
  return [...counts]
    .filter(([listId, to]) => stored.get(listId) !== to)
    .map(([listId, to]) => ({ listId, from: stored.get(listId), to }));
}

/** A take document as the counting needs it, or null for one without a list or a taker. */
export function takeRecordOf(data: Record<string, unknown>, createTimeMs: number): TakeRecord | null {
  const { listId, taker, createdAt } = data;
  if (typeof listId !== "string" || listId === "" || typeof taker !== "string" || taker === "") return null;
  const at = (createdAt as { toMillis?: () => number } | null | undefined)?.toMillis?.();
  return { listId, taker, atMs: typeof at === "number" ? at : createTimeMs };
}

/** The same keys `readBan` reads for a signed-in caller. */
export function takerOf(user: UserRecord, ownBan: Ban | null, keptBans: ReadonlyMap<string, Ban>): Taker {
  const keys = identityKeys(user.emailVerified ? user.email ?? null : null, user.providerData);
  const bans = [ownBan, ...keys.map((key) => keptBans.get(key) ?? null)].filter((ban): ban is Ban => ban !== null);
  // `weighsNow` reads an unreadable creation time as now, which never weighs.
  const created = Date.parse(user.metadata.creationTime);
  return { guest: user.providerData.length === 0, createdAtMs: Number.isNaN(created) ? Number.POSITIVE_INFINITY : created, bans };
}

async function main(): Promise<number> {
  const options = readBackfillOptions(process.argv.slice(2));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  console.log(`Project ${options.projectId}. ${options.apply ? "APPLY: changed counts are written." : "Dry run: nothing is changed."}`);
  const app = initializeApp({ credential: applicationDefault(), projectId: options.projectId }, "recount-takes");
  const db = getFirestore(app);

  // Lists first: a take made after this read changes the list too, and its write is then refused below.
  const listDocs = (await db.collection(PUBLISHED).get()).docs;
  const takeDocs = (await db.collection(TAKES).get()).docs;
  const [banDocs, keptDocs] = await Promise.all([db.collection(BANS).get(), db.collection(BANNED_IDENTITIES).get()]);

  const lists = new Map(listDocs.map((doc) => [doc.id, { authorUid: doc.get("authorUid") as unknown }]));
  const stored = new Map(listDocs.map((doc) => [doc.id, doc.get("takeCount") as unknown]));
  const takes: TakeRecord[] = [];
  let malformed = 0;
  for (const doc of takeDocs) {
    const take = takeRecordOf(doc.data(), doc.createTime.toMillis());
    if (take === null) malformed++;
    else takes.push(take);
  }

  const ownBans = new Map(banDocs.docs.map((doc) => [doc.id, banOfRecord(doc.data())]));
  const keptBans = new Map(keptDocs.docs.flatMap((doc) => {
    const ban = banOfRecord(doc.data());
    return ban === null ? [] : [[doc.id, ban] as const];
  }));
  const uids = [...new Set(takes.map((take) => take.taker))];
  const takers = new Map<string, Taker>();
  const auth = getAuth(app);
  for (let at = 0; at < uids.length; at += USERS_PER_READ) {
    const found = await auth.getUsers(uids.slice(at, at + USERS_PER_READ).map((uid) => ({ uid })));
    for (const user of found.users) takers.set(user.uid, takerOf(user, ownBans.get(user.uid) ?? null, keptBans));
  }

  const { counts, notCounted } = recount(lists, takes, takers);
  const changes = changedCounts(stored, counts);
  const samples = new Samples();
  for (const change of changes) samples.add(`${PUBLISHED}/${change.listId}  takeCount ${String(change.from ?? "(none)")} -> ${change.to}`);

  const countedTakes = [...counts.values()].reduce((sum, one) => sum + one, 0);
  const storedTotal = [...stored.values()].reduce<number>((sum, one) => sum + (typeof one === "number" ? one : 0), 0);
  console.log(`${listDocs.length} published lists, ${takeDocs.length} take documents (${malformed} without a list or taker), ${uids.length} takers, ${takers.size} still in Auth.`);
  console.log(`Counted ${countedTakes} takes; the lists hold ${storedTotal}.`);
  console.log(`Not counted: ${Object.entries(notCounted).map(([why, n]) => `${why} ${n}`).join(", ")}.`);
  console.log(`${changes.length} lists change${changes.length > samples.lines.length ? `, the first ${samples.lines.length}` : ""}:`);
  samples.lines.forEach((line) => console.log(`  ${line}`));

  if (!options.apply) {
    console.log("Dry run: nothing was changed. Add --apply to write them.");
    return 0;
  }
  const byId = new Map(listDocs.map((doc) => [doc.id, doc]));
  const updates: GuardedUpdate[] = changes.map((change) => {
    const doc = byId.get(change.listId) as FirebaseFirestore.QueryDocumentSnapshot;
    return { ref: doc.ref, fields: { takeCount: change.to }, readAt: doc.updateTime };
  });
  const { written, leftAlone } = await writeGuarded(db, updates, (line) => console.log(line));
  console.log(`Done: ${written} written, ${leftAlone} left alone. Run it again to pick those up.`);
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
