/**
 * The wipe run for real against the emulators: `npm run test:wipe`. Seeds a
 * little of everything, then checks a dry run and a wrong confirmation
 * change nothing, and that the real run leaves exactly what it promised.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { BUILT_IN_SECTION_IDS } from "../src/sections";
import { targetOf } from "./wipe-production";

const PROJECT = process.env.GCLOUD_PROJECT ?? "";
const BUCKET = `${PROJECT}.appspot.com`;
const OWNER = "owner-uid";
const PARTNER = "partner-uid";
const STRANGER = "stranger-uid";
const MODERATOR = "moderator-uid";
const GUEST = "guest-uid";

assert.equal(targetOf(process.env), "emulators", "run through `npm run test:wipe`, never against a real project");
assert.ok(PROJECT.startsWith("demo-"), "only a demo- project, which the emulators never send anywhere");

// Nothing here, nor the script it starts, can reach real credentials even if it tried.
const nowhere = mkdtempSync(join(tmpdir(), "wipe-no-credentials-"));
process.env.GOOGLE_APPLICATION_CREDENTIALS = join(nowhere, "none.json");
process.env.CLOUDSDK_CONFIG = nowhere;

const app = initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore(app);
const bucket = getStorage(app).bucket(BUCKET);

const DOCUMENTS: Record<string, Record<string, object>> = {
  publishedLists: { l1: { authorUid: OWNER }, l2: { authorUid: STRANGER } },
  accounts: { [OWNER]: { credits: 3 }, [GUEST]: { credits: 5 } },
  [`accounts/${OWNER}/boards`]: { b1: { revision: 1, deleted: false } },
  [`accounts/${STRANGER}/boards`]: { b2: { revision: 4, deleted: true } },
  rankings: {
    [`l1_${STRANGER}`]: { listId: "l1", uid: STRANGER },
    abc234: { listId: "l1", ownerUid: STRANGER, ownerAnonymous: false },
    def567: { listId: "l2", ownerUid: null, ownerAnonymous: true },
  },
  rankQuota: { [STRANGER]: { lastWriteAt: 1 } },
  rankUsage: { "2026-11-01": { count: 2 } },
  takes: { [`l1_${STRANGER}`]: { listId: "l1", taker: STRANGER } },
  follows: { [`${STRANGER}_${OWNER}`]: { follower: STRANGER, author: OWNER } },
  sectionFollows: { [`${OWNER}_games`]: { follower: OWNER, section: "games" } },
  topicFollows: { [`${OWNER}_t1`]: { follower: OWNER, topicId: "t1" } },
  topics: { t1: { name: "Zelda", section: "games", status: "approved" }, t2: { name: "Proposed", status: "pending" } },
  topicNames: { zelda: { key: "zelda", topicId: "t1" } },
  sections: {
    games: { builtIn: true, status: "approved", picture: { url: "https://pic/games" } },
    other: { builtIn: true, status: "approved" },
    "street-food": { builtIn: false, status: "approved" },
    "games-2": { builtIn: false, status: "approved" },
    "s-waiting": { builtIn: false, status: "pending", proposerUid: STRANGER },
    "s-declined": { builtIn: false, status: "declined", proposerUid: STRANGER },
  },
  sectionNames: { games: { key: "games", sectionId: "games" }, "street-food": { key: "street food", sectionId: "street-food" } },
  sectionProposers: { [STRANGER]: { times: [1] } },
  reports: { [`l2_${OWNER}`]: { listId: "l2", reporterUid: OWNER }, "l2___wording__": { listId: "l2", reporterUid: "__wording__" } },
  auditLog: { a1: { action: "section.edit", target: "sections/games" } },
  roles: { [MODERATOR]: { moderator: true } },
  config: { sections: { version: 3 } },
  bans: { [STRANGER]: { reason: "spam" } },
  usage: { "2026-11-01": { generations: 7 } },
  mystery: { m1: { what: "nobody knows" } },
};

const FILES = [
  `users/${OWNER}/pictures/p1`,
  `users/${STRANGER}/pictures/p2`,
  "published/l1/p1",
  `avatars/${STRANGER}/f1`,
  "proposals/s-waiting/p1",
  "sections/games/g1",
  "sections/other/o1",
  "sections/street-food/s1",
  "sections/games-2/x1",
  "topics/t1/t1",
  "share/l/l1/1.png",
  "share/r/abc234/1.png",
  "mystery/file.bin",
];

async function seed(): Promise<void> {
  const writer = db.bulkWriter();
  for (const [collection, docs] of Object.entries(DOCUMENTS)) {
    for (const [id, data] of Object.entries(docs)) void writer.set(db.collection(collection).doc(id), data);
  }
  await writer.close();
  await Promise.all(FILES.map((name) => bucket.file(name).save(Buffer.from(name), { resumable: false, contentType: "image/webp" })));
  const auth = getAuth(app);
  const people: [string, string][] = [
    [OWNER, "kellygracelab@gmail.com"],
    [PARTNER, "ArtimanJustice@gmail.com"],
    [STRANGER, "stranger@example.com"],
    [MODERATOR, "moderator@example.com"],
  ];
  for (const [uid, email] of people) {
    await auth.createUser({ uid, email });
    await auth.updateUser(uid, { providerToLink: { providerId: "google.com", uid: `google-${uid}`, email } });
  }
  await auth.createUser({ uid: GUEST });
}

/** The script as Danylo runs it. */
function wipe(args: string[], typed = ""): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [join(__dirname, "wipe-production.js"), "--project", PROJECT, "--bucket", BUCKET, ...args], {
    input: typed,
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

async function snapshot(): Promise<{ docs: string[]; files: string[]; users: string[] }> {
  const docs: string[] = [];
  for (const collection of await db.listCollections()) {
    for (const doc of (await collection.get()).docs) docs.push(doc.ref.path);
  }
  for (const board of (await db.collectionGroup("boards").get()).docs) docs.push(board.ref.path);
  const [files] = await bucket.getFiles();
  const { users } = await getAuth(app).listUsers();
  return { docs: docs.sort(), files: files.map((file) => file.name).sort(), users: users.map((one) => one.uid).sort() };
}

describe("wiping production, on the emulators", () => {
  let seeded: Awaited<ReturnType<typeof snapshot>>;

  before(async () => {
    await seed();
    seeded = await snapshot();
  });

  it("lists everything a dry run would do and changes nothing", async () => {
    const { status, out } = wipe([]);
    assert.equal(status, 0, out);
    const has = (pattern: RegExp) => assert.match(out, pattern);
    has(/local emulators/);
    has(/Dry run: nothing is changed/);
    has(/^DELETE\s+firestore\s+publishedLists\s+2 docs/m);
    has(/^DELETE\s+firestore\s+accounts\/\*\/boards\s+2 docs/m);
    has(/^DELETE\s+firestore\s+rankings\s+3 docs/m);
    has(/^DELETE\s+firestore\s+sections\s+4 docs/m);
    has(/^KEEP\s+firestore\s+sections\s+2 docs/m);
    has(/^DELETE\s+firestore\s+sectionNames\s+1 docs/m);
    has(/^KEEP\s+firestore\s+roles\s+1 docs/m);
    has(/^KEEP-UNSURE\s+firestore\s+bans\s+1 docs/m);
    has(/^KEEP-UNSURE\s+firestore\s+usage\s+1 docs/m);
    has(/^KEEP-UNSURE\s+firestore\s+mystery\s+1 docs/m);
    has(/^DELETE\s+storage\s+users\/\*\s+2 files/m);
    has(/^DELETE\s+storage\s+sections\/\* \(not built-in\)\s+2 files/m);
    has(/^KEEP\s+storage\s+sections\/games\/\s+1 files/m);
    has(/^KEEP-UNSURE\s+storage\s+mystery\/\*\s+1 files/m);
    has(/^DELETE\s+auth\s+users\s+3 users\s+everybody else, 1 of them guests/m);
    has(/^KEEP\s+auth\s+user\s+1 user\s+kellygracelab@gmail.com owner-uid/m);
    has(/^KEEP\s+auth\s+user\s+1 user\s+artimanjustice@gmail.com partner-uid/m);
    assert.doesNotMatch(out, /WARNING/);
    assert.deepEqual(await snapshot(), seeded);
  });

  it("changes nothing when the project id is typed wrong", async () => {
    const { status, out } = wipe(["--execute"], "tieryourlife\n");
    assert.equal(status, 1, out);
    assert.match(out, /Nothing was changed/);
    assert.deepEqual(await snapshot(), seeded);
  });

  it("leaves only what it keeps once the project id is typed", async () => {
    const { status, out } = wipe(["--execute"], `${PROJECT}\n`);
    assert.equal(status, 0, out);
    const left = await snapshot();
    assert.deepEqual(left.docs, [
      "bans/stranger-uid",
      "config/sections",
      "mystery/m1",
      "roles/moderator-uid",
      "sectionNames/games",
      "sections/games",
      "sections/other",
      "usage/2026-11-01",
    ]);
    assert.deepEqual(left.files, ["mystery/file.bin", "sections/games/g1", "sections/other/o1"]);
    assert.deepEqual(left.users, [OWNER, PARTNER].sort());
    const games = await db.collection("sections").doc("games").get();
    assert.equal(games.get("picture").url, "https://pic/games");
    assert.ok(BUILT_IN_SECTION_IDS.includes("games") && BUILT_IN_SECTION_IDS.includes("other"));
  });

  it("finds nothing more to delete when run again", async () => {
    const { status, out } = wipe([]);
    assert.equal(status, 0, out);
    assert.match(out, /^DELETE\s+firestore\s+publishedLists\s+0 docs/m);
    assert.match(out, /^DELETE\s+auth\s+users\s+0 users/m);
    assert.doesNotMatch(out, /^DELETE\s+storage/m);
  });
});
