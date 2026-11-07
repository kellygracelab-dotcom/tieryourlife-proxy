/**
 * Whether putting a list on one's phone adds to its takeCount, which orders
 * Popular and the suggested authors. Pure: `community.ts` reads and writes.
 */
export interface TakeInput {
  takerUid: string;
  authorUid: unknown;
  /** The same rule as a report's (`weighsOnHiding`): no guests, banned accounts or accounts younger than a week. */
  weighs: boolean;
  alreadyTaken: boolean;
}

export function countsAsTake({ takerUid, authorUid, weighs, alreadyTaken }: TakeInput): boolean {
  return weighs && !alreadyTaken && authorUid !== takerUid;
}
