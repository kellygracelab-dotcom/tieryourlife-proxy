import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserRecord } from "firebase-admin/auth";
import { identityKeys } from "../src/banIdentities";
import { ACCOUNT_AGE_TO_HIDE_MS } from "../src/moderation";
import {
  bannedAt,
  changedCounts,
  recount,
  takeRecordOf,
  takerOf,
  weighedAt,
  type TakeRecord,
  type Taker,
} from "../scripts/recount-takes";
import { readBackfillOptions } from "../scripts/backfillOptions";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = ACCOUNT_AGE_TO_HIDE_MS;
const T0 = Date.UTC(2026, 9, 1);
const grown: Taker = { guest: false, createdAtMs: T0 - 30 * DAY, bans: [] };

describe("weighedAt", () => {
  it("weighs a signed-in account a week old at the take", () => {
    assert.equal(weighedAt(grown, T0), true);
    assert.equal(weighedAt({ ...grown, createdAtMs: T0 - WEEK }, T0), true);
  });

  it("judges the age at the take, not now", () => {
    assert.equal(weighedAt({ ...grown, createdAtMs: T0 - WEEK + 1 }, T0), false);
    assert.equal(weighedAt({ ...grown, createdAtMs: T0 - 2 * DAY }, T0 + 6 * DAY), true);
  });

  it("never weighs a guest or an account Auth no longer has", () => {
    assert.equal(weighedAt({ ...grown, guest: true }, T0), false);
    assert.equal(weighedAt(undefined, T0), false);
  });

  it("does not weigh an account whose creation time cannot be read", () => {
    assert.equal(weighedAt({ ...grown, createdAtMs: Number.POSITIVE_INFINITY }, T0), false);
  });
});

describe("bannedAt", () => {
  const ban = { bannedAt: T0, until: T0 + 7 * DAY, reason: null };

  it("counts a ban only between its start and its end", () => {
    assert.equal(bannedAt([ban], T0 - 1), false);
    assert.equal(bannedAt([ban], T0), true);
    assert.equal(bannedAt([ban], T0 + 7 * DAY - 1), true);
    assert.equal(bannedAt([ban], T0 + 7 * DAY), false);
  });

  it("a ban for ever has no end", () => {
    assert.equal(bannedAt([{ ...ban, until: null }], T0 + 1000 * DAY), true);
  });
});

describe("recount", () => {
  const lists = new Map([
    ["L1", { authorUid: "author" }],
    ["L2", { authorUid: "author" }],
  ]);
  const takers = new Map<string, Taker>([
    ["reader", grown],
    ["author", grown],
    ["guest", { ...grown, guest: true }],
    ["fresh", { ...grown, createdAtMs: T0 - DAY }],
    ["banned", { ...grown, bans: [{ bannedAt: T0 - DAY, until: null, reason: null }] }],
    ["later", { ...grown, bans: [{ bannedAt: T0 + DAY, until: null, reason: null }] }],
  ]);
  const take = (taker: string, listId = "L1", atMs = T0): TakeRecord => ({ listId, taker, atMs });

  it("counts by countsAsTake, judged at each take", () => {
    const { counts, notCounted } = recount(
      lists,
      [take("reader"), take("author"), take("guest"), take("fresh"), take("banned"), take("later"), take("gone"), take("reader", "L2"), take("reader", "L9")],
      takers,
    );
    assert.deepEqual([...counts], [["L1", 2], ["L2", 1]]);
    assert.deepEqual(notCounted, { own_list: 1, guest: 1, young: 1, banned: 1, no_account: 1, repeat: 0, no_list: 1 });
  });

  it("counts an account once per list", () => {
    const { counts, notCounted } = recount(lists, [take("reader"), take("reader", "L1", T0 + 1)], takers);
    assert.equal(counts.get("L1"), 1);
    assert.equal(notCounted.repeat, 1);
  });

  it("gives every list a count, zero when nothing counts", () => {
    assert.deepEqual([...recount(lists, [], takers).counts], [["L1", 0], ["L2", 0]]);
  });
});

describe("changedCounts", () => {
  it("names only the lists whose count changes, and a missing count as changed", () => {
    const counts = new Map([["A", 2], ["B", 0], ["C", 0], ["D", 1]]);
    const stored = new Map<string, unknown>([["A", 2], ["B", 5], ["C", undefined], ["D", "1"]]);
    assert.deepEqual(changedCounts(stored, counts), [
      { listId: "B", from: 5, to: 0 },
      { listId: "C", from: undefined, to: 0 },
      { listId: "D", from: "1", to: 1 },
    ]);
  });

  it("changes nothing once the counts are written", () => {
    const counts = new Map([["A", 2], ["B", 0]]);
    assert.deepEqual(changedCounts(new Map(counts), counts), []);
  });
});

describe("takeRecordOf", () => {
  it("reads the take's own time, or the document's when it has none", () => {
    assert.deepEqual(takeRecordOf({ listId: "L1", taker: "u", createdAt: { toMillis: () => 5 } }, 9), { listId: "L1", taker: "u", atMs: 5 });
    assert.deepEqual(takeRecordOf({ listId: "L1", taker: "u" }, 9), { listId: "L1", taker: "u", atMs: 9 });
  });

  it("drops a take without a list or a taker", () => {
    assert.equal(takeRecordOf({ taker: "u" }, 9), null);
    assert.equal(takeRecordOf({ listId: "L1", taker: "" }, 9), null);
  });
});

describe("takerOf", () => {
  const user = (over: Partial<UserRecord>): UserRecord =>
    ({ uid: "u", emailVerified: true, email: "Reader@Example.com", providerData: [{ providerId: "google.com", uid: "sub-1" }], metadata: { creationTime: new Date(T0).toUTCString() }, ...over }) as unknown as UserRecord;

  it("is a guest without a sign-in provider", () => {
    assert.equal(takerOf(user({ providerData: [] }), null, new Map()).guest, true);
    assert.equal(takerOf(user({}), null, new Map()).guest, false);
  });

  it("brings its own ban and the bans kept by its sign-ins, as readBan does", () => {
    const own = { bannedAt: 1, until: null, reason: null };
    const kept = { bannedAt: 2, until: 3, reason: null };
    const [key] = identityKeys("reader@example.com", []);
    const taker = takerOf(user({}), own, new Map([[key as string, kept], ["other", { ...kept, bannedAt: 9 }]]));
    assert.deepEqual(taker.bans, [own, kept]);
    assert.equal(taker.createdAtMs, T0);
  });

  it("leaves an unverified address out of the keys", () => {
    const [key] = identityKeys("reader@example.com", []);
    const kept = { bannedAt: 2, until: null, reason: null };
    assert.deepEqual(takerOf(user({ emailVerified: false }), null, new Map([[key as string, kept]])).bans, []);
  });
});

describe("readBackfillOptions", () => {
  it("is a dry run unless --apply", () => {
    assert.deepEqual(readBackfillOptions(["--project", "p"]), { projectId: "p", bucket: "p.firebasestorage.app", apply: false });
    assert.deepEqual(readBackfillOptions(["--project=p", "--apply"]), { projectId: "p", bucket: "p.firebasestorage.app", apply: true });
  });

  it("refuses an unknown flag rather than running without it", () => {
    assert.ok("error" in readBackfillOptions(["--project", "p", "--execute"]));
    assert.ok("error" in readBackfillOptions(["--project", "p", "--apply=yes"]));
    assert.ok("error" in readBackfillOptions([]));
  });
});
