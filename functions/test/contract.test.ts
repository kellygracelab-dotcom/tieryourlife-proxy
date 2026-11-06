/**
 * CONTRACT.md has to name every path the routers answer. The routers are
 * plain `if` chains, so the words they match on are read from their own
 * source: every string a path segment or a query value is compared with,
 * directly or through a constant or a list of known words. A word the
 * routers learn that the contract does not mention fails here.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// Compiled to functions/lib-test/test.
const SRC = join(__dirname, "..", "..", "src");
const contract = readFileSync(join(__dirname, "..", "..", "..", "CONTRACT.md"), "utf-8");
const sources = Object.fromEntries(readdirSync(SRC).map((file) => [file, readFileSync(join(SRC, file), "utf-8").replace(/\r\n/g, "\n")]));
const everything = Object.values(sources).join("\n");

/** The routers: each HTTP function's handler, and every `route*` function it hands a subtree to. */
const ROUTERS: [file: string, start: RegExp][] = [
  ["community.ts", /export const lists = onRequest\(/],
  ["boards.ts", /export const boards = onRequest\(/],
  ["tmdb.ts", /export const tmdb = onRequest\(/],
  ...Object.entries(sources).flatMap(([file, text]) =>
    [...text.matchAll(/^(?:export )?async function (route\w+)\(/gm)].map(
      (match): [string, RegExp] => [file, new RegExp(`async function ${match[1]}\\(`)],
    ),
  ),
];

function bodyOf(file: string, start: RegExp): string {
  const text = sources[file];
  const at = text.search(start);
  assert.ok(at >= 0, `${start} not found in ${file}`);
  const end = text.slice(at).search(/\n(\}|\);)\n/);
  return text.slice(at, at + end);
}

function constant(name: string): string[] {
  const single = new RegExp(`const ${name}(?:: [\\w<>]+)? = "([^"]+)"`).exec(everything);
  if (single) return [single[1]];
  const list = new RegExp(`const ${name}(?:: [^=]+)? = \\[([^\\]]*)\\]`).exec(everything);
  assert.ok(list, `the router compares with ${name}, which this test cannot read`);
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function wordsOf(body: string): Set<string> {
  const words = new Set<string>();
  const segment = /(?<!typeof )\b(?:first|second|extra|id|last|verb|part|rest(?:\[\d\])?|segments\[\d\]|(?:request\.)?query\.\w+)/.source;
  for (const match of body.matchAll(new RegExp(`${segment} [!=]== (?:"([^"]+)"|([A-Z][A-Z_]+)\\b)`, "g"))) {
    (match[1] !== undefined ? [match[1]] : constant(match[2])).forEach((word) => words.add(word));
  }
  for (const match of body.matchAll(/\b([A-Z][A-Z_]+)\.(?:includes|find)\(/g)) {
    constant(match[1]).forEach((word) => words.add(word));
  }
  // Methods are the contract's too, but as words of their own; empty segments are no word.
  return new Set([...words].filter((word) => !/^[A-Z]+$/.test(word) && word.length > 0));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("CONTRACT.md", () => {
  it("names every HTTP function the proxy exports", () => {
    const exported = [...sources["index.ts"].matchAll(/export \{ (\w+) \}/g)].map((match) => match[1]);
    assert.ok(exported.length >= 10);
    for (const name of exported) {
      assert.match(contract, new RegExp(`\`${name}\``), `${name} is exported but not in CONTRACT.md`);
    }
  });

  it("reads the routers' words at all", () => {
    const words = new Set(ROUTERS.flatMap(([file, start]) => [...wordsOf(bodyOf(file, start))]));
    for (const known of ["reports", "takedown", "proposals", "approve-as-topic", "keep", "quick", "account", "/3/search/multi"]) {
      assert.ok(words.has(known), `the extraction no longer finds "${known}"`);
    }
  });

  for (const [file, start] of ROUTERS) {
    it(`names every path word the router at ${start.source.replace(/\\/g, "")} answers`, () => {
      const words = wordsOf(bodyOf(file, start));
      const missing = [...words].filter((word) =>
        word.includes("/") ? !contract.includes(word) : !new RegExp(`[/=]${escape(word)}(?![\\w-])`).test(contract),
      );
      assert.deepEqual(missing, [], `${file}: in the router but not in CONTRACT.md as /word or =word`);
    });
  }
});
