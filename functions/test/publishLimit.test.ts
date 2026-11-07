import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimListSlot, type AuthorSlot } from "../src/publishLimit";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Firestore as far as the limit cares: a transaction is retried when a
 * document it read changed before it committed, while a count notices no
 * list added meanwhile.
 */
class FakeStore {
  lockVersion = 0;
  retries = 0;

  constructor(public lists: number) {}

  async publish(useSlot: boolean, limit = 50): Promise<boolean> {
    for (;;) {
      let lockSeen: number | null = null;
      let lockWritten = false;
      const slot: AuthorSlot = {
        readLock: async () => {
          await tick();
          lockSeen = this.lockVersion;
        },
        countLists: async () => {
          await tick();
          return this.lists;
        },
        writeLock: () => {
          lockWritten = true;
        },
      };
      const claimed = useSlot ? await claimListSlot(slot, limit) : (await slot.countLists()) < limit;
      await tick();
      if (lockSeen !== null && lockSeen !== this.lockVersion) {
        this.retries++;
        continue;
      }
      if (lockWritten) this.lockVersion++;
      if (claimed) this.lists++;
      return claimed;
    }
  }
}

describe("claimListSlot", () => {
  it("refuses at the limit and takes a slot below it", async () => {
    assert.equal(await new FakeStore(50).publish(true), false);
    assert.equal(await new FakeStore(49).publish(true), true);
  });

  it("lets one of twenty parallel publishes through at 49 lists", async () => {
    const store = new FakeStore(49);
    const answers = await Promise.all(Array.from({ length: 20 }, () => store.publish(true)));
    assert.equal(answers.filter(Boolean).length, 1);
    assert.equal(store.lists, 50);
    assert.ok(store.retries > 0);
  });

  it("never goes past the limit from further below", async () => {
    const store = new FakeStore(40);
    const answers = await Promise.all(Array.from({ length: 30 }, () => store.publish(true)));
    assert.equal(answers.filter(Boolean).length, 10);
    assert.equal(store.lists, 50);
  });

  it("is needed: counting alone lets parallel publishes past the limit", async () => {
    const store = new FakeStore(49);
    await Promise.all(Array.from({ length: 20 }, () => store.publish(false)));
    assert.ok(store.lists > 50);
  });
});
