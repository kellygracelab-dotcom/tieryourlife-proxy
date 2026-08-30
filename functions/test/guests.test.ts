import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ABANDONED_AFTER_MS, type GuestCandidate, decideSweep, lastSeen } from "../src/guests";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function guest(overrides: Partial<GuestCandidate> = {}): GuestCandidate {
  return { uid: "guest-1", anonymous: true, lastSeenMs: NOW, ...overrides };
}

describe("decideSweep", () => {
  it("sweeps a guest the moment the month is up", () => {
    const decision = decideSweep(guest({ lastSeenMs: NOW - ABANDONED_AFTER_MS }), NOW);

    assert.deepEqual(decision, { sweep: true });
  });

  it("keeps a guest with a millisecond of the month left", () => {
    const decision = decideSweep(guest({ lastSeenMs: NOW - ABANDONED_AFTER_MS + 1 }), NOW);

    assert.deepEqual(decision, { sweep: false, because: "still_in_use" });
  });

  // The whole point of the guest identity: it is kept and used, and the person
  // may never sign in at all. Age alone must not take it away.
  it("leaves a guest alone while the app is still being opened", () => {
    const decision = decideSweep(guest({ lastSeenMs: NOW - 29 * DAY }), NOW);

    assert.deepEqual(decision, { sweep: false, because: "still_in_use" });
  });

  // Somebody's real account, whatever it started as. This is the case that
  // would cost a person their boards, so it is checked before age.
  it("never sweeps an identity with a provider on it, however old", () => {
    const decision = decideSweep(
      guest({ anonymous: false, lastSeenMs: NOW - 10 * 365 * DAY }),
      NOW,
    );

    assert.deepEqual(decision, { sweep: false, because: "has_an_account" });
  });
});

describe("lastSeen", () => {
  it("prefers the last token refresh, which moves every time the app runs", () => {
    const at = lastSeen(
      {
        lastRefreshTime: "Fri, 29 Aug 2026 10:00:00 GMT",
        lastSignInTime: "Mon, 03 Aug 2026 10:00:00 GMT",
        creationTime: "Sat, 01 Aug 2026 10:00:00 GMT",
      },
      NOW,
    );

    assert.equal(at, Date.parse("2026-08-29T10:00:00.000Z"));
  });

  it("falls back through sign-in to creation", () => {
    const at = lastSeen(
      { lastRefreshTime: null, lastSignInTime: null, creationTime: "Sat, 01 Aug 2026 10:00:00 GMT" },
      NOW,
    );

    assert.equal(at, Date.parse("2026-08-01T10:00:00.000Z"));
  });

  // Reading a record with no timestamps as ancient would delete a live
  // identity. Reading it as new costs one day.
  it("treats a record with no timestamps as new rather than as ancient", () => {
    assert.equal(lastSeen({}, NOW), NOW);
    assert.equal(decideSweep(guest({ lastSeenMs: lastSeen({}, NOW) }), NOW).sweep, false);
  });

  it("ignores a timestamp it cannot parse", () => {
    const at = lastSeen(
      { lastRefreshTime: "not a date", creationTime: "Sat, 01 Aug 2026 10:00:00 GMT" },
      NOW,
    );

    assert.equal(at, Date.parse("2026-08-01T10:00:00.000Z"));
  });
});
