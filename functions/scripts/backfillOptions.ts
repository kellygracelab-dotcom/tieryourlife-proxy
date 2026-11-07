/** The flags the one-off backfills take: which project, and `--apply` to write. */
export interface BackfillOptions {
  projectId: string;
  bucket: string;
  apply: boolean;
}

export function readBackfillOptions(argv: readonly string[]): BackfillOptions | { error: string } {
  let projectId: string | null = null;
  let bucket: string | null = null;
  let apply = false;
  for (let at = 0; at < argv.length; at++) {
    const [flag, inline] = argv[at].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++at];
    if (flag === "--project") projectId = value() ?? null;
    else if (flag === "--bucket") bucket = value() ?? null;
    else if (flag === "--apply" && inline === undefined) apply = true;
    else return { error: `Unknown argument: ${argv[at]}` };
  }
  if (!projectId) return { error: "Which project? Pass --project <id>." };
  return { projectId, bucket: bucket ?? `${projectId}.firebasestorage.app`, apply };
}

/** Up to [max] lines kept to print, and how many there were in all. */
export class Samples {
  readonly lines: string[] = [];
  count = 0;
  constructor(private readonly max = 20) {}
  add(line: string): void {
    this.count++;
    if (this.lines.length < this.max) this.lines.push(line);
  }
}

/** Firestore's ceiling is 500 writes a commit; fewer keeps one stale document from holding up many. */
export const WRITES_PER_BATCH = 200;

export interface GuardedUpdate {
  ref: FirebaseFirestore.DocumentReference;
  fields: Record<string, unknown>;
  /** The document's update time when it was read: a document changed since is left alone. */
  readAt: FirebaseFirestore.Timestamp;
}

/**
 * Writes [updates] in batches, each only over the document as it was read.
 * A batch that fails is written again one by one, so one document changed
 * meanwhile leaves only itself alone; a later run picks it up.
 */
export async function writeGuarded(db: FirebaseFirestore.Firestore, updates: readonly GuardedUpdate[], log: (line: string) => void): Promise<{ written: number; leftAlone: number }> {
  let written = 0;
  let leftAlone = 0;
  for (let at = 0; at < updates.length; at += WRITES_PER_BATCH) {
    const chunk = updates.slice(at, at + WRITES_PER_BATCH);
    const batch = db.batch();
    for (const one of chunk) batch.update(one.ref, one.fields, { lastUpdateTime: one.readAt });
    try {
      await batch.commit();
      written += chunk.length;
    } catch {
      for (const one of chunk) {
        try {
          await one.ref.update(one.fields, { lastUpdateTime: one.readAt });
          written++;
        } catch (error) {
          leftAlone++;
          log(`  left alone (changed meanwhile?): ${one.ref.path}: ${String(error)}`);
        }
      }
    }
    log(`  written ${written} of ${updates.length}`);
  }
  return { written, leftAlone };
}
