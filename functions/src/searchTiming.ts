/**
 * Where a picture search's time goes (Coordinator, 25.11.2026): each catalogue's answer time, what the
 * cache already held, and the steps around them, written as one log line per GET /lists/pictures.
 * Nothing in the answer changes; outside a traced search every call here does nothing. No uid, no
 * query text: its length in letters only.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface SearchTrace {
  part: "quick" | "full";
  startMs: number;
  /** One per search as typed, the second attempt's too: "web" or "answer" (a whole answer kept), "parts k" (k catalogues' answers kept), "miss". */
  cache: string[];
  /** Milliseconds per catalogue asked, one entry per asking. */
  sources: Record<string, number[]>;
  /** Asked, but gave nothing: failed, refused or timed out. */
  failed: string[];
  /** Not asked: resting after a refusal. */
  resting: string[];
  /** A quick search's catalogues that took longer than it waits: left for the whole search (26.11.2026). */
  late: string[];
  /** Milliseconds per step around the catalogues, summed: store (cache and rests read), charge, spelling, web. */
  steps: Record<string, number>;
}

const store = new AsyncLocalStorage<SearchTrace>();

export function newTrace(part: "quick" | "full", nowMs = Date.now()): SearchTrace {
  return { part, startMs: nowMs, cache: [], sources: {}, failed: [], resting: [], late: [], steps: {} };
}

/** Runs [work] with [trace] collecting what it does. */
export function traced<T>(trace: SearchTrace, work: () => Promise<T>): Promise<T> {
  return store.run(trace, work);
}

/** [work], its time added to [step] when a search is traced. */
export async function timed<T>(step: string, work: () => Promise<T>): Promise<T> {
  const trace = store.getStore();
  if (!trace) return work();
  const start = Date.now();
  try {
    return await work();
  } finally {
    trace.steps[step] = (trace.steps[step] ?? 0) + Date.now() - start;
  }
}

/** A catalogue asked: [work] gives its answer, null when it gave none. */
export async function timedSource<T>(source: string, work: () => Promise<T | null>): Promise<T | null> {
  const trace = store.getStore();
  if (!trace) return work();
  const start = Date.now();
  let answer: T | null = null;
  try {
    answer = await work();
    return answer;
  } finally {
    (trace.sources[source] ??= []).push(Date.now() - start);
    if (answer === null && !trace.late.includes(source)) trace.failed.push(source);
  }
}

export function noteCache(outcome: string): void {
  store.getStore()?.cache.push(outcome);
}

/** [source] took longer than a quick search waits: not a failure, the whole search asks it. */
export function noteLate(source: string): void {
  const trace = store.getStore();
  if (trace && !trace.late.includes(source)) trace.late.push(source);
}

export function noteResting(sources: readonly string[]): void {
  const trace = store.getStore();
  if (trace) for (const source of sources) if (!trace.resting.includes(source)) trace.resting.push(source);
}

/** The log line's fields for [trace], answered with [status] at [nowMs]. */
export function traceFields(
  trace: SearchTrace,
  search: { scope: string; page: number; letters: number; status: number },
  nowMs = Date.now(),
): Record<string, unknown> {
  return {
    message: "Picture search timing",
    part: trace.part,
    scope: search.scope,
    page: search.page,
    letters: search.letters,
    status: search.status,
    ms: nowMs - trace.startMs,
    cache: trace.cache,
    sources: trace.sources,
    ...(trace.failed.length > 0 ? { failed: trace.failed } : {}),
    ...(trace.resting.length > 0 ? { resting: trace.resting } : {}),
    ...(trace.late.length > 0 ? { late: trace.late } : {}),
    steps: trace.steps,
  };
}
