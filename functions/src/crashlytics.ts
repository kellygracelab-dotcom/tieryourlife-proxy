import { applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { addDays, dayOf, daysFrom, type Day } from "./statsKeys";

/**
 * Google's own crash numbers for the admin screen (20.11.2026): Crashlytics' daily export to BigQuery
 * (`firebase_crashlytics`, US, batch only, no sessions), read once a night by `sweepGuests` and kept
 * as daily sums in `statsCrashlytics/{day}`. Only counts, issue titles (a class and method) and app
 * versions are kept; no installation id, user or device leaves BigQuery.
 *
 * Until the dataset exists or the functions' account has BigQuery Data Viewer and Job User, every run
 * notes why in `statsCrashlytics/_status` and stops quietly: no error line, no alert.
 */

export const STATS_CRASHLYTICS = "statsCrashlytics";
export const STATUS_DOC = "_status";
const PROJECT = "tieryourlife";
const DATASET = "firebase_crashlytics";
const LOCATION = "US";
/** A late export is counted again: the last few days are read every night. */
export const DAYS_READ = 3;
const ISSUES_PER_DAY = 50;

export type CrashlyticsState = "waiting_for_dataset" | "waiting_for_access" | "ready" | "failed";

export interface CrashDay {
  day: Day;
  /** Per kind (FATAL crashes, ANR, NON_FATAL): events and distinct installs that day. */
  totals: Record<string, { events: number; installs: number }>;
  issues: { id: string; title: string; subtitle: string; kind: string; version: string; events: number; installs: number }[];
}

type Ask = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

async function bigQuery(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  const { access_token: token } = await applicationDefault().getAccessToken();
  const reply = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: reply.status, body: await reply.json().catch(() => null) };
}

/** The state a refusal from BigQuery means; null when it is not one of the waiting ones. */
export function waitingStateOf(status: number): CrashlyticsState | null {
  if (status === 404) return "waiting_for_dataset";
  if (status === 401 || status === 403) return "waiting_for_access";
  return null;
}

/** The batch tables of the Android app: `<package>_ANDROID`, not the realtime ones. */
export function androidTables(body: unknown): string[] {
  const tables = ((body as { tables?: { tableReference?: { tableId?: string } }[] } | null)?.tables ?? [])
    .map((table) => table.tableReference?.tableId ?? "")
    .filter((id) => /_ANDROID$/.test(id) && !/REALTIME/.test(id));
  return [...new Set(tables)].sort();
}

/** The SQL that counts one table's last days, by kind of error. Older exports have only `is_fatal`. */
export function crashSql(table: string, hasErrorType: boolean): string {
  const kind = hasErrorType ? "COALESCE(error_type, IF(is_fatal, 'FATAL', 'NON_FATAL'))" : "IF(is_fatal, 'FATAL', 'NON_FATAL')";
  return `
WITH events AS (
  SELECT DATE(event_timestamp) AS day, ${kind} AS kind, issue_id, issue_title, issue_subtitle,
         COALESCE(application.build_version, application.display_version) AS version, installation_uuid
  FROM \`${PROJECT}.${DATASET}.${table}\`
  WHERE DATE(event_timestamp) BETWEEN @from AND @to
)
SELECT day, kind, '' AS issue_id, '' AS title, '' AS subtitle, '' AS version,
       COUNT(*) AS events, COUNT(DISTINCT installation_uuid) AS installs
FROM events GROUP BY day, kind
UNION ALL
SELECT day, kind, issue_id, ANY_VALUE(issue_title), ANY_VALUE(issue_subtitle),
       IFNULL(CAST(MAX(SAFE_CAST(version AS INT64)) AS STRING), MAX(version)),
       COUNT(*), COUNT(DISTINCT installation_uuid)
FROM events
GROUP BY day, kind, issue_id`;
}

/**
 * An issue's name for the screen. Without the R8 mapping Crashlytics titles an issue by the build's
 * `r8-map-id-…` source tag; the subtitle (`Exception - message`) then names it better.
 */
export function issueName(title: string, subtitle: string): { title: string; subtitle: string } {
  if (!/^r8-map-id-/.test(title) || subtitle === "") return { title, subtitle };
  const cut = subtitle.indexOf(" - ");
  return cut < 0 ? { title: subtitle, subtitle: "" } : { title: subtitle.slice(0, cut), subtitle: subtitle.slice(cut + 3) };
}

/** Whether version [a] is later than [b]: build numbers by value ("1000" after "999"), anything else as text. */
export function newerVersion(a: string, b: string): boolean {
  return /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) > Number(b) : a > b;
}

/** BigQuery's rows (`{f: [{v}]}`) as days: totals per kind and the most frequent issues. */
export function crashDaysOf(rows: { f: { v: unknown }[] }[]): CrashDay[] {
  const days = new Map<Day, CrashDay>();
  for (const row of rows) {
    const [day, kind, issueId, title, subtitle, version, events, installs] = row.f.map((cell) => cell.v);
    const key = String(day);
    const into = days.get(key) ?? { day: key, totals: {}, issues: [] };
    const counts = { events: Number(events ?? 0), installs: Number(installs ?? 0) };
    if (!issueId) into.totals[String(kind)] = counts;
    else into.issues.push({ id: String(issueId), ...issueName(String(title ?? ""), String(subtitle ?? "")), kind: String(kind), version: String(version ?? ""), ...counts });
    days.set(key, into);
  }
  for (const day of days.values()) day.issues = day.issues.sort((a, b) => b.events - a.events || a.id.localeCompare(b.id)).slice(0, ISSUES_PER_DAY);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function saveStatus(state: CrashlyticsState, nowMs: number, extra: Record<string, unknown> = {}): Promise<void> {
  await getFirestore().collection(STATS_CRASHLYTICS).doc(STATUS_DOC).set({ state, checkedAt: new Date(nowMs).toISOString(), ...extra }, { merge: true });
}

/**
 * Reads the last DAYS_READ full days from the export into `statsCrashlytics/{day}`. Never throws:
 * a missing dataset or missing roles is a state, not a failure.
 */
export async function importCrashlytics(nowMs: number, ask: Ask = bigQuery): Promise<CrashlyticsState> {
  try {
    const listed = await ask(`datasets/${DATASET}/tables?maxResults=100`);
    const waiting = waitingStateOf(listed.status);
    if (waiting) {
      await saveStatus(waiting, nowMs);
      return waiting;
    }
    if (listed.status !== 200) throw new Error(`tables ${listed.status}`);
    const tables = androidTables(listed.body);
    if (tables.length === 0) {
      await saveStatus("waiting_for_dataset", nowMs);
      return "waiting_for_dataset";
    }
    const to = addDays(dayOf(nowMs), -1);
    const from = addDays(to, 1 - DAYS_READ);
    const found: CrashDay[] = [];
    for (const table of tables) {
      const described = await ask(`datasets/${DATASET}/tables/${table}`);
      const fields = ((described.body as { schema?: { fields?: { name: string }[] } } | null)?.schema?.fields ?? []).map((field) => field.name);
      const answered = await ask("queries", {
        method: "POST",
        body: {
          query: crashSql(table, fields.includes("error_type")),
          useLegacySql: false,
          location: LOCATION,
          timeoutMs: 50_000,
          parameterMode: "NAMED",
          queryParameters: [
            { name: "from", parameterType: { type: "DATE" }, parameterValue: { value: from } },
            { name: "to", parameterType: { type: "DATE" }, parameterValue: { value: to } },
          ],
        },
      });
      const waitingNow = waitingStateOf(answered.status);
      if (waitingNow) {
        await saveStatus(waitingNow, nowMs);
        return waitingNow;
      }
      const body = answered.body as { jobComplete?: boolean; rows?: { f: { v: unknown }[] }[] } | null;
      if (answered.status !== 200 || body?.jobComplete !== true) throw new Error(`query ${answered.status}`);
      found.push(...crashDaysOf(body.rows ?? []));
    }
    const db = getFirestore();
    const batch = db.batch();
    // Every day read is written whole, an empty one too: a day with no crashes is a number.
    for (const day of daysFrom(from, to)) {
      const mine = found.filter((one) => one.day === day);
      const totals: CrashDay["totals"] = {};
      for (const one of mine) for (const [kind, counts] of Object.entries(one.totals)) totals[kind] = { events: (totals[kind]?.events ?? 0) + counts.events, installs: (totals[kind]?.installs ?? 0) + counts.installs };
      batch.set(db.collection(STATS_CRASHLYTICS).doc(day), { day, platform: "android", totals, issues: mine.flatMap((one) => one.issues).slice(0, ISSUES_PER_DAY), importedAt: new Date(nowMs).toISOString() });
    }
    await batch.commit();
    await saveStatus("ready", nowMs, { lastDay: to, tables });
    return "ready";
  } catch (error) {
    console.warn("Crashlytics import did not finish; tried again tomorrow", error instanceof Error ? error.message : error);
    await saveStatus("failed", nowMs).catch(() => undefined);
    return "failed";
  }
}
