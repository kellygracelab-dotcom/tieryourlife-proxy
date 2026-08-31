import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideSafe,
  isPictureId,
  MAX_OWN_PICTURES_PER_LIST,
  type Likelihood,
} from "../src/safety";

const verdict = (adult: Likelihood, racy: Likelihood = "VERY_UNLIKELY", violence: Likelihood = "VERY_UNLIKELY") => ({
  adult,
  racy,
  violence,
});

describe("decideSafe", () => {
  it("lets an ordinary photograph through", () => {
    assert.deepEqual(decideSafe(verdict("VERY_UNLIKELY")), { ok: true });
  });

  it("refuses adult content at likely, one step before certainty", () => {
    assert.deepEqual(decideSafe(verdict("LIKELY")), { ok: false, because: "adult" });
    assert.deepEqual(decideSafe(verdict("VERY_LIKELY")), { ok: false, because: "adult" });
  });

  it("still allows what Vision only thinks is possible", () => {
    assert.deepEqual(decideSafe(verdict("POSSIBLE")), { ok: true });
  });

  // Racy fires on swimwear and on half the film posters ever printed, so it
  // has to be one step laxer or a board of beach photographs stops publishing.
  it("allows racy until Vision is sure", () => {
    assert.deepEqual(decideSafe(verdict("VERY_UNLIKELY", "LIKELY")), { ok: true });
    assert.deepEqual(decideSafe(verdict("VERY_UNLIKELY", "VERY_LIKELY")), {
      ok: false,
      because: "racy",
    });
  });

  it("refuses gore on the same footing as adult", () => {
    assert.deepEqual(decideSafe(verdict("VERY_UNLIKELY", "VERY_UNLIKELY", "LIKELY")), {
      ok: false,
      because: "violence",
    });
  });

  // A picture Vision could not judge is not a picture it judged badly. Refusing
  // on UNKNOWN would refuse everything the moment the API had a bad minute.
  it("passes what Vision could not judge", () => {
    assert.deepEqual(decideSafe(verdict("UNKNOWN", "UNKNOWN", "UNKNOWN")), { ok: true });
  });

  // Naming which one, because the person is told what to take out.
  it("names adult first when a picture is several things at once", () => {
    assert.deepEqual(decideSafe(verdict("VERY_LIKELY", "VERY_LIKELY", "VERY_LIKELY")), {
      ok: false,
      because: "adult",
    });
  });
});

describe("isPictureId", () => {
  it("takes the names the app gives its pictures", () => {
    assert.equal(isPictureId("e9529ec5-98dc-425d-b6fc-f6a624f621be"), true);
  });

  it("refuses a name that could climb out of its folder", () => {
    assert.equal(isPictureId("../../secrets"), false);
    assert.equal(isPictureId("a/b"), false);
    assert.equal(isPictureId(""), false);
    assert.equal(isPictureId(42), false);
  });
});

describe("MAX_OWN_PICTURES_PER_LIST", () => {
  // Far past a hand-assembled board, and short of a bill.
  it("is far enough past any real board", () => {
    assert.equal(MAX_OWN_PICTURES_PER_LIST, 200);
  });
});
