import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { AUDIT_ACTIONS, auditEntry, auditTargetsOf, changedFields, withoutNames } from "../src/audit";

describe("AUDIT_ACTIONS", () => {
  it("names every kind of decision the owner and the moderators make", () => {
    for (const what of [
      "section.approve",
      "section.decline",
      "section.merge",
      "section.create",
      "section.edit",
      "section.order",
      "section.delete",
      "topic.create",
      "topic.edit",
      "topic.merge",
      "topic.delete",
      "topic.approve",
      "topic.reject",
      "moderator.appoint",
      "moderator.remove",
      "report.takedown",
      "report.dismiss",
      "ban.set",
    ]) {
      assert.ok((AUDIT_ACTIONS as readonly string[]).includes(what), what);
    }
  });
});

describe("changedFields", () => {
  it("keeps only the fields that change, each side with just those", () => {
    const before = { name: "Ramen", icon: "local_cafe", rank: null, status: "pending" };
    assert.deepEqual(changedFields(before, { name: "Noodles", icon: "local_cafe", status: "approved" }), {
      before: { name: "Ramen", status: "pending" },
      after: { name: "Noodles", status: "approved" },
    });
  });

  it("leaves out server timestamps, increments and bookkeeping", () => {
    const after = {
      status: "approved",
      decidedAt: FieldValue.serverTimestamp(),
      listCount: FieldValue.increment(1),
      unfinished: true,
      proposalPictureUrl: null,
      nameLower: "ramen",
    };
    assert.deepEqual(changedFields({ status: "pending", proposalPictureUrl: "https://x?token=t" }, after), {
      before: { status: "pending" },
      after: { status: "approved" },
    });
  });

  it("compares nested values by what they hold", () => {
    const tint = { light: "#7A4A33", dark: "#5F3D2D" };
    assert.deepEqual(changedFields({ tint }, { tint: { ...tint } }), { before: null, after: null });
    assert.deepEqual(changedFields({ tint }, { tint: { ...tint, dark: "#000000" } }).after, { tint: { ...tint, dark: "#000000" } });
  });

  it("says nothing changed when nothing did", () => {
    assert.deepEqual(changedFields({ name: "Ramen" }, { name: "Ramen" }), { before: null, after: null });
  });

  it("has no before for something new, and null for a field that was missing", () => {
    assert.deepEqual(changedFields(null, { name: "Ramen" }), { before: null, after: { name: "Ramen" } });
    assert.deepEqual(changedFields({}, { hidden: true }), { before: { hidden: null }, after: { hidden: true } });
  });
});

describe("auditEntry", () => {
  it("is who, in which role, did what to which document, from what to what", () => {
    assert.deepEqual(auditEntry("mod", "moderator", "topic.approve", "topics/t1", { status: "pending" }, { status: "approved" }), {
      who: "mod",
      role: "moderator",
      what: "topic.approve",
      target: "topics/t1",
      before: { status: "pending" },
      after: { status: "approved" },
    });
  });
});

describe("erasing a person from the log", () => {
  it("finds the lines made about them as a moderator and as somebody banned", () => {
    assert.deepEqual(auditTargetsOf("u1"), ["roles/u1", "bans/u1"]);
  });

  it("takes their name out of a side and keeps everything else, the uid bans need included", () => {
    assert.deepEqual(withoutNames({ moderator: true, name: "Danylo" }), { moderator: true });
    assert.deepEqual(withoutNames({ until: null, reason: "spam" }), { until: null, reason: "spam" });
    assert.equal(withoutNames(null), null);
  });
});
