import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

interface IndexField {
  fieldPath: string;
  order?: string;
}

interface Index {
  collectionGroup: string;
  fields: IndexField[];
}

// Compiled to functions/lib-test/test, three levels below the repository root.
const indexes = (JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "firestore.indexes.json"), "utf-8")) as {
  indexes: Index[];
}).indexes;

function declared(collectionGroup: string, fields: [string, string][]): boolean {
  return indexes.some(
    (index) =>
      index.collectionGroup === collectionGroup &&
      index.fields.length === fields.length &&
      index.fields.every((field, at) => field.fieldPath === fields[at][0] && field.order === fields[at][1]),
  );
}

describe("indexes the section counts need", () => {
  // A range on updatedAt reads the index ascending; the descending one the feed uses does not serve it,
  // and without it GET lists/sections answered 503 for everybody.
  it("counts a section's lists of the week", () => {
    assert.ok(declared("publishedLists", [["category", "ASCENDING"], ["updatedAt", "ASCENDING"]]));
  });

  it("counts the ones of them under review", () => {
    assert.ok(
      declared("publishedLists", [
        ["category", "ASCENDING"],
        ["underReview", "ASCENDING"],
        ["updatedAt", "ASCENDING"],
      ]),
    );
  });
});
