/**
 * How many of their own photographs one account may have Cloud Vision look at in a UTC day (QA, 19.11.2026).
 * Every publish looks at each own photograph again under a new name, and every face once, so without a
 * ceiling one account could run up the bill by publishing or changing its face in a loop. Far above what a
 * person does by hand: five lists of two hundred photographs a day, or twenty faces.
 */
import { countToday, nextDayMs } from "./dailyCount";

export const OWN_PICTURES_LOOKED_AT_PER_DAY = 1000;
export const FACES_PER_DAY = 20;

export type VisionUse = "pictures" | "faces";

const LIMITS: Record<VisionUse, number> = { pictures: OWN_PICTURES_LOOKED_AT_PER_DAY, faces: FACES_PER_DAY };

/** The day's Vision is used up: `429 VISION_DAILY_LIMIT`, to ask again at `retryAtMs`. */
export class VisionLimit extends Error {
  constructor(readonly retryAtMs: number) {
    super("Vision daily limit");
  }
}

/** Counts [count] looks for [uid]; throws VisionLimit when they would pass the day's limit, counting nothing. */
export async function chargeVision(uid: string, use: VisionUse, count: number, nowMs = Date.now()): Promise<void> {
  if (!(await countToday("visionUsage", uid, use, count, LIMITS[use], nowMs))) throw new VisionLimit(nextDayMs(nowMs));
}
