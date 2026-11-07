import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  banOfRecord,
  identityKeys,
  liveBan,
  longerBan,
  recordToKeep,
  signInsOfToken,
} from "../src/banIdentities";
import { banFrom, isBanned, type Ban } from "../src/bans";

const NOW = Date.parse("2026-11-07T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The same Google account: as its new ID token names it, and as Auth held it before the erasure.
const token = { "google.com": ["104729"], email: ["someone@gmail.com"] };
const authRecord = { email: "someone@gmail.com", emailVerified: true, providerData: [{ providerId: "google.com", uid: "104729" }] };

describe("identityKeys", () => {
  it("names the same person the same way from a new account's token and from the erased account's record", () => {
    const fromToken = identityKeys("someone@gmail.com", signInsOfToken(token));
    const fromRecord = identityKeys(authRecord.emailVerified ? authRecord.email : null, authRecord.providerData);
    assert.deepEqual([...fromToken].sort(), [...fromRecord].sort());
    assert.equal(fromToken.length, 2);
  });

  it("is a SHA-256 of `email:<address>` and `<provider>:<id>`, never the address itself", () => {
    const keys = identityKeys(" Someone@Gmail.com ", [{ providerId: "google.com", uid: "104729" }]);
    assert.deepEqual(keys, [sha256("email:someone@gmail.com"), sha256("google.com:104729")]);
    assert.ok(keys.every((key) => /^[0-9a-f]{64}$/.test(key)));
  });

  it("leaves out an address nobody verified, and a password account's own id, which is that address", () => {
    assert.deepEqual(identityKeys(null, [{ providerId: "password", uid: "someone@gmail.com" }]), []);
    assert.deepEqual(identityKeys(null, signInsOfToken({ email: ["someone@gmail.com"] })), []);
  });

  it("reads nothing from a token without identities", () => {
    assert.deepEqual(signInsOfToken(undefined), []);
    assert.deepEqual(signInsOfToken({ "google.com": "104729" }), []);
  });
});

describe("a ban kept past an erased account", () => {
  const week = banFrom("week", NOW, "spam");

  // QA S12: X erased the banned account, signed in again with the same Google account and published.
  it("bans the new account of the same person until the old ban lifts", () => {
    const kept = banOfRecord(recordToKeep(null, week));
    const ban = liveBan([null, kept], NOW + DAY);
    assert.ok(isBanned(ban, NOW + DAY));
    assert.equal(ban?.until, week.until);
    assert.equal(liveBan([null, kept], NOW + 7 * DAY), null);
  });

  it("keeps when it began and when it lifts, and nothing else", () => {
    assert.deepEqual(recordToKeep(null, week), { until: week.until, bannedAt: NOW });
  });

  it("keeps the longer of two bans on one person", () => {
    const forever = banFrom("forever", NOW - DAY, null);
    assert.equal(recordToKeep(forever, week).until, null);
    assert.equal(recordToKeep(banFrom("week", NOW - 3 * DAY, null), banFrom("month", NOW, null)).until, NOW + 30 * DAY);
    assert.equal(longerBan(week, forever), forever);
  });

  it("reads the account's own ban and a kept one alike, the longest in force winning", () => {
    const own: Ban = { until: NOW + DAY, bannedAt: NOW, reason: "spam" };
    assert.equal(liveBan([own, banOfRecord({ until: null, bannedAt: NOW })], NOW)?.until, null);
    assert.equal(liveBan([own, null], NOW), own);
    assert.equal(liveBan([null, null], NOW), null);
  });

  it("reads a record that is not one as no ban", () => {
    assert.equal(banOfRecord({ until: "soon", bannedAt: NOW }), null);
    assert.equal(banOfRecord({ until: null }), null);
    assert.equal(banOfRecord(undefined), null);
  });
});
