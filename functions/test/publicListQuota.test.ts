import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimPublicListQuota, decidePublicListQuota, PUBLIC_LIST_WINDOW_MS, readPublicListQuotaLimit } from "../src/publicListQuota";

describe("the opt-in, configurable rolling public-list quota", () => {
  const now = 3 * PUBLIC_LIST_WINDOW_MS;
  it("defaults to OFF and only enables an explicitly configured positive integer", () => {
    for (const value of [undefined, "", "  ", "off", " OFF "]) assert.equal(readPublicListQuotaLimit(value), null);
    assert.equal(readPublicListQuotaLimit("2"), 2);
    assert.equal(readPublicListQuotaLimit(" 17 "), 17);
    for (const value of ["0", "-1", "1.5", "yes", "on", "2e1", "02", "9007199254740992"]) assert.throws(() => readPublicListQuotaLimit(value));
  });
  it("has no enabled quantity and does not touch storage when disabled", async () => {
    assert.deepEqual(await claimPublicListQuota({ readEvents: async () => { throw new Error("unexpected read"); }, writeEvents: () => { throw new Error("unexpected write"); } }, null, now), { allowed: true, events: [] });
  });
  it("expires at exactly seven days, rather than at a calendar-week boundary", () => {
    assert.equal(decidePublicListQuota([now - PUBLIC_LIST_WINDOW_MS], 1, now).allowed, true);
    assert.deepEqual(decidePublicListQuota([now - PUBLIC_LIST_WINDOW_MS + 1], 1, now), { allowed: false, limit: 1, windowMs: PUBLIC_LIST_WINDOW_MS, retryAt: now + 1 });
  });
  it("gives the first time a slot will really be available even after a policy reduction", () => {
    assert.deepEqual(decidePublicListQuota([now - 3, now - 2, now - 1], 2, now), { allowed: false, limit: 2, windowMs: PUBLIC_LIST_WINDOW_MS, retryAt: now - 2 + PUBLIC_LIST_WINDOW_MS });
  });
  it("rejects an invalid configuration instead of silently inventing a number", () => {
    for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => decidePublicListQuota([], limit, now));
  });
  it("lets only the available parallel attempts commit when the shared author record is transactional", async () => {
    let version = 0;
    let events = [now - 100];
    let retries = 0;
    async function transaction(): Promise<boolean> {
      for (;;) {
        const readVersion = version;
        let next: number[] | null = null;
        const result = await claimPublicListQuota({ readEvents: async () => [...events], writeEvents: (value) => { next = value; } }, 3, now);
        await new Promise((resolve) => setImmediate(resolve));
        if (readVersion !== version) { retries++; continue; }
        if (next !== null) { events = next; version++; }
        return result.allowed;
      }
    }
    const results = await Promise.all(Array.from({ length: 12 }, transaction));
    assert.equal(results.filter(Boolean).length, 2);
    assert.equal(events.length, 3);
    assert.ok(retries > 0);
  });
});
