import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentReference } from "firebase-admin/firestore";
import { handlePictureWarm, pictureWarmJobId, queuePictureWarm, WARM_AT_ONCE, WARM_MOST, WARM_USER_AGENT, warmAddresses, warmPathsOf, warmPictures, type WarmOutcome } from "../src/pictureWarm";

const storage = (path: string) => `https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/${encodeURIComponent(path)}?alt=media`;
const COLLAGE = "https://tieryourlife.com/img/collage/L.webp?v=123";

describe("warming a list's small copies (Web, Coordinator, 28.11.2026)", () => {
  it("takes the published pictures in any address form, each once, and nothing else", () => {
    assert.deepEqual(
      warmPathsOf([
        storage("published/L/p1"),
        "https://tieryourlife.com/img/original/published/catalogue/w-abc",
        "https://tieryourlife.web.app/img/original/published/L/p1",
        "https://image.tmdb.org/t/p/w342/a.jpg",
        storage("avatars/u/x"),
        null,
        undefined,
      ]),
      ["published/L/p1", "published/catalogue/w-abc"],
    );
  });

  it("asks as the site's pages do: the collage at both sizes first, a collage picture at 400, a card at 200 and at the duel's 800", () => {
    assert.deepEqual(warmAddresses(["published/L/a"], ["published/L/b"], COLLAGE), [
      COLLAGE,
      `${COLLAGE}${COLLAGE.includes("?") ? "&" : "?"}s=2`,
      "https://tieryourlife.com/img/400/published/L/b",
      "https://tieryourlife.com/img/200/published/L/a",
      "https://tieryourlife.com/img/800/published/L/a",
    ]);
    assert.deepEqual(warmAddresses([], [], "https://tieryourlife.com/img/collage/L.webp?v=5").slice(0, 2), ["https://tieryourlife.com/img/collage/L.webp?v=5", "https://tieryourlife.com/img/collage/L.webp?v=5&s=2"]);
    assert.deepEqual(warmAddresses([], [], null), []);
  });

  it("never asks for more pictures than a job may hold", () => {
    const many = Array.from({ length: WARM_MOST + 5 }, (_, at) => `published/L/p${at}`);
    assert.equal(warmAddresses(many, many, null).length, WARM_MOST * 3);
  });

  it("is one job per list and revision", () => {
    assert.equal(pictureWarmJobId("L", 3), "L_3");
  });

  it("queues nothing in the emulator", async () => {
    // Would throw without a Firestore if it tried to write.
    await queuePictureWarm({ listId: "L", revision: 1, cards: ["published/L/p1"], previews: [] }, true);
  });

  it("asks a few at a time, every address, as the warm-up", async () => {
    let open = 0;
    let most = 0;
    const asked: string[] = [];
    const agents = new Set<string>();
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      open++;
      most = Math.max(most, open);
      asked.push(String(url));
      agents.add(new Headers(init?.headers).get("User-Agent") ?? "");
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const addresses = Array.from({ length: 8 }, (_, at) => `https://tieryourlife.com/img/200/published/L/p${at}`);
    const outcome = await warmPictures(addresses, fetcher);
    assert.deepEqual({ asked: outcome.asked, ok: outcome.ok, failed: outcome.failed }, { asked: 8, ok: 8, failed: 0 });
    assert.ok(most <= WARM_AT_ONCE && most > 1);
    assert.deepEqual(asked.sort(), [...addresses].sort());
    assert.deepEqual([...agents], [WARM_USER_AGENT]);
  });

  it("counts a refusal or a dropped ask as failed and goes on", async () => {
    let call = 0;
    const fetcher = (async () => {
      call++;
      if (call === 1) throw new TypeError("fetch failed");
      return new Response("", { status: call === 2 ? 404 : 200 });
    }) as typeof fetch;
    const outcome = await warmPictures(["a", "b", "c"], fetcher, { atOnce: 1 });
    assert.deepEqual({ asked: outcome.asked, ok: outcome.ok, failed: outcome.failed }, { asked: 3, ok: 1, failed: 2 });
    assert.deepEqual(outcome.failures, ["TypeError a", "404 b"]);
  });

  it("gives up on an address the site does not answer in time", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    // AbortSignal.timeout does not hold the event loop open by itself; a real ask's socket does.
    const open = setTimeout(() => undefined, 5_000);
    try {
      const outcome = await warmPictures(["a"], hanging, { waitMs: 20 });
      assert.equal(outcome.failed, 1);
    } finally {
      clearTimeout(open);
    }
  });

  function job(data: Record<string, unknown>) {
    const state = { deleted: false };
    const ref = { get: async () => ({ data: () => data }), delete: async () => void (state.deleted = true) } as unknown as DocumentReference;
    return { ref, state };
  }

  async function logged(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      await run();
    } finally {
      console.log = log;
    }
    return lines;
  }

  it("does the job with the collage the list names now, logs one line and deletes it", async () => {
    const { ref, state } = job({ listId: "L", revision: 2, cards: ["published/L/a", 7], previews: ["published/L/b"] });
    const warmed: string[][] = [];
    const lines = await logged(() => handlePictureWarm(ref, {
      collageOf: async (listId) => (listId === "L" ? COLLAGE : null),
      warm: async (addresses): Promise<WarmOutcome> => (warmed.push([...addresses]), { asked: 3, ok: 3, failed: 0, failures: [] }),
    }));
    assert.deepEqual(warmed, [[COLLAGE, `${COLLAGE}&s=2`, "https://tieryourlife.com/img/400/published/L/b", "https://tieryourlife.com/img/200/published/L/a", "https://tieryourlife.com/img/800/published/L/a"]]);
    assert.ok(state.deleted);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Picture warm-up \{"listId":"L","revision":2,"collage":true,"asked":3,"ok":3,"failed":0,"failures":\[\],"ms":\d+\}$/);
  });

  it("goes on without the collage when it cannot be read, and asks nothing when there is nothing", async () => {
    const { ref, state } = job({ listId: "L", revision: 3, cards: [], previews: [] });
    let warmed = 0;
    const lines = await logged(() => handlePictureWarm(ref, {
      collageOf: async () => { throw new Error("firestore said no"); },
      warm: async () => (warmed++, { asked: 0, ok: 0, failed: 0, failures: [] }),
    }));
    assert.equal(warmed, 0);
    assert.ok(state.deleted);
    assert.match(lines[0], /"collage":false,"asked":0/);
  });
});
