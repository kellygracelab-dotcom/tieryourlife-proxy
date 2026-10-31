import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserRecord } from "firebase-admin/auth";
import {
  collectionRule,
  KEPT_EMAILS,
  keepsDocument,
  keepsUser,
  readOptions,
  storageRule,
  targetOf,
} from "../scripts/wipe-production";
import { BUILT_IN_SECTION_IDS } from "../src/sections";

const user = (email: string | undefined, providerEmails: string[] = []) =>
  ({ email, providerData: providerEmails.map((one) => ({ email: one })) }) as unknown as UserRecord;

describe("the wipe's collections", () => {
  it("deletes everything people made", () => {
    for (const name of ["publishedLists", "accounts", "rankings", "rankQuota", "rankUsage", "takes", "follows", "sectionFollows",
      "topicFollows", "topics", "topicNames", "sectionProposers", "reports", "auditLog"]) {
      assert.equal(collectionRule(name).verdict, "DELETE", name);
    }
  });

  it("keeps roles and config, and is unsure of bans, the generation meter and anything it does not know", () => {
    assert.equal(collectionRule("roles").verdict, "KEEP");
    assert.equal(collectionRule("config").verdict, "KEEP");
    assert.equal(collectionRule("bans").verdict, "KEEP-UNSURE");
    assert.equal(collectionRule("usage").verdict, "KEEP-UNSURE");
    assert.equal(collectionRule("somethingNew").verdict, "KEEP-UNSURE");
  });

  it("keeps the built-in sections and their names, and nothing else of either", () => {
    for (const id of BUILT_IN_SECTION_IDS) {
      assert.equal(keepsDocument("sections", id, { builtIn: true }), true, id);
      assert.equal(keepsDocument("sectionNames", "hash", { sectionId: id }), true, id);
    }
    assert.equal(keepsDocument("sections", "street-food", { builtIn: true }), false);
    assert.equal(keepsDocument("sections", "games-2", {}), false);
    assert.equal(keepsDocument("sectionNames", "hash", { sectionId: "street-food" }), false);
    assert.equal(keepsDocument("sectionNames", "hash", {}), false);
  });
});

describe("the wipe's files", () => {
  it("deletes everybody's uploads, the feed's copies, faces, proposals, topics and share cards", () => {
    for (const path of ["users/u1/pictures/p1", "published/l1/p1", "avatars/u1/f1", "proposals/s1/p1", "topics/t1/p1", "share/r/abc234/1.png"]) {
      assert.equal(storageRule(path).verdict, "DELETE", path);
    }
  });

  it("keeps a built-in section's picture and deletes any other section's", () => {
    assert.deepEqual(storageRule("sections/games/g1"), { verdict: "KEEP", group: "sections/games/", what: "a built-in section's picture" });
    assert.equal(storageRule("sections/games-2/g1").verdict, "DELETE");
    assert.equal(storageRule("sections/street-food/s1").verdict, "DELETE");
  });

  it("is unsure of anything else", () => {
    assert.equal(storageRule("backups/2026.zip").verdict, "KEEP-UNSURE");
    assert.equal(storageRule("loose-file.png").verdict, "KEEP-UNSURE");
    assert.equal(storageRule("sections/games").verdict, "KEEP-UNSURE");
  });
});

describe("the wipe's people", () => {
  it("keeps the owner's two accounts, by email in any case or by a provider's email", () => {
    assert.deepEqual(KEPT_EMAILS, ["kellygracelab@gmail.com", "artimanjustice@gmail.com"]);
    assert.equal(keepsUser(user("kellygracelab@gmail.com")), true);
    assert.equal(keepsUser(user("ArtimanJustice@Gmail.com")), true);
    assert.equal(keepsUser(user(undefined, ["kellygracelab@gmail.com"])), true);
  });

  it("deletes everybody else, guests included", () => {
    assert.equal(keepsUser(user("someone@example.com")), false);
    assert.equal(keepsUser(user(undefined)), false);
    assert.equal(keepsUser(user("kellygracelab@gmail.com.evil.test")), false);
  });
});

describe("the wipe's arguments", () => {
  it("is a dry run on the project's default bucket unless told otherwise", () => {
    assert.deepEqual(readOptions(["--project", "tieryourlife"]), {
      projectId: "tieryourlife",
      bucket: "tieryourlife.firebasestorage.app",
      execute: false,
    });
    assert.deepEqual(readOptions(["--project=demo-x", "--bucket=b", "--execute"]), { projectId: "demo-x", bucket: "b", execute: true });
  });

  it("wants a project and refuses what it does not know", () => {
    assert.ok("error" in readOptions([]));
    assert.ok("error" in readOptions(["--project"]));
    assert.ok("error" in readOptions(["--project", "p", "--yes"]));
    assert.ok("error" in readOptions(["--project", "p", "--execute=no"]));
  });

  it("runs on all three emulators or on none, never on a mix", () => {
    const all = { FIRESTORE_EMULATOR_HOST: "a", FIREBASE_AUTH_EMULATOR_HOST: "b", FIREBASE_STORAGE_EMULATOR_HOST: "c" };
    assert.equal(targetOf({}), "live");
    assert.equal(targetOf(all), "emulators");
    assert.equal(targetOf({ ...all, FIREBASE_AUTH_EMULATOR_HOST: "" }), "mixed");
    assert.equal(targetOf({ FIRESTORE_EMULATOR_HOST: "a" }), "mixed");
  });
});
