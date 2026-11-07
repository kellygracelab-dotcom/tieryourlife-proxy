/**
 * Just enough of Firestore, Storage and Auth, in memory, for the code that
 * erases an account and keeps or lifts bans. `install` swaps it in for
 * `getFirestore`, `getStorage` and `getAuth`; every write is logged in order.
 */
import { mock } from "node:test";
import { FieldValue } from "firebase-admin/firestore";

type Data = Record<string, unknown>;

type Swappable = Record<string, (...args: never[]) => unknown>;
const firestoreModule = require("firebase-admin/firestore") as Swappable;
const storageModule = require("firebase-admin/storage") as Swappable;
const authModule = require("firebase-admin/auth") as Swappable;

function fieldOf(data: Data, path: string): unknown {
  return path.split(".").reduce<unknown>((at, part) => (at as Data | undefined)?.[part], data);
}

function resolved(current: unknown, value: unknown): unknown {
  if (!(value instanceof FieldValue)) return value;
  if (value.isEqual(FieldValue.delete())) return undefined;
  if (value.isEqual(FieldValue.serverTimestamp())) return "serverTimestamp";
  const operand = (value as unknown as { operand?: unknown }).operand;
  if (typeof operand === "number") return (typeof current === "number" ? current : 0) + operand;
  return value;
}

function withField(data: Data, path: string, value: unknown): Data {
  const [head, ...rest] = path.split(".");
  const next = { ...data };
  if (rest.length === 0) {
    const resolvedValue = resolved(data[head], value);
    if (resolvedValue === undefined) delete next[head];
    else next[head] = resolvedValue;
    return next;
  }
  next[head] = withField((data[head] as Data | undefined) ?? {}, rest.join("."), value);
  return next;
}

export class FakeSnapshot {
  constructor(readonly ref: FakeDoc, private readonly stored: Data | undefined, readonly updateTime: number) {}
  get id(): string {
    return this.ref.id;
  }
  get exists(): boolean {
    return this.stored !== undefined;
  }
  data(): Data | undefined {
    return this.stored === undefined ? undefined : { ...this.stored };
  }
  get(field: string): unknown {
    return this.stored === undefined ? undefined : fieldOf(this.stored, field);
  }
}

export class FakeDoc {
  constructor(private readonly db: FakeDb, readonly path: string) {}
  get id(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
  collection(name: string): FakeQuery {
    return new FakeQuery(this.db, `${this.path}/${name}`);
  }
  async get(): Promise<FakeSnapshot> {
    return this.db.snapshot(this);
  }
  async set(data: Data): Promise<void> {
    this.db.write("set", this.path, Object.entries(data).reduce<Data>((at, [key, value]) => withField(at, key, value), {}));
  }
  async update(data: Data): Promise<void> {
    const current = this.db.docs.get(this.path);
    if (current === undefined) throw new Error(`No document to update: ${this.path}`);
    this.db.write("update", this.path, Object.entries(data).reduce<Data>((at, [key, value]) => withField(at, key, value), current));
  }
  async delete(_precondition?: unknown): Promise<void> {
    this.db.write("delete", this.path, undefined);
  }
}

type Filter = { field: string; op: string; value: unknown };

export class FakeQuery {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string,
    private readonly filters: Filter[] = [],
    private readonly max: number = Infinity,
  ) {}
  doc(id?: string): FakeDoc {
    return new FakeDoc(this.db, `${this.path}/${id ?? `auto${++this.db.autoIds}`}`);
  }
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.path, [...this.filters, { field, op, value }], this.max);
  }
  limit(max: number): FakeQuery {
    return new FakeQuery(this.db, this.path, this.filters, max);
  }
  select(): FakeQuery {
    return this;
  }
  async get() {
    const docs = [...this.db.docs.keys()]
      .filter((path) => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/"))
      .sort()
      .map((path) => this.db.snapshot(new FakeDoc(this.db, path)))
      .filter((doc) => this.filters.every((filter) => matches(doc.get(filter.field), filter)))
      .slice(0, this.max);
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

function matches(actual: unknown, filter: Filter): boolean {
  if (filter.op === "==") return actual === filter.value;
  if (filter.op === "<=") return typeof actual === "number" && actual <= (filter.value as number);
  throw new Error(`The fake does not know ${filter.op}`);
}

class FakeBatch {
  private readonly writes: (() => Promise<void>)[] = [];
  set(ref: FakeDoc, data: Data) {
    this.writes.push(() => ref.set(data));
    return this;
  }
  update(ref: FakeDoc, data: Data) {
    this.writes.push(() => ref.update(data));
    return this;
  }
  delete(ref: FakeDoc) {
    this.writes.push(() => ref.delete());
    return this;
  }
  async commit(): Promise<void> {
    for (const write of this.writes) await write();
  }
}

export class FakeDb {
  readonly docs = new Map<string, Data>();
  readonly log: string[] = [];
  autoIds = 0;
  private clock = 0;
  private readonly times = new Map<string, number>();

  collection(path: string): FakeQuery {
    return new FakeQuery(this, path);
  }
  doc(path: string): FakeDoc {
    return new FakeDoc(this, path);
  }
  batch(): FakeBatch {
    return new FakeBatch();
  }
  async getAll(...refs: FakeDoc[]): Promise<FakeSnapshot[]> {
    return refs.map((ref) => this.snapshot(ref));
  }
  async runTransaction<T>(work: (transaction: FakeBatch & { get: (ref: FakeDoc) => Promise<FakeSnapshot> }) => Promise<T>): Promise<T> {
    const batch = new FakeBatch() as FakeBatch & { get: (ref: FakeDoc) => Promise<FakeSnapshot> };
    batch.get = (ref) => ref.get();
    const result = await work(batch);
    await batch.commit();
    return result;
  }
  snapshot(ref: FakeDoc): FakeSnapshot {
    return new FakeSnapshot(ref, this.docs.get(ref.path), this.times.get(ref.path) ?? 0);
  }
  write(kind: string, path: string, data: Data | undefined): void {
    this.log.push(`${kind} ${path}`);
    this.times.set(path, ++this.clock);
    if (data === undefined) this.docs.delete(path);
    else this.docs.set(path, data);
  }
  /** Seeds a document without logging it. */
  seed(path: string, data: Data): void {
    this.docs.set(path, data);
  }
  get(path: string): Data | undefined {
    return this.docs.get(path);
  }
}

export interface FakeUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  providerData: { providerId: string; uid: string }[];
}

export interface Fakes {
  db: FakeDb;
  users: Map<string, FakeUser>;
  /** Every write, file removal and Auth deletion, in order. */
  log: string[];
  restore: () => void;
}

export function install(): Fakes {
  const db = new FakeDb();
  const users = new Map<string, FakeUser>();
  const log = db.log;
  const bucket = {
    name: "fake-bucket",
    async deleteFiles({ prefix }: { prefix: string }) {
      log.push(`deleteFiles ${prefix}`);
    },
    file: (name: string) => ({
      async delete() {
        log.push(`deleteFile ${name}`);
      },
    }),
  };
  const auth = {
    async getUser(uid: string) {
      const user = users.get(uid);
      if (!user) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return user;
    },
    async deleteUser(uid: string) {
      if (!users.delete(uid)) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      log.push(`deleteUser ${uid}`);
    },
  };
  const mocks = [
    mock.method(firestoreModule, "getFirestore", () => db),
    mock.method(storageModule, "getStorage", () => ({ bucket: () => bucket })),
    mock.method(authModule, "getAuth", () => auth),
  ];
  return { db, users, log, restore: () => mocks.forEach((one) => one.mock.restore()) };
}
