import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentReference } from "firebase-admin/firestore";
import { handlePictureWarm, pictureWarmJobId, queuePictureWarm, WARM_AT_ONCE, WARM_MOST, WARM_USER_AGENT, WARM_WIDTHS, warmPathsOf, warmPictures } from "../src/pictureWarm";

const storage = (path: string) => `https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/${encodeURIComponent(path)}?alt=media`;

describe("warming a list's small copies (Web, Coordinator, 28.11.2026)", () => {
  it("asks for the widths the site keeps", () => {
    assert.deepEqual(WARM_WIDTHS, [200, 400]);
  });

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

  it("is one job per list and revision", () => {
    assert.equal(pictureWarmJobId("L", 3), "L_3");
  });

  it("queues nothing in the emulator or with nothing to warm", async () => {
    // Would throw without a Firestore if it tried to write.
    await queuePictureWarm({ listId: "L", revision: 1, paths: ["published/L/p1"] }, true);
    await queuePictureWarm({ listId: "L", revision: 1, paths: [] }, false);
  });

  it("asks the site for every path at both widths, a few at a time, as the warm-up", async () => {
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
    const outcome = await warmPictures(["published/L/a", "published/L/b", "published/L/c", "published/L/d"], fetcher);
    assert.equal(outcome.asked, 8);
    assert.equal(outcome.ok, 8);
    assert.equal(outcome.failed, 0);
    assert.ok(most <= WARM_AT_ONCE);
    assert.ok(asked.includes("https://tieryourlife.com/img/200/published/L/a"));
    assert.ok(asked.includes("https://tieryourlife.com/img/400/published/L/d"));
    assert.deepEqual([...agents], [WARM_USER_AGENT]);
  });

  it("counts a refusal or a dropped ask as failed and goes on", async () => {
    let call = 0;
    const fetcher = (async () => {
      call++;
      if (call === 1) throw new TypeError("fetch failed");
      return new Response("", { status: call === 2 ? 404 : 200 });
    }) as typeof fetch;
    const outcome = await warmPictures(["published/L/a", "published/L/b"], fetcher, { atOnce: 1 });
    assert.deepEqual({ asked: outcome.asked, ok: outcome.ok, failed: outcome.failed }, { asked: 4, ok: 2, failed: 2 });
    assert.deepEqual(outcome.failures, ["TypeError https://tieryourlife.com/img/200/published/L/a", "404 https://tieryourlife.com/img/400/published/L/a"]);
  });

  it("gives up on a picture the site does not answer in time", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    // AbortSignal.timeout does not hold the event loop open by itself; a real ask's socket does.
    const open = setTimeout(() => undefined, 5_000);
    try {
      const outcome = await warmPictures(["published/L/a"], hanging, { waitMs: 20 });
      assert.equal(outcome.failed, 2);
    } finally {
      clearTimeout(open);
    }
  });

  it("never asks for more pictures than a job may hold", async () => {
    const outcome = await warmPictures(Array.from({ length: WARM_MOST + 5 }, (_, at) => `published/L/p${at}`), (async () => new Response("")) as typeof fetch, { atOnce: 50 });
    assert.equal(outcome.asked, WARM_MOST * WARM_WIDTHS.length);
  });

  it("does the job, logs one line and deletes it", async () => {
    let deleted = false;
    const ref = {
      get: async () => ({ data: () => ({ listId: "L", revision: 2, paths: ["published/L/a", 7] }) }),
      delete: async () => void (deleted = true),
    } as unknown as DocumentReference;
    const warmed: string[][] = [];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      await handlePictureWarm(ref, async (paths) => (warmed.push([...paths]), { asked: 2, ok: 2, failed: 0, failures: [] }));
    } finally {
      console.log = log;
    }
    assert.deepEqual(warmed, [["published/L/a"]]);
    assert.ok(deleted);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Picture warm-up \{"listId":"L","revision":2,"asked":2,"ok":2,"failed":0,"failures":\[\],"ms":\d+\}$/);
  });
});
