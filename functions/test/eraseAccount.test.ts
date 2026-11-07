import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { install, type Fakes } from "./fakeFirebase";
import { eraseAccount } from "../src/erase";
import { identityKeys, liftBan, readBan, replaceKeptBans, sweepExpiredBans } from "../src/banIdentities";
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
