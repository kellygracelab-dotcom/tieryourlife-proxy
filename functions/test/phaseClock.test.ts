import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseClock } from "../src/phaseClock";

test("each stage counts from the one before, and the whole from the start", () => {
  const times = [1000, 1040, 1300, 1310];
  const clock = phaseClock(() => times.shift()!);
  clock.mark("read");
  clock.mark("pictures");
  clock.mark("written");
  assert.deepEqual(clock.stages(), { read: 40, pictures: 260, written: 10, total: 310 });
});

test("a stage marked twice adds up", () => {
  const times = [0, 5, 7, 20];
  const clock = phaseClock(() => times.shift()!);
  clock.mark("a");
  clock.mark("b");
  clock.mark("a");
  assert.deepEqual(clock.stages(), { a: 18, b: 2, total: 20 });
});
