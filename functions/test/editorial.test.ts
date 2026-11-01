import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bylineOf, decideEditorialAccess, EDITORIAL_UID, editorialByline } from "../src/editorial";

describe("EDITORIAL_UID", () => {
  // Firebase uids are 28 characters of letters and digits; this can never be one,
  // so no sign-in becomes the house and no account deletion reaches its lists.
  it("is not something Auth could hand out", () => {
    assert.notEqual(EDITORIAL_UID.length, 28);
    assert.match(EDITORIAL_UID, /-/);
  });
});

describe("editorialByline", () => {
  it("is the house: anonymous, with no name and no face, and remembers who spoke for it", () => {
    assert.deepEqual(editorialByline("moderator"), { uid: EDITORIAL_UID, name: "", photoUrl: null, speaker: "moderator" });
  });
});

describe("bylineOf", () => {
  it("is the person publishing, Anonymous while they have no name", () => {
    const identity = { uid: "u1", isAnonymous: false, name: null, picture: "https://p/face.jpg", email: null };
    assert.deepEqual(bylineOf(identity), { uid: "u1", name: "Anonymous", photoUrl: "https://p/face.jpg", speaker: null });
  });
});

describe("decideEditorialAccess", () => {
  it("lets the owner in", () => {
    assert.deepEqual(decideEditorialAccess("owner"), { ok: true, speaker: "owner" });
  });

  it("lets a moderator in", () => {
    assert.deepEqual(decideEditorialAccess("moderator"), { ok: true, speaker: "moderator" });
  });

  it("turns anybody else away", () => {
    assert.deepEqual(decideEditorialAccess(null), { ok: false });
  });
});
