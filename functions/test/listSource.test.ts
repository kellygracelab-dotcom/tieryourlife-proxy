import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { MAX_LIST_SOURCE_LABEL, readListSource } from "../src/listSource";
import { listSourceFields, toSummary } from "../src/community";

describe("a house list's source", () => {
  const source = { label: "Nix's fruit stream", url: "https://www.twitch.tv/videos/123456789" };

  it("reads a label on one line and an https page, nothing else", () => {
    assert.deepEqual(readListSource({ label: "  Nix's\n fruit   stream ", url: source.url, other: 1 }), source);
    assert.equal(readListSource(undefined), null);
    assert.equal(readListSource(null), null);
    for (const raw of [
      { label: "", url: source.url },
      { label: "x".repeat(MAX_LIST_SOURCE_LABEL + 1), url: source.url },
      { label: "Stream", url: "http://www.twitch.tv/x" },
      { label: "Stream", url: "https://user:pass@www.twitch.tv/x" },
      { label: "Stream", url: "https://www.twitch.tv:8443/x" },
      { label: "Stream", url: `https://example.com/${"a".repeat(500)}` },
      { label: "Stream" },
      { url: source.url },
      "https://www.twitch.tv/x",
      [source],
    ]) assert.equal(readListSource(raw), "invalid", JSON.stringify(raw));
    assert.deepEqual(readListSource({ label: "x".repeat(MAX_LIST_SOURCE_LABEL), url: source.url }), { label: "x".repeat(MAX_LIST_SOURCE_LABEL), url: source.url });
  });

  it("is kept when an edit leaves it out, and goes on null", () => {
    assert.deepEqual(listSourceFields(source, null), { listSource: source });
    assert.deepEqual(listSourceFields(undefined, { listSource: source }), { listSource: source });
    assert.deepEqual(listSourceFields(undefined, null), {});
    assert.deepEqual(listSourceFields(null, null), {});
    assert.ok((listSourceFields(null, { listSource: source }).listSource as FieldValue).isEqual(FieldValue.delete()));
  });

  it("is told on the list's card only when there is one", () => {
    const stored = {
      title: "Fruit", titleLower: "fruit", authorUid: "tyl-editorial", authorName: "", authorPhotoUrl: null, category: "food",
      itemCount: 1, tiers: [{ label: "S" }], items: [], coverImageUrl: null, previewImages: [], tierColors: [],
    };
    assert.deepEqual(toSummary("l", { ...stored, listSource: source } as never).listSource, source);
    assert.equal("listSource" in toSummary("l", stored as never), false);
  });
});
