/**
 * A one-off: the section and topic pictures copied before the proxy set a
 * cache header get the one it sets now. Changes metadata only. A dry run
 * unless `--execute`.
 *
 *   npm run cache-public-pictures -- --project tieryourlife
 *   npm run cache-public-pictures -- --project tieryourlife --execute
 *
 * Runs on application default credentials.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { PUBLIC_PICTURE_CACHE } from "../src/sectionPictures";

const PREFIXES = ["sections/", "topics/"];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = args[args.indexOf("--project") + 1];
  if (!args.includes("--project") || !projectId) throw new Error("Which project? --project <id>");
  const execute = args.includes("--execute");
  const app = initializeApp({ credential: applicationDefault(), projectId, storageBucket: `${projectId}.firebasestorage.app` }, "cache");
  const bucket = getStorage(app).bucket();

  for (const prefix of PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    for (const file of files) {
      const was = file.metadata.cacheControl ?? "(none)";
      if (was === PUBLIC_PICTURE_CACHE) continue;
      console.log(`${execute ? "SET " : "WOULD SET"}  ${file.name}  (was ${was})`);
      if (execute) await file.setMetadata({ cacheControl: PUBLIC_PICTURE_CACHE });
    }
  }
  console.log(execute ? "Done." : "Dry run: nothing was changed. Add --execute to set them.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
