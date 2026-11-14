import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { eraseAccount } from "../src/erase";
import { identityKeys, liftBan, liftBanLogged, readBan, replaceKeptBans, sweepExpiredBans } from "../src/banIdentities";
import { banFrom } from "../src/bans";

const DAY = 24 * 60 * 60 * 1000;
const google = { providerId: "google.com", uid: "104729" };
const keys = identityKeys("someone@gmail.com", [google]);
const person = (uid: string) => ({ uid, email: "someone@gmail.com", emailVerified: true, providerData: [google] });

let fakes: Fakes;
beforeEach(() => {
  fakes = install();
});
afterEach(() => fakes.restore());

/** An account that moderates, proposed topics, keeps a board, and is banned for a week. */
function seedErasable(uid: string, banned = true) {
  const { db, users } = fakes;
  users.set(uid, person(uid));
  if (banned) db.seed(`bans/${uid}`, { ...banFrom("week", Date.now(), "spam") });
  db.seed(`roles/${uid}`, { moderator: true, name: "Erased Person", photoUrl: "https://x.test/face.png" });
  db.seed(`publishLocks/${uid}`, { lastPublishAt: 1 });
  for (const status of ["pending", "rejected", "approved", "merged"]) {
    db.seed(`topics/${status}`, { name: status, status, createdBy: uid, proposerName: "Erased Person" });
  }
  db.seed("topics/someoneElses", { name: "theirs", status: "pending", createdBy: "someone", proposerName: "Someone" });
  db.seed(`accounts/${uid}`, { credits: 3 });
  db.seed(`accounts/${uid}/boards/board1`, { title: "Mine", revision: 1 });
}

describe("eraseAccount", () => {
  it("leaves the tombstone first, keeps the ban before the identity goes, and deletes the identity last", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    const { log } = fakes;
    assert.equal(log[0], "set erasedAccounts/old1");
    assert.equal(log[log.length - 1], "deleteUser old1");
    const keptAt = log.findIndex((line) => line.startsWith("set bannedIdentities/"));
    assert.ok(keptAt > 0 && keptAt < log.indexOf("delete roles/old1"));
  });

  it("removes the moderator's role and the topics nobody approved, with their pictures", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    const { db, log } = fakes;
    assert.equal(db.get("roles/old1"), undefined);
    assert.equal(db.get("publishLocks/old1"), undefined);
    assert.equal(db.get("topics/pending"), undefined);
    assert.equal(db.get("topics/rejected"), undefined);
    assert.ok(log.includes("deleteFiles topics/pending/"));
    assert.ok(log.includes("deleteFiles topics/rejected/"));
    assert.equal(db.get("accounts/old1/boards/board1"), undefined);
    assert.equal(db.get("accounts/old1"), undefined);
  });

  it("keeps an approved or merged topic without the proposer, and nobody else's is touched", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    const { db } = fakes;
    for (const status of ["approved", "merged"]) {
      assert.deepEqual(db.get(`topics/${status}`), { name: status, status, createdBy: "", proposerName: "" });
    }
    assert.equal(db.get("topics/someoneElses")?.createdBy, "someone");
  });

  it("keeps the ban by the person's hashed sign-ins, lists them on the old ban, and logs it without a name", async () => {
    seedErasable("old1");
    const ban = fakes.db.get("bans/old1")!;
    await eraseAccount("old1");
    const { db } = fakes;
    assert.deepEqual([...(db.get("bans/old1")!.identityKeys as string[])].sort(), [...keys].sort());
    for (const key of keys) {
      assert.deepEqual(db.get(`bannedIdentities/${key}`), { until: ban.until, bannedAt: ban.bannedAt });
    }
    const logged = [...db.docs.entries()].filter(([path]) => path.startsWith("auditLog/")).map(([, row]) => row);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].what, "ban.kept_past_erasure");
    assert.equal(logged[0].target, "bans/old1");
    assert.equal(JSON.stringify(logged[0]).includes("Erased Person"), false);
  });

  it("bans the next account of the same person", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    assert.equal((await readBan({ uid: "new1", banKeys: keys }))?.until, fakes.db.get("bans/old1")!.until);
  });

  it("keeps nothing by identity for an account that was not banned", async () => {
    seedErasable("old1", false);
    await eraseAccount("old1");
    assert.equal(fakes.log.some((line) => line.includes("bannedIdentities/")), false);
    assert.equal(fakes.db.get("bans/old1"), undefined);
  });

  it("takes their likes off the counts, and their rankings with the likes on them and their folders", async () => {
    seedErasable("old1");
    const { db, log } = fakes;
    db.seed("rankings/L1_old1", { listId: "L1", uid: "old1", likeCount: 1 });
    db.seed("rankings/L2_other", { listId: "L2", uid: "other", likeCount: 2 });
    db.seed("publishedLists/L1", { authorUid: "author", rankingCount: 1 });
    db.seed("rankingLikes/fan:L1_old1", { rankingId: "L1_old1", listId: "L1", uid: "fan", rankedBy: "old1" });
    db.seed("rankingLikes/old1:L2_other", { rankingId: "L2_other", listId: "L2", uid: "old1", rankedBy: "other" });
    db.seed("likeQuota/old1", { events: [1] });
    await eraseAccount("old1");
    assert.equal(db.get("rankings/L1_old1"), undefined);
    assert.equal(db.get("publishedLists/L1")?.rankingCount, 0);
    assert.equal(db.get("rankingLikes/fan:L1_old1"), undefined);
    assert.equal(db.get("rankingLikes/old1:L2_other"), undefined);
    assert.equal(db.get("rankings/L2_other")?.likeCount, 1);
    assert.equal(db.get("likeQuota/old1"), undefined);
    assert.ok(log.includes("deleteFiles published/ranking-L1_old1/"));
  });

  it("takes their lists' rankings with them, and their photographs out of other people's copies", async () => {
    seedErasable("old1");
    const { db, log, files } = fakes;
    const ORIGINAL = "OrigListAAAAAAAAAAAA";
    const COPY = "CopyListBBBBBBBBBBBB";
    const ART = `${ORIGINAL}-w-0123456789abcdef0123456789abcdef`;
    const at = (folder: string, name: string) => `https://firebasestorage.googleapis.com/v0/b/fake-bucket/o/${encodeURIComponent(`published/${folder}/${name}`)}?alt=media`;
    db.seed(`publishedLists/${ORIGINAL}`, { authorUid: "old1" });
    db.seed(`rankings/${ORIGINAL}_reader`, { listId: ORIGINAL, uid: "reader" });
    db.seed(`publishedLists/${COPY}`, { authorUid: "other", revision: 2, picturesFrom: [ORIGINAL], coverImageUrl: null, previewImages: [], items: [{ title: "photo", imageUrl: at(COPY, `${ORIGINAL}-pic1`) }, { title: "art", imageUrl: at(COPY, ART) }] });
    db.seed("rankings/L9_reader", { listId: "L9", uid: "reader", picturesFrom: [ORIGINAL], addedCards: [{ title: "photo", imageUrl: at("ranking-L9_reader", `${ORIGINAL}-pic1`) }] });
    files.push(`published/${COPY}/${ORIGINAL}-pic1`, `published/${COPY}/${ART}`, `published/ranking-L9_reader/${ORIGINAL}-pic1`);
    await eraseAccount("old1");
    const copy = db.get(`publishedLists/${COPY}`)!;
    assert.deepEqual((copy.items as { imageUrl: string | null }[]).map((item) => item.imageUrl === null), [true, false]);
    assert.equal(copy.revision, 3);
    assert.equal((db.get("rankings/L9_reader")!.addedCards as { imageUrl: string | null }[])[0].imageUrl, null);
    assert.ok(log.includes(`deleteFile published/${COPY}/${ORIGINAL}-pic1`));
    assert.ok(log.includes(`deleteFile published/ranking-L9_reader/${ORIGINAL}-pic1`));
    assert.ok(!log.includes(`deleteFile published/${COPY}/${ART}`));
    assert.equal(db.get(`rankings/${ORIGINAL}_reader`), undefined);
    assert.ok(log.includes(`deleteFiles published/ranking-${ORIGINAL}_reader/`));
  });

  it("can be asked again after it finished", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    await eraseAccount("old1");
    assert.equal(fakes.db.get("roles/old1"), undefined);
  });
});

describe("liftBan", () => {
  it("lifts a kept ban by the erased account's uid", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    const lifted = await liftBan("old1");
    assert.equal(lifted.keptRecords, 2);
    assert.equal(lifted.ban?.reason, "spam");
    assert.equal(fakes.db.get("bans/old1"), undefined);
    assert.equal(await readBan({ uid: "new1", banKeys: keys }), null);
  });

  it("lifts it by the new account's uid, through who that account is now", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    fakes.users.set("new1", person("new1"));
    const lifted = await liftBan("new1");
    assert.equal(lifted.ban, null);
    assert.equal(lifted.keptRecords, 2);
    assert.equal(await readBan({ uid: "new1", banKeys: keys }), null);
  });

  it("lifts a plain ban on a live account", async () => {
    fakes.users.set("live1", { uid: "live1", providerData: [] });
    fakes.db.seed("bans/live1", { ...banFrom("forever", Date.now(), null) });
    await liftBan("live1");
    assert.equal(await readBan({ uid: "live1", banKeys: [] }), null);
  });
});

describe("liftBanLogged", () => {
  it("lifts by the new uid a ban kept from the erased one, and logs what it cleared", async () => {
    seedErasable("old1");
    await eraseAccount("old1");
    fakes.users.set("new1", person("new1"));
    assert.ok(await readBan({ uid: "new1", banKeys: keys }));
    assert.equal(await liftBanLogged("owner1", "owner", "new1"), true);
    assert.equal(await readBan({ uid: "new1", banKeys: keys }), null);
    const rows = [...fakes.db.docs.entries()].filter(([path, row]) => path.startsWith("auditLog/") && row.what === "ban.lift");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0][1], { who: "owner1", role: "owner", what: "ban.lift", target: "bans/new1", before: { keptRecords: 2 }, after: null, at: "serverTimestamp" });
  });

  it("logs nothing when there was nothing to lift", async () => {
    fakes.users.set("live1", { uid: "live1", providerData: [] });
    assert.equal(await liftBanLogged("owner1", "owner", "live1"), false);
    assert.ok(![...fakes.db.docs.keys()].some((path) => path.startsWith("auditLog/")));
  });
});

describe("replaceKeptBans", () => {
  it("lets a shorter ban set on the new account win over the kept one", async () => {
    const now = Date.now();
    keys.forEach((key) => fakes.db.seed(`bannedIdentities/${key}`, { until: null, bannedAt: now - DAY }));
    fakes.users.set("new1", person("new1"));
    const week = banFrom("week", now, "spam");
    fakes.db.seed("bans/new1", { ...week });
    await replaceKeptBans("new1", week);
    assert.equal((await readBan({ uid: "new1", banKeys: keys }))?.until, week.until);
  });

  it("makes no record for somebody who never erased an account", async () => {
    fakes.users.set("new1", person("new1"));
    await replaceKeptBans("new1", banFrom("week", Date.now(), null));
    assert.equal(fakes.log.length, 0);
  });
});

describe("expired kept bans", () => {
  it("are deleted when read", async () => {
    const [key] = keys;
    fakes.db.seed(`bannedIdentities/${key}`, { until: Date.now() - 1, bannedAt: Date.now() - DAY });
    assert.equal(await readBan({ uid: "new1", banKeys: [key] }), null);
    assert.equal(fakes.db.get(`bannedIdentities/${key}`), undefined);
  });

  it("are swept, and a ban for ever or still running is kept", async () => {
    const now = Date.now();
    fakes.db.seed("bannedIdentities/ran-out", { until: now - 1, bannedAt: now - DAY });
    fakes.db.seed("bannedIdentities/forever", { until: null, bannedAt: now - DAY });
    fakes.db.seed("bannedIdentities/running", { until: now + DAY, bannedAt: now - DAY });
    assert.equal(await sweepExpiredBans(now), 1);
    assert.deepEqual([...fakes.db.docs.keys()].sort(), ["bannedIdentities/forever", "bannedIdentities/running"]);
  });
});
