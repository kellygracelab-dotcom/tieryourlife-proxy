/**
 * Whether a picture from somebody's own gallery may go into the feed. Pure:
 * `community.ts` fetches the bytes and calls Vision. Posters and Wikidata
 * images are hosted and moderated elsewhere, so they are never looked at.
 */

/**
 * Vision's five-step scale, in its own words. Ordered, so a threshold can be
 * expressed as "this or worse" rather than as a list of names.
 */
export const LIKELIHOODS = [
  "VERY_UNLIKELY",
  "UNLIKELY",
  "POSSIBLE",
  "LIKELY",
  "VERY_LIKELY",
] as const;

export type Likelihood = (typeof LIKELIHOODS)[number] | "UNKNOWN";

export interface SafeSearchVerdict {
  adult: Likelihood;
  racy: Likelihood;
  violence: Likelihood;
}

/**
 * `adult` refuses at "likely", one step before certainty. `racy` is one step
 * laxer: it fires on swimwear and half the film posters ever printed.
 * `violence` catches gore rather than a war film's poster, so it sits with adult.
 */
export const REFUSE_ADULT_AT: Likelihood = "LIKELY";
export const REFUSE_RACY_AT: Likelihood = "VERY_LIKELY";
export const REFUSE_VIOLENCE_AT: Likelihood = "LIKELY";

function atLeast(value: Likelihood, threshold: Likelihood): boolean {
  const seen = LIKELIHOODS.indexOf(value as (typeof LIKELIHOODS)[number]);
  const bar = LIKELIHOODS.indexOf(threshold as (typeof LIKELIHOODS)[number]);
  // UNKNOWN is not on the scale. It means Vision looked and could not say,
  // which is not the same as "no" -- but refusing on it would refuse every
  // picture the moment the API had a bad minute, so it passes.
  if (seen < 0 || bar < 0) return false;
  return seen >= bar;
}

export type SafetyRefusal = "adult" | "racy" | "violence";

export type SafetyDecision = { ok: true } | { ok: false; because: SafetyRefusal };

export function decideSafe(verdict: SafeSearchVerdict): SafetyDecision {
  if (atLeast(verdict.adult, REFUSE_ADULT_AT)) return { ok: false, because: "adult" };
  if (atLeast(verdict.violence, REFUSE_VIOLENCE_AT)) return { ok: false, because: "violence" };
  if (atLeast(verdict.racy, REFUSE_RACY_AT)) return { ok: false, because: "racy" };
  return { ok: true };
}

/**
 * Every own photograph costs a read, a Vision call and a copy per publish.
 * Two hundred is far past any board assembled by hand and keeps one press of
 * Publish from becoming a four-figure bill.
 */
export const MAX_OWN_PICTURES_PER_LIST = 200;

/** Picture ids are folder names; nothing that could climb out of one. */
export const PICTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isPictureId(value: unknown): value is string {
  return typeof value === "string" && PICTURE_ID.test(value);
}
