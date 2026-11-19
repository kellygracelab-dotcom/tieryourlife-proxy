import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { countToday, fitsInDay, nextDayMs } from "../src/dailyCount";
import { chargeVision, FACES_PER_DAY, VisionLimit } from "../src/visionBudget";
import { tooLongQuery, MAX_QUERY_SENT } from "../src/community";
import { install, type Fakes } from "./fakeFirebase";

const NOW = Date.UTC(2026, 10, 19, 15, 30);

let fakes: Fakes;
beforeEach(() => {
  fakes = install();
});
afterEach(() => fakes.restore());

describe("a count per account per day (QA, 19.11.2026)", () => {
  it("fits up to the limit and not past it", () => {
    assert.equal(fitsInDay(undefined, 1, 1), true);
    assert.equal(fitsInDay(9, 1, 10), true);
    assert.equal(fitsInDay(10, 1, 10), false);
    assert.equal(fitsInDay("junk", 5, 5), true);
  });

  it("counts until the limit, then refuses and counts nothing; a new day starts again", async () => {
    assert.equal(await countToday("reportUsage", "me", "reports", 1, 2, NOW), true);
    assert.equal(await countToday("reportUsage", "me", "reports", 1, 2, NOW), true);
    assert.equal(await countToday("reportUsage", "me", "reports", 1, 2, NOW), false);
    assert.deepEqual(fakes.db.get("reportUsage/2026-11-19/accounts/me"), { reports: 2 });
    assert.equal(await countToday("reportUsage", "me", "reports", 1, 2, nextDayMs(NOW)), true);
    assert.equal(await countToday("reportUsage", "you", "reports", 1, 2, NOW), true);
  });

  it("ends the day at the next UTC midnight", () => {
    assert.equal(nextDayMs(NOW), Date.UTC(2026, 10, 20));
  });

  it("lets Vision look at twenty faces a day and says when to come back", async () => {
    for (let at = 0; at < FACES_PER_DAY; at++) await chargeVision("me", "faces", 1, NOW);
    await assert.rejects(chargeVision("me", "faces", 1, NOW), (error: unknown) => error instanceof VisionLimit && error.retryAtMs === Date.UTC(2026, 10, 20));
    await chargeVision("me", "pictures", 200, NOW);
  });
});

describe("a search sent too long (QA D10)", () => {
  it("is refused past five hundred characters, whatever the script", () => {
    assert.equal(tooLongQuery("a".repeat(MAX_QUERY_SENT)), false);
    assert.equal(tooLongQuery("a".repeat(MAX_QUERY_SENT + 1)), true);
    assert.equal(tooLongQuery(["x", "😀".repeat(MAX_QUERY_SENT + 1)]), true);
    assert.equal(tooLongQuery(undefined), false);
  });
});
