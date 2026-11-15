import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeNames, readSectionEdits } from "../src/sections";
import { decideTopicEdit } from "../src/topics";

// Content's report of 15.11.2026: the site's topic editor sends only the
// languages it changed, and saving German alone wiped every other language.
describe("translations laid over the stored ones", () => {
  const stored = { uk: "Піксар", de: "Pixar Filme", fr: "Films Pixar" };

  it("replaces the languages sent and keeps the others", () => {
    assert.deepEqual(mergeNames(stored, { de: "Pixar-Filme" }), { uk: "Піксар", de: "Pixar-Filme", fr: "Films Pixar" });
    assert.deepEqual(mergeNames(stored, { es: "Películas de Pixar" }), { ...stored, es: "Películas de Pixar" });
  });

  it("takes a language away when it is sent empty or null", () => {
    assert.deepEqual(mergeNames(stored, { de: "", fr: null }), { uk: "Піксар" });
    assert.deepEqual(mergeNames(stored, { ja: "" }), stored);
  });

  it("changes nothing for an empty set and refuses what readNames refuses", () => {
    assert.deepEqual(mergeNames(stored, {}), stored);
    assert.equal(mergeNames(stored, { xx: "Pixar" }), null);
    assert.equal(mergeNames(stored, "Pixar"), null);
    assert.equal(mergeNames(stored, ["Pixar"]), null);
  });

  it("is how a topic edit reads translations", () => {
    const topic = { status: "approved" as const, names: stored };
    assert.deepEqual(decideTopicEdit(topic, { names: { de: "Pixar-Filme" } }), { ok: true, names: { ...stored, de: "Pixar-Filme" } });
    assert.deepEqual(decideTopicEdit(topic, { names: { uk: "" } }), { ok: true, names: { de: "Pixar Filme", fr: "Films Pixar" } });
    assert.deepEqual(decideTopicEdit(topic, { names: { de: "!" } }), { ok: false, reason: "bad_name", detail: "names", locale: "de" });
  });

  it("is how a section edit reads translations, and a new section takes them as sent", () => {
    const merged = readSectionEdits({ names: { de: "Straßenessen" } }, ["names"], { uk: "Вулична їжа", de: "Imbiss" });
    assert.deepEqual(merged.ok && merged.edits.names, { uk: "Вулична їжа", de: "Straßenessen" });
    const fresh = readSectionEdits({ names: { de: "Straßenessen", fr: "" } }, ["names"]);
    assert.deepEqual(fresh.ok && fresh.edits.names, { de: "Straßenessen" });
  });
});
