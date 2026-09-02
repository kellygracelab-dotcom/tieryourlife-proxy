import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Ban, banFrom, isBanLength, isBanned, noticeFor } from "../src/bans";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("banFrom", () => {
  it("counts a week as seven days from now", () => {
    assert.equal(banFrom("week", NOW, null).until, NOW + 7 * DAY);
  });

  // A length of time, not a date in a diary: "a month" from the 31st that
  // quietly becomes the 3rd is a worse answer than thirty days.
  it("counts the longer ones in days too", () => {
    assert.equal(banFrom("month", NOW, null).until, NOW + 30 * DAY);
    assert.equal(banFrom("three_months", NOW, null).until, NOW + 90 * DAY);
    assert.equal(banFrom("six_months", NOW, null).until, NOW + 180 * DAY);
  });

  it("has no end at all for forever", () => {
    assert.equal(banFrom("forever", NOW, null).until, null);
  });

  it("remembers what it was for", () => {
    assert.equal(banFrom("week", NOW, "sexual").reason, "sexual");
  });
});

describe("isBanned", () => {
  const week: Ban = { until: NOW + 7 * DAY, bannedAt: NOW, reason: null };

  it("is nobody when there is no ban", () => {
    assert.equal(isBanned(null, NOW), false);
  });

  it("stands while there is time left on it", () => {
    assert.equal(isBanned(week, NOW + DAY), true);
  });

  // Decided when somebody tries to publish rather than by a sweep, so a job
  // that has not run cannot keep somebody banned past their time.
  it("lifts itself the moment it runs out", () => {
    assert.equal(isBanned(week, NOW + 7 * DAY), false);
    assert.equal(isBanned(week, NOW + 8 * DAY), false);
  });

  it("never lifts when it has no end", () => {
    const forever: Ban = { until: null, bannedAt: NOW, reason: null };

    assert.equal(isBanned(forever, NOW + 3650 * DAY), true);
  });
});

describe("isBanLength", () => {
  it("takes the five lengths and nothing else", () => {
    assert.equal(isBanLength("week"), true);
    assert.equal(isBanLength("forever"), true);
    assert.equal(isBanLength("fortnight"), false);
    assert.equal(isBanLength(7), false);
    assert.equal(isBanLength(null), false);
  });
});

describe("noticeFor", () => {
  // The app says "until the 10th" rather than only "no": a refusal without a
  // date is a refusal somebody retries every day.
  it("carries the date so the app can name it", () => {
    assert.deepEqual(noticeFor({ until: NOW + DAY, bannedAt: NOW, reason: "sexual" }), {
      code: "BANNED",
      until: NOW + DAY,
    });
  });

  it("carries nothing to name when there is no end", () => {
    assert.deepEqual(noticeFor({ until: null, bannedAt: NOW, reason: null }), {
      code: "BANNED",
      until: null,
    });
  });
});
