import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { Identity } from "../src/auth";
import { GUEST_UPLOADS_PER_DAY, UPLOADS_PER_DAY } from "../src/pictureBytes";
import { routeUploadQuota, uploadQuota, uploadUsagePath } from "../src/uploadQuota";
import { install, type Fakes } from "./fakeFirebase";

const NOW = Date.UTC(2026, 10, 19, 15, 30);
const MIDNIGHT = Date.UTC(2026, 10, 20);

let fakes: Fakes;
beforeEach(() => {
  fakes = install();
  mock.method(Date, "now", () => NOW);
});
afterEach(() => {
  fakes.restore();
  mock.restoreAll();
});

async function ask(query: Record<string, unknown>, identity: Partial<Identity>) {
  const reply = { status: 0, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const response = {
    status(code: number) { reply.status = code; return response; },
    json(body: Record<string, unknown>) { reply.body = body; return response; },
    setHeader(name: string, value: string) { reply.headers[name] = value; return response; },
  };
  await routeUploadQuota(query, response as never, identity as Identity);
  return reply;
}

describe("how many pictures may still be uploaded today", () => {
  it("counts from what checkUpload counted, a guest's limit lower and warned of first", () => {
    assert.deepEqual(uploadQuota(undefined, true, NOW), { used: 0, left: GUEST_UPLOADS_PER_DAY, limit: GUEST_UPLOADS_PER_DAY, guest: true, warnAt: 180, resetsAt: MIDNIGHT });
    assert.deepEqual(uploadQuota(2005, false, NOW), { used: 2005, left: 0, limit: UPLOADS_PER_DAY, guest: false, warnAt: null, resetsAt: MIDNIGHT });
    assert.equal(uploadQuota("junk", false, NOW).used, 0);
  });

  it("answers a guest and an account what is left", async () => {
    fakes.db.seed(uploadUsagePath("guest", NOW), { count: 185 });
    const guest = await ask({}, { uid: "guest", isAnonymous: true });
    assert.equal(guest.status, 200);
    assert.deepEqual(guest.body.uploads, { used: 185, left: 15, limit: 200, guest: true, warnAt: 180, resetsAt: MIDNIGHT });
    const fresh = await ask({ count: "3" }, { uid: "someone" });
    assert.deepEqual([fresh.status, (fresh.body.uploads as { left: number }).left], [200, 2000]);
  });

  it("refuses a selection that no longer fits: a guest is asked to sign in, an account to come back tomorrow", async () => {
    fakes.db.seed(uploadUsagePath("guest", NOW), { count: 199 });
    fakes.db.seed(uploadUsagePath("full", NOW), { count: 2000 });
    const guest = await ask({ count: "2" }, { uid: "guest", isAnonymous: true });
    assert.deepEqual([guest.status, guest.body.code, guest.body.retryAt], [429, "SIGN_IN_FOR_MORE_UPLOADS", MIDNIGHT]);
    assert.equal(guest.headers["Retry-After"], String((MIDNIGHT - NOW) / 1000));
    assert.equal((await ask({ count: "1" }, { uid: "guest", isAnonymous: true })).status, 200);
    const full = await ask({ count: "1" }, { uid: "full" });
    assert.deepEqual([full.status, full.body.code], [429, "UPLOAD_DAILY_LIMIT"]);
  });

  it("takes a count of 1 to 100 only", async () => {
    for (const count of ["0", "101", "x", "-1", "1.5"]) assert.equal((await ask({ count }, { uid: "a" })).status, 400, count);
  });
});
