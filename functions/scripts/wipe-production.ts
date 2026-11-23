/**
 * A one-off wipe of everything people made: lists, boards, rankings, follows,
 * proposals, reports, the log, their files and their Auth accounts. What the
 * service needs to run stays: the built-in sections, roles, config and the
 * accounts it is told to keep. A dry run unless `--execute`, and `--execute`
 * asks for the project id typed back before it deletes anything.
 *
 * The accounts kept are named by uid, never written here (the repository is
 * public): `--keep <uid>` once per account, or a file `wipe-production.keep.json`
 * in the folder it runs from, `{ "uids": ["…", "…"] }`, which git ignores
 * (`--keep-file <path>` names another). Without either it refuses to run, and
 * a uid no account has stops `--execute`: a typo must not wipe the owner.
 *
 *   npm run wipe-production -- --project tieryourlife             (dry run)
 *   npm run wipe-production -- --project tieryourlife --execute
 *
 * Runs on application default credentials, or on the emulators when all
 * three emulator variables are set.
 */
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { applicationDefault, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { BUILT_IN_SECTION_IDS } from "../src/sections";

export type Verdict = "DELETE" | "KEEP" | "KEEP-UNSURE";

/** Where the accounts to keep are listed when no `--keep` or `--keep-file` says otherwise. Ignored by git. */
export const DEFAULT_KEEP_FILE = "wipe-production.keep.json";

const UID = /^[A-Za-z0-9_-]{1,128}$/;

/** The uids in a keep file's text, `{ "uids": [...] }`, or why it cannot be read. */
export function readKeepFile(text: string): string[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "The keep file is not JSON." };
  }
  const uids = (parsed as { uids?: unknown } | null)?.uids;
  if (!Array.isArray(uids) || uids.length === 0) return { error: 'The keep file needs { "uids": ["<uid>", ...] } with at least one uid.' };
  const wrong = uids.find((uid) => typeof uid !== "string" || !UID.test(uid));
  if (wrong !== undefined) return { error: `Not a uid in the keep file: ${JSON.stringify(wrong)}` };
  return [...new Set(uids as string[])];
}

/**
 * The accounts to keep: those passed as `--keep`, else those in `--keep-file`,
 * else those in the default file. None at all is an error, so a missing list
 * can never mean "keep nobody".
 */
export function keptUids(options: Pick<Options, "keep" | "keepFile">, readText: (path: string) => string | null): Set<string> | { error: string } {
  if (options.keep.length > 0) return new Set(options.keep);
  const path = options.keepFile ?? DEFAULT_KEEP_FILE;
  const text = readText(path);
  if (text === null) {
    return { error: `No account to keep: pass --keep <uid> once per account, or list them in ${path} as { "uids": [...] }. Nothing was read or changed.` };
  }
  const uids = readKeepFile(text);
  return "error" in uids ? { error: `${path}: ${uids.error} Nothing was read or changed.` } : new Set(uids);
}

const readTextOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

interface CollectionRule {
  /** SOME keeps the documents `keepsDocument` says are the built-ins' and deletes the rest. */
  verdict: Verdict | "SOME";
  what: string;
}

/** Every root collection the proxy and the website's `web` function write. */
export const COLLECTIONS: Readonly<Record<string, CollectionRule>> = {
  publishedLists: { verdict: "DELETE", what: "published lists" },
  accounts: { verdict: "DELETE", what: "credits per account, with accounts/*/boards (boards, their trash and games)" },
  rankings: { verdict: "DELETE", what: "app rankings {listId}_{uid} and the website's /r/ codes" },
  rankQuota: { verdict: "DELETE", what: "the website's per-account ranking write marks" },
  rankUsage: { verdict: "DELETE", what: "the website's daily ranking counter" },
  takes: { verdict: "DELETE", what: "who took whose list" },
  follows: { verdict: "DELETE", what: "author follows" },
  sectionFollows: { verdict: "DELETE", what: "section follows" },
  topicFollows: { verdict: "DELETE", what: "topic follows" },
  topics: { verdict: "DELETE", what: "topics, approved and proposed" },
  topicNames: { verdict: "DELETE", what: "topic name reservations" },
  sections: { verdict: "SOME", what: "built-in sections kept; other sections and every proposal deleted" },
  sectionNames: { verdict: "SOME", what: "built-in sections' name reservations kept; the rest deleted" },
  sectionProposers: { verdict: "DELETE", what: "per-account proposal allowance" },
  publishLocks: { verdict: "DELETE", what: "per-author lock that keeps parallel publishes under the list limit" },
  reports: { verdict: "DELETE", what: "reports, the moderation queue and the wording watcher's flags" },
  auditLog: { verdict: "DELETE", what: "the audit log" },
  roles: { verdict: "KEEP", what: "moderators" },
  config: { verdict: "KEEP", what: "config/sections, the order version" },
  bans: { verdict: "KEEP-UNSURE", what: "bans by uid; idle once those accounts are gone" },
  usage: { verdict: "KEEP-UNSURE", what: "service-wide daily generation meter (the spend ceiling), not per person" },
};

export function collectionRule(name: string): CollectionRule {
  return COLLECTIONS[name] ?? { verdict: "KEEP-UNSURE", what: "not written by any code read for this script" };
}

const isBuiltIn = (id: unknown) => typeof id === "string" && BUILT_IN_SECTION_IDS.includes(id);

/** For a SOME collection: whether this document is a built-in's and stays. */
export function keepsDocument(collection: string, id: string, data: Record<string, unknown>): boolean {
  if (collection === "sections") return isBuiltIn(id);
  if (collection === "sectionNames") return isBuiltIn(data.sectionId);
  return collectionRule(collection).verdict !== "DELETE";
}

export interface StorageRule {
  verdict: Verdict;
  group: string;
  what: string;
}

const STORAGE_FOLDERS: Readonly<Record<string, string>> = {
  users: "everybody's own uploads",
  published: "the feed's copies of list pictures",
  avatars: "faces",
  proposals: "section proposals' private pictures",
  topics: "topic pictures",
  share: "the website's share cards for lists and rankings, and its cover collages",
};

export function storageRule(path: string): StorageRule {
  const [top, second] = path.split("/");
  if (top === "sections" && second !== undefined && path.length > `sections/${second}`.length) {
    return isBuiltIn(second)
      ? { verdict: "KEEP", group: `sections/${second}/`, what: "a built-in section's picture" }
      : { verdict: "DELETE", group: "sections/* (not built-in)", what: "other sections' pictures" };
  }
  const what = STORAGE_FOLDERS[top];
  if (what !== undefined && path.includes("/")) return { verdict: "DELETE", group: `${top}/*`, what };
  return { verdict: "KEEP-UNSURE", group: path.includes("/") ? `${top}/*` : path, what: "not written by any code read for this script" };
}

export function keepsUser(user: Pick<UserRecord, "uid">, kept: ReadonlySet<string>): boolean {
  return kept.has(user.uid);
}

export interface Options {
  projectId: string;
  bucket: string;
  execute: boolean;
  /** Uids passed as `--keep`. */
  keep: string[];
  keepFile: string | null;
}

export function readOptions(argv: readonly string[]): Options | { error: string } {
  let projectId: string | null = null;
  let bucket: string | null = null;
  let execute = false;
  const keep: string[] = [];
  let keepFile: string | null = null;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++at];
    if (flag === "--project") projectId = value() ?? null;
    else if (flag === "--bucket") bucket = value() ?? null;
    else if (flag === "--execute" && inline === undefined) execute = true;
    else if (flag === "--keep") {
      const uid = value();
      if (uid === undefined || !UID.test(uid)) return { error: `--keep wants a uid, not ${JSON.stringify(uid ?? "")}` };
      keep.push(uid);
    } else if (flag === "--keep-file") {
      keepFile = value() ?? null;
      if (!keepFile) return { error: "--keep-file wants a path" };
    } else return { error: `Unknown argument: ${argv[at]}` };
  }
  if (!projectId) return { error: "Which project? Pass --project <id>." };
  if (keep.length > 0 && keepFile !== null) return { error: "Pass --keep or --keep-file, not both." };
  return { projectId, bucket: bucket ?? `${projectId}.firebasestorage.app`, execute, keep: [...new Set(keep)], keepFile };
}

const EMULATOR_VARIABLES = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"];

/** All three emulators or none: a wipe that reaches one live service and two local ones is the worst of both. */
export function targetOf(env: NodeJS.ProcessEnv): "emulators" | "live" | "mixed" {
  const set = EMULATOR_VARIABLES.filter((name) => (env[name] ?? "") !== "");
  if (set.length === 0) return "live";
  return set.length === EMULATOR_VARIABLES.length ? "emulators" : "mixed";
}

interface CollectionPlan {
  name: string;
  rule: CollectionRule;
  total: number;
  /** For SOME: the documents that go. */
  doomed: FirebaseFirestore.DocumentReference[];
  kept: number;
}

interface StoragePlan {
  rule: StorageRule;
  files: string[];
}

export interface Plan {
  collections: CollectionPlan[];
  boards: number;
  storage: StoragePlan[];
  keptUsers: UserRecord[];
  doomedUsers: UserRecord[];
  /** Uids to keep that no account has. */
  missingUids: string[];
}

export async function makePlan(app: App, bucket: string, kept: ReadonlySet<string>): Promise<Plan> {
  const db = getFirestore(app);
  // The known ones too: a collection holding only subcollections, like accounts can, may not be listed.
  const listed = (await db.listCollections()).map((one) => one.id);
  const roots = [...new Set([...listed, ...Object.keys(COLLECTIONS)])].sort();
  const collections = await Promise.all(roots.map((name) => planCollection(db, name)));
  const boards = (await db.collectionGroup("boards").count().get()).data().count;

  const groups = new Map<string, StoragePlan>();
  const [files] = await getStorage(app).bucket(bucket).getFiles({ autoPaginate: true });
  for (const file of files) {
    const rule = storageRule(file.name);
    const group = groups.get(rule.group) ?? { rule, files: [] };
    group.files.push(file.name);
    groups.set(rule.group, group);
  }

  const users = await allUsers(app);
  const keptUsers = users.filter((user) => keepsUser(user, kept));
  const found = new Set(keptUsers.map((user) => user.uid));
  return {
    collections,
    boards,
    storage: [...groups.values()].sort((left, right) => left.rule.group.localeCompare(right.rule.group)),
    keptUsers,
    doomedUsers: users.filter((user) => !keepsUser(user, kept)),
    missingUids: [...kept].filter((uid) => !found.has(uid)),
  };
}

/** Phones and browsers upload boards the account no longer has, so they must be quiet before and cleared after. */
const BEFORE_AND_AFTER = [
  "",
  "Before typing the id:",
  "  1. Close every TierYourLife tab in every browser and stop the app on every phone.",
  "After it finishes, before anybody signs in again:",
  "  2. Clear site data for tieryourlife.com, tieryourlife.web.app and tieryourlife.firebaseapp.com in every browser.",
  "  3. Clear the app's data on every phone (Settings > Apps > TierYourLife > Storage > Clear data).",
].join("\n");

async function planCollection(db: Firestore, name: string): Promise<CollectionPlan> {
  const rule = collectionRule(name);
  const collection = db.collection(name);
  if (rule.verdict !== "SOME") {
    const total = (await collection.count().get()).data().count;
    return { name, rule, total, doomed: [], kept: rule.verdict === "DELETE" ? 0 : total };
  }
  const docs = (await collection.get()).docs;
  const doomed = docs.filter((doc) => !keepsDocument(name, doc.id, doc.data())).map((doc) => doc.ref);
  return { name, rule, total: docs.length, doomed, kept: docs.length - doomed.length };
}

async function allUsers(app: App): Promise<UserRecord[]> {
  const users: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAuth(app).listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken !== undefined);
  return users;
}

const row = (verdict: string, where: string, name: string, count: string, what: string) =>
  `${verdict.padEnd(12)} ${where.padEnd(10)} ${name.padEnd(28)} ${count.padStart(12)}  ${what}`;

const describeUser = (user: UserRecord) => `${user.email ?? (user.providerData.length === 0 ? "(anonymous)" : "(no email)")} ${user.uid}`;

export function describePlan(plan: Plan): string[] {
  const lines = [row("VERDICT", "WHERE", "WHAT", "COUNT", "")];
  for (const one of plan.collections) {
    if (one.rule.verdict === "SOME") {
      lines.push(row("DELETE", "firestore", one.name, `${one.doomed.length} docs`, one.rule.what));
      lines.push(row("KEEP", "firestore", one.name, `${one.kept} docs`, "the built-ins'"));
    } else {
      lines.push(row(one.rule.verdict, "firestore", one.name, `${one.total} docs`, one.rule.what));
    }
    if (one.name === "accounts") lines.push(row("DELETE", "firestore", "accounts/*/boards", `${plan.boards} docs`, "every board, under accounts"));
  }
  for (const group of plan.storage) {
    lines.push(row(group.rule.verdict, "storage", group.rule.group, `${group.files.length} files`, group.rule.what));
  }
  const anonymous = plan.doomedUsers.filter((user) => user.providerData.length === 0).length;
  lines.push(row("DELETE", "auth", "users", `${plan.doomedUsers.length} users`, `everybody else, ${anonymous} of them guests`));
  for (const user of plan.keptUsers) {
    lines.push(row("KEEP", "auth", "user", "1 user", `${describeUser(user)}; its boards, lists and follows still go`));
  }
  for (const uid of plan.missingUids) lines.push(`WARNING: no Auth user has uid ${uid}: --execute refuses until the keep list is right.`);
  return lines;
}

/** Firestore first, so nothing points at files or people that are gone; the people last. */
export async function executePlan(app: App, bucket: string, plan: Plan, log: (line: string) => void): Promise<void> {
  const db = getFirestore(app);
  for (const one of plan.collections) {
    if (one.rule.verdict === "DELETE") {
      await db.recursiveDelete(db.collection(one.name));
      log(`deleted firestore ${one.name}`);
    } else if (one.rule.verdict === "SOME" && one.doomed.length > 0) {
      const writer = db.bulkWriter();
      for (const ref of one.doomed) void writer.delete(ref);
      await writer.close();
      log(`deleted ${one.doomed.length} of firestore ${one.name}`);
    }
  }

  const files = plan.storage.filter((group) => group.rule.verdict === "DELETE").flatMap((group) => group.files);
  const store = getStorage(app).bucket(bucket);
  for (let at = 0; at < files.length; at += 50) {
    await Promise.all(files.slice(at, at + 50).map((name) => store.file(name).delete({ ignoreNotFound: true })));
  }
  log(`deleted ${files.length} storage files`);

  const uids = plan.doomedUsers.map((user) => user.uid);
  let failed = 0;
  for (let at = 0; at < uids.length; at += 1000) {
    if (at > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await getAuth(app).deleteUsers(uids.slice(at, at + 1000));
    failed += result.failureCount;
    result.errors.forEach((one) => log(`could not delete user ${uids[at + one.index]}: ${one.error.message}`));
  }
  log(`deleted ${uids.length - failed} auth users${failed > 0 ? `, ${failed} failed` : ""}`);
}

async function main(): Promise<number> {
  const options = readOptions(process.argv.slice(2));
  if ("error" in options) {
    console.error(options.error);
    return 2;
  }
  const target = targetOf(process.env);
  if (target === "mixed") {
    console.error(`Set all of ${EMULATOR_VARIABLES.join(", ")} or none of them.`);
    return 2;
  }
  const kept = keptUids(options, readTextOrNull);
  if ("error" in kept) {
    console.error(kept.error);
    return 2;
  }
  console.log(`Project ${options.projectId}, bucket ${options.bucket}, ${target === "live" ? "LIVE" : "local emulators"}.`);
  console.log(options.execute ? "EXECUTE: this deletes what is listed below." : "Dry run: nothing is changed.");

  const app = initializeApp({ credential: applicationDefault(), projectId: options.projectId, storageBucket: options.bucket }, "wipe");
  const plan = await makePlan(app, options.bucket, kept);
  describePlan(plan).forEach((line) => console.log(line));
  if (options.execute && plan.missingUids.length > 0) {
    console.log("\nA uid to keep belongs to no account (see the warning above). Nothing was changed.");
    return 2;
  }
  if (!options.execute) {
    console.log("\nDry run: nothing was changed. Add --execute to delete what is marked DELETE.");
    console.log(BEFORE_AND_AFTER);
    return 0;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`\nType the project id (${options.projectId}) to delete everything marked DELETE: `)).trim();
  prompt.close();
  if (typed !== options.projectId) {
    console.log("That is not the project id. Nothing was changed.");
    return 1;
  }
  await executePlan(app, options.bucket, plan, (line) => console.log(line));
  console.log("Done. Now clear site data and the app's data on every device, before anybody signs in again.");
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
