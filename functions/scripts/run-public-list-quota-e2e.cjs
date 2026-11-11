/* The fixture's N=2 is scoped to the child demo emulator process; it never edits production settings. */
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const config = process.env.E2E_FIREBASE_CONFIG;
if (config && !/^[a-zA-Z0-9_.-]+\.json$/.test(config)) throw new Error("Use a repository-root emulator config filename");
const command = "firebase emulators:exec --only functions,firestore,auth,storage --project demo-tieryourlife" +
  (config ? ` --config ${config}` : "") + " \"node --test functions/lib-test/scripts/public-list-quota.emulator.js\"";
const result = spawnSync(command, {
  shell: true, stdio: "inherit", cwd: resolve(__dirname, "../.."),
  env: { ...process.env, PUBLIC_LISTS_PER_SEVEN_DAYS: "2" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
