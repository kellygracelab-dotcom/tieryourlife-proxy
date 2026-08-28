import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAILY_GENERATION_CEILING,
  FREE_GENERATION_GRANT,
  IN_FLIGHT_LEASE_MS,
  type AccountSnapshot,
  dayKey,
  decideReservation,
  decideSettlement,
  startingCredits,
} from "../src/quota";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { exists: true, credits: 5, inFlightUntilMs: null, ...overrides };
}

describe("decideReservation", () => {
  it("gives a first-time caller the free grant and spends one of it", () => {
    const decision = decideReservation({
      account: account({ exists: false, credits: 0 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.deepEqual(decision, {
      outcome: "reserved",
      creditsAfter: FREE_GENERATION_GRANT - 1,
      inFlightUntilMs: NOW + IN_FLIGHT_LEASE_MS,
    });
  });

  it("refuses an empty balance", () => {
    const decision = decideReservation({
      account: account({ credits: 0 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.deepEqual(decision, { outcome: "no_credits" });
  });

  it("refuses while a reservation is still live, and says how long is left", () => {
    const decision = decideReservation({
      account: account({ inFlightUntilMs: NOW + 90_000 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.deepEqual(decision, { outcome: "busy", retryAfterSeconds: 90 });
  });

  it("ignores a lease that has run out", () => {
    const decision = decideReservation({
      account: account({ inFlightUntilMs: NOW - 1 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.equal(decision.outcome, "reserved");
  });

  // A crashed run leaves the credit spent on purpose: past the reservation we
  // cannot tell whether Gemini billed us.
  it("does not hand the credit back when a lease expires", () => {
    const decision = decideReservation({
      account: account({ credits: 4, inFlightUntilMs: NOW - 1 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.equal(decision.outcome === "reserved" && decision.creditsAfter, 3);
  });

  it("refuses everyone once the service-wide daily ceiling is reached", () => {
    const decision = decideReservation({
      account: account(),
      dailyCount: DAILY_GENERATION_CEILING,
      nowMs: NOW,
    });

    assert.deepEqual(decision, { outcome: "daily_ceiling" });
  });

  it("still reserves on the last generation below the ceiling", () => {
    const decision = decideReservation({
      account: account(),
      dailyCount: DAILY_GENERATION_CEILING - 1,
      nowMs: NOW,
    });

    assert.equal(decision.outcome, "reserved");
  });

  // The caller can act on an empty balance; the ceiling is ours to fix.
  it("reports an empty balance rather than the ceiling when both apply", () => {
    const decision = decideReservation({
      account: account({ credits: 0 }),
      dailyCount: DAILY_GENERATION_CEILING,
      nowMs: NOW,
    });

    assert.deepEqual(decision, { outcome: "no_credits" });
  });

  it("reports a live reservation ahead of an empty balance", () => {
    const decision = decideReservation({
      account: account({ credits: 0, inFlightUntilMs: NOW + 1000 }),
      dailyCount: 0,
      nowMs: NOW,
    });

    assert.equal(decision.outcome, "busy");
  });
});

describe("decideSettlement", () => {
  it("keeps the credit spent and counts the image when the generation succeeded", () => {
    assert.deepEqual(decideSettlement(true), {
      creditDelta: 0,
      dailyCountDelta: 0,
      generatedDelta: 1,
    });
  });

  it("gives the credit back and rolls the ceiling counter back on failure", () => {
    assert.deepEqual(decideSettlement(false), {
      creditDelta: 1,
      dailyCountDelta: -1,
      generatedDelta: 0,
    });
  });
});

describe("startingCredits", () => {
  it("reads the stored balance for an account that exists", () => {
    assert.equal(startingCredits(account({ credits: 3 })), 3);
  });

  it("promises the free grant to an account that does not exist yet", () => {
    assert.equal(
      startingCredits(account({ exists: false, credits: 0 })),
      FREE_GENERATION_GRANT,
    );
  });
});

describe("dayKey", () => {
  it("buckets by UTC day, not by the server's local time", () => {
    assert.equal(dayKey(Date.parse("2026-08-28T23:59:59.000Z")), "2026-08-28");
    assert.equal(dayKey(Date.parse("2026-08-29T00:00:00.000Z")), "2026-08-29");
  });
});
