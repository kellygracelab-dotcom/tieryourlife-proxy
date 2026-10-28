import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchPeople, MAX_CANDIDATES, personOf, type AuthUserLike, type Person } from "../src/people";

function user(some: Partial<AuthUserLike> & { uid: string }): AuthUserLike {
  return { disabled: false, providerData: [{ providerId: "google.com" }], ...some };
}

const person = (uid: string, name: string, email: string): Person => ({ uid, name, email, photoUrl: null });

describe("personOf", () => {
  it("takes an account signed in with a real provider, its address lower-cased", () => {
    assert.deepEqual(
      personOf(user({ uid: "u1", displayName: "Danylo K", email: "Kelly@Example.com", photoURL: "https://p/face.jpg" })),
      { uid: "u1", name: "Danylo K", email: "kelly@example.com", photoUrl: "https://p/face.jpg" },
    );
  });

  it("leaves out a guest and a switched-off account", () => {
    assert.equal(personOf(user({ uid: "guest", providerData: [] })), null);
    assert.equal(personOf(user({ uid: "off", disabled: true })), null);
  });

  it("keeps a face only at a web address, and copes with no name or address", () => {
    assert.deepEqual(personOf(user({ uid: "u2", photoURL: "http://p/face.jpg" })), { uid: "u2", name: "", email: "", photoUrl: null });
  });
});

describe("matchPeople", () => {
  const index = [
    person("a", "Danylo Kovalenko", "dk@example.com"),
    person("b", "Grace Kelly", "kellygrace@example.com"),
    person("c", "Oleh", "danger@example.com"),
  ];

  it("finds a name, any word of it, or an address by its start, without caring about case", () => {
    assert.deepEqual(matchPeople(index, "DAN").map((one) => one.uid), ["a", "c"]);
    assert.deepEqual(matchPeople(index, "kel").map((one) => one.uid), ["b"]);
    assert.deepEqual(matchPeople(index, "kov").map((one) => one.uid), ["a"]);
  });

  it("asks nothing for fewer than two characters, or for something that is not text", () => {
    assert.deepEqual(matchPeople(index, "d"), []);
    assert.deepEqual(matchPeople(index, "  "), []);
    assert.deepEqual(matchPeople(index, undefined), []);
  });

  it("finds nobody by the middle of a word", () => {
    assert.deepEqual(matchPeople(index, "len"), []);
  });

  it("stops at ten", () => {
    const many = Array.from({ length: 30 }, (_, at) => person(`u${at}`, `Anna ${at}`, `anna${at}@example.com`));
    assert.equal(matchPeople(many, "an").length, MAX_CANDIDATES);
  });
});
