/**
 * How long each stage of one request took, for one log line at its end: the
 * stages are named in the order they finish, each counting from the one before.
 */
export interface PhaseClock {
  mark(stage: string): void;
  /** Milliseconds per stage, then the whole, since the clock started. */
  stages(): Record<string, number>;
}

export function phaseClock(now: () => number = Date.now): PhaseClock {
  const startedAt = now();
  let last = startedAt;
  const stages: Record<string, number> = {};
  return {
    mark(stage) {
      const at = now();
      stages[stage] = (stages[stage] ?? 0) + at - last;
      last = at;
    },
    stages: () => ({ ...stages, total: last - startedAt }),
  };
}
