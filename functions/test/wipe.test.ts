import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectionRule,
  DEFAULT_KEEP_FILE,
  keepsDocument,
  keepsUser,
  keptUids,
  readKeepFile,
  readOptions,
  storageRule,
  targetOf,
} from "../scripts/wipe-production";
import { BUILT_IN_SECTION_IDS } from "../src/sections";

describe("the wipe's collections", () => {
  it("deletes everything people made", () => {
    for (const name of ["publishedLists", "accounts", "rankings", "rankQuota", "rankUsage", "takes", "follows", "sectionFollows",
      "topicFollows", "topics", "topicNames", "sectionProposers", "publishLocks", "reports", "auditLog"]) {
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
  const kept = new Set(["owner-uid", "partner-uid"]);

  it("keeps exactly the accounts named by uid", () => {
    assert.equal(keepsUser({ uid: "owner-uid" }, kept), true);
    assert.equal(keepsUser({ uid: "partner-uid" }, kept), true);
  });

  it("deletes everybody else, guests and look-alikes included", () => {
    assert.equal(keepsUser({ uid: "stranger-uid" }, kept), false);
    assert.equal(keepsUser({ uid: "owner-uid2" }, kept), false);
    assert.equal(keepsUser({ uid: "OWNER-UID" }, kept), false);
  });

  it("reads the keep file's uids and refuses one it cannot trust", () => {
    assert.deepEqual(readKeepFile('{"uids":["owner-uid","partner-uid","owner-uid"]}'), ["owner-uid", "partner-uid"]);
    assert.ok("error" in (readKeepFile("owner-uid") as object));
    assert.ok("error" in (readKeepFile('{"uids":[]}') as object));
    assert.ok("error" in (readKeepFile('{"emails":["someone@example.com"]}') as object));
    assert.ok("error" in (readKeepFile('{"uids":["../x"]}') as object));
  });

  it("takes --keep first, then --keep-file, then the default file, and never an empty list", () => {
    const files: Record<string, string> = { [DEFAULT_KEEP_FILE]: '{"uids":["from-default"]}', "other.json": '{"uids":["from-other"]}' };
    const readText = (path: string) => files[path] ?? null;
    assert.deepEqual([...(keptUids({ keep: ["a", "b"], keepFile: null }, readText) as Set<string>)], ["a", "b"]);
    assert.deepEqual([...(keptUids({ keep: [], keepFile: "other.json" }, readText) as Set<string>)], ["from-other"]);
    assert.deepEqual([...(keptUids({ keep: [], keepFile: null }, readText) as Set<string>)], ["from-default"]);
    assert.ok("error" in keptUids({ keep: [], keepFile: null }, () => null));
    assert.ok("error" in keptUids({ keep: [], keepFile: "missing.json" }, readText));
    assert.ok("error" in keptUids({ keep: [], keepFile: null }, () => '{"uids":[]}'));
  });
});

describe("the wipe's arguments", () => {
  it("is a dry run on the project's default bucket unless told otherwise", () => {
    assert.deepEqual(readOptions(["--project", "tieryourlife"]), {
      projectId: "tieryourlife",
      bucket: "tieryourlife.firebasestorage.app",
      execute: false,
      keep: [],
      keepFile: null,
    });
    assert.deepEqual(readOptions(["--project=demo-x", "--bucket=b", "--execute"]), { projectId: "demo-x", bucket: "b", execute: true, keep: [], keepFile: null });
    assert.deepEqual(readOptions(["--project", "p", "--keep", "a", "--keep=b", "--keep", "a"]), { projectId: "p", bucket: "p.firebasestorage.app", execute: false, keep: ["a", "b"], keepFile: null });
    assert.deepEqual(readOptions(["--project", "p", "--keep-file", "k.json"]), { projectId: "p", bucket: "p.firebasestorage.app", execute: false, keep: [], keepFile: "k.json" });
  });

  it("wants a project and refuses what it does not know", () => {
    assert.ok("error" in readOptions([]));
    assert.ok("error" in readOptions(["--project"]));
    assert.ok("error" in readOptions(["--project", "p", "--yes"]));
    assert.ok("error" in readOptions(["--project", "p", "--execute=no"]));
    assert.ok("error" in readOptions(["--project", "p", "--keep"]));
    assert.ok("error" in readOptions(["--project", "p", "--keep", "someone@example.com"]));
    assert.ok("error" in readOptions(["--project", "p", "--keep", "a", "--keep-file", "k.json"]));
  });

  it("runs on all three emulators or on none, never on a mix", () => {
    const all = { FIRESTORE_EMULATOR_HOST: "a", FIREBASE_AUTH_EMULATOR_HOST: "b", FIREBASE_STORAGE_EMULATOR_HOST: "c" };
    assert.equal(targetOf({}), "live");
    assert.equal(targetOf(all), "emulators");
    assert.equal(targetOf({ ...all, FIREBASE_AUTH_EMULATOR_HOST: "" }), "mixed");
    assert.equal(targetOf({ FIRESTORE_EMULATOR_HOST: "a" }), "mixed");
  });
});
