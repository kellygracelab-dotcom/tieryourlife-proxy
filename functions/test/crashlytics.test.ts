import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as firestoreModule from "firebase-admin/firestore";
import { androidTables, crashDaysOf, crashSql, importCrashlytics, waitingStateOf } from "../src/crashlytics";

const NOW = Date.parse("2026-11-21T03:00:00Z");

function fakeFirestore() {
  const written = new Map<string, Record<string, unknown>>();
  const doc = (id: string) => ({
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => void written.set(id, options?.merge ? { ...(written.get(id) ?? {}), ...data } : data),
  });
  const firestore = {
    collection: () => ({ doc }),
    batch: () => {
      const held: [string, Record<string, unknown>][] = [];
      return {
        set: (ref: { id?: string } & ReturnType<typeof doc>, data: Record<string, unknown>) => void held.push([(ref as unknown as { __id: string }).__id, data]),
        commit: async () => held.forEach(([id, data]) => written.set(id, data)),
      };
    },
  };
  // Batch writes need the document's id: hand it back on the reference.
  firestore.collection = () => ({ doc: (id: string) => ({ ...doc(id), __id: id }) });
  mock.method(firestoreModule, "getFirestore", () => firestore);
  return written;
}

describe("Crashlytics import (20.11.2026)", () => {
  afterEach(() => mock.restoreAll());

  it("waits, not fails, without the dataset or the roles", () => {
    assert.equal(waitingStateOf(404), "waiting_for_dataset");
    assert.equal(waitingStateOf(403), "waiting_for_access");
    assert.equal(waitingStateOf(500), null);
  });

  it("reads the Android batch tables only", () => {
    const body = { tables: [{ tableReference: { tableId: "com_tieryourlife_app_ANDROID" } }, { tableReference: { tableId: "com_tieryourlife_app_ANDROID_REALTIME" } }, { tableReference: { tableId: "x_IOS" } }] };
    assert.deepEqual(androidTables(body), ["com_tieryourlife_app_ANDROID"]);
    assert.deepEqual(androidTables(null), []);
  });

  it("asks by error type where the export has it, by is_fatal where it does not", () => {
    assert.match(crashSql("t_ANDROID", true), /COALESCE\(error_type/);
    assert.doesNotMatch(crashSql("t_ANDROID", false), /error_type/);
    assert.match(crashSql("t_ANDROID", false), /`tieryourlife\.firebase_crashlytics\.t_ANDROID`/);
  });

  it("turns rows into days of totals and issues, the most frequent first", () => {
    const row = (...values: unknown[]) => ({ f: values.map((v) => ({ v })) });
    const days = crashDaysOf([
      row("2026-11-20", "FATAL", "", "", "", "", "5", "3"),
      row("2026-11-20", "ANR", "", "", "", "", "2", "2"),
      row("2026-11-20", "FATAL", "a1", "BoardScreen", "render", "1.4.2", "1", "1"),
      row("2026-11-20", "FATAL", "b2", "Duel", "next", "1.4.2", "4", "2"),
    ]);
    assert.equal(days.length, 1);
    assert.deepEqual(days[0]!.totals, { FATAL: { events: 5, installs: 3 }, ANR: { events: 2, installs: 2 } });
    assert.deepEqual(days[0]!.issues.map((issue) => issue.id), ["b2", "a1"]);
  });

  it("notes the wait and stops when the dataset is not there yet", async () => {
    const written = fakeFirestore();
    const asked: string[] = [];
    const state = await importCrashlytics(NOW, async (path) => (asked.push(path), { status: 404, body: null }));
    assert.equal(state, "waiting_for_dataset");
    assert.equal(asked.length, 1);
    assert.equal(written.get("_status")!.state, "waiting_for_dataset");
  });

  it("notes the wait when the query is refused for want of a role", async () => {
    const written = fakeFirestore();
    const state = await importCrashlytics(NOW, async (path) =>
      path.endsWith("tables?maxResults=100") ? { status: 200, body: { tables: [{ tableReference: { tableId: "app_ANDROID" } }] } }
        : path.startsWith("datasets/") ? { status: 200, body: { schema: { fields: [{ name: "is_fatal" }] } } }
        : { status: 403, body: null },
    );
    assert.equal(state, "waiting_for_access");
    assert.equal(written.get("_status")!.state, "waiting_for_access");
  });

  it("writes every day it read, an empty one too, and says it is ready", async () => {
    const written = fakeFirestore();
    const row = (...values: unknown[]) => ({ f: values.map((v) => ({ v })) });
    const state = await importCrashlytics(NOW, async (path) =>
      path.endsWith("tables?maxResults=100") ? { status: 200, body: { tables: [{ tableReference: { tableId: "app_ANDROID" } }] } }
        : path.startsWith("datasets/") ? { status: 200, body: { schema: { fields: [{ name: "error_type" }] } } }
        : { status: 200, body: { jobComplete: true, rows: [row("2026-11-20", "FATAL", "", "", "", "", "1", "1")] } },
    );
    assert.equal(state, "ready");
    assert.deepEqual([...written.keys()].filter((id) => id !== "_status").sort(), ["2026-11-18", "2026-11-19", "2026-11-20"]);
    assert.deepEqual(written.get("2026-11-20")!.totals, { FATAL: { events: 1, installs: 1 } });
    assert.deepEqual(written.get("2026-11-19")!.totals, {});
    assert.equal(written.get("_status")!.lastDay, "2026-11-20");
  });

  it("never throws: anything else is noted as failed for tomorrow", async () => {
    fakeFirestore();
    mock.method(console, "warn", () => undefined);
    assert.equal(await importCrashlytics(NOW, async () => ({ status: 500, body: null })), "failed");
    assert.equal(await importCrashlytics(NOW, async () => { throw new Error("offline"); }), "failed");
  });
});
