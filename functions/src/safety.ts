/**
 * Whether a picture somebody drew from their own gallery may go into the feed.
 * Pure, like the rest of the deciding in this repo: `community.ts` fetches the
 * bytes and calls Vision, this file only reads the verdict.
 *
 * Only ever asked about pictures the person supplied. Posters from TMDB and
 * images from Wikidata arrive as https addresses somebody else already hosts
 * and already moderates, and paying to look at them again would buy nothing.
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
 * Where each category stops being publishable.
 *
 * `adult` is the one the policy is actually about, so it refuses at "likely" —
 * one step before certainty, because a picture Vision is unsure about is not a
 * picture a feed should be arguing over.
 *
 * `racy` is deliberately one step laxer. It fires on swimwear, on a hand near a
 * face, on half the film posters ever printed; refusing at "likely" would mean
 * refusing a board of beach photographs, which is not what anybody asked for.
 *
 * `violence` catches gore rather than a war film's poster, so it sits with
 * adult rather than with racy.
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
 * How many of a person's own photographs one published list may carry.
 *
 * A board may hold two thousand cards, and every own photograph costs a read
 * from storage, a call to Vision and a copy — per publish, and again on every
 * republish. Two hundred is far past any board somebody actually assembled by
 * hand from their own camera roll, and it keeps one press of Publish from
 * becoming a four-figure bill.
 */
export const MAX_OWN_PICTURES_PER_LIST = 200;

/** Picture ids are folder names; nothing that could climb out of one. */
export const PICTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isPictureId(value: unknown): value is string {
  return typeof value === "string" && PICTURE_ID.test(value);
}
