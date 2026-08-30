import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAILY_GENERATION_CEILING,
  FREE_GENERATION_GRANT,
  IN_FLIGHT_LEASE_MS,
  type AccountSnapshot,
  dayKey,
  decideCarry,
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

describe("decideCarry", () => {
  const empty = { exists: false, credits: 0, inFlightUntilMs: null };
  const account = (credits: number) => ({ exists: true, credits, inFlightUntilMs: null });

  // The case this exists for: somebody used the app as a guest, then signed
  // into a Google account that already existed. The guest uid keeps the
  // balance and can never be reached again.
  it("hands a fresh account the guest's balance when it is the larger one", () => {
    const decision = decideCarry({
      destination: empty,
      destinationPurchased: 0,
      guestCredits: 4,
      guestPurchased: 0,
    });

    assert.equal(decision.credits, FREE_GENERATION_GRANT);
    assert.equal(decision.moved, false);
  });

  it("keeps the guest's balance when the account has already spent more", () => {
    const decision = decideCarry({
      destination: account(2),
      destinationPurchased: 0,
      guestCredits: 7,
      guestPurchased: 0,
    });

    assert.equal(decision.credits, 7);
    assert.equal(decision.moved, true);
  });

  // Not a sum, and this is the reason: adding the two would make signing out
  // and back in a way of printing the free grant.
  it("does not add two free grants together", () => {
    const decision = decideCarry({
      destination: account(FREE_GENERATION_GRANT),
      destinationPurchased: 0,
      guestCredits: FREE_GENERATION_GRANT,
      guestPurchased: 0,
    });

    assert.equal(decision.credits, FREE_GENERATION_GRANT);
    assert.equal(decision.moved, false);
  });

  // Bought credits are nobody's to print, so they add. The single free grant
  // is still counted once, at whichever side has more of it left.
  it("adds bought credits and counts the free grant once", () => {
    const decision = decideCarry({
      destination: account(25),
      destinationPurchased: 20,
      guestCredits: 8,
      guestPurchased: 0,
    });

    assert.equal(decision.purchased, 20);
    assert.equal(decision.credits, 28);
  });

  it("carries bought credits off a guest that paid for them", () => {
    const decision = decideCarry({
      destination: account(3),
      destinationPurchased: 0,
      guestCredits: 50,
      guestPurchased: 50,
    });

    assert.equal(decision.purchased, 50);
    assert.equal(decision.credits, 53);
  });

  it("leaves an account alone when the guest has nothing", () => {
    const decision = decideCarry({
      destination: account(6),
      destinationPurchased: 0,
      guestCredits: 0,
      guestPurchased: 0,
    });

    assert.equal(decision.credits, 6);
    assert.equal(decision.moved, false);
  });
});
