/**
 * Whether the words on a board may go into the feed.
 *
 * Sibling to `safety.ts`, which does the same for pictures, and deliberately
 * far more cautious than it. A picture is either a photograph of a person with
 * no clothes on or it is not. Words are not like that: a board called "Best
 * diss tracks" is about insults, a board of war films is about war, and a
 * tier list of horror is about death. Every one of those scores high on a
 * classifier's topic categories and every one of them is a perfectly good
 * board.
 *
 * So this refuses on very little, and refuses only when the classifier is sure.
 * A wrongly refused board is a person told their list is unacceptable with no
 * way to find out which word did it, which is worse than a rude title reaching
 * a feed that already has a report button under every card.
 */

/** Cloud Natural Language answers each category with a confidence in 0..1. */
export interface WordingVerdict {
  /** Sexual content. The one the store's rules are actually about. */
  sexual: number;
  /** Slurs and abuse aimed at a person or a group. */
  derogatory: number;
  /** Swearing. Not the same as abuse, and not refused on its own. */
  profanity: number;
}

/**
 * Where each category stops being publishable.
 *
 * `sexual` and `derogatory` refuse at nine tenths -- higher than the picture
 * thresholds, because there is no equivalent of "a photograph is obviously a
 * photograph" for a sentence, and the classifier's confidence on short text
 * like a board title is poor. Twelve words is not much to judge.
 *
 * `profanity` refuses at nothing at all. A swear word in a board title is not
 * against the rules of any store, it is how a great many people name things,
 * and refusing it would be this app deciding it knows better. It is kept in
 * the verdict because it is worth being able to see it later.
 */
export const REFUSE_SEXUAL_AT = 0.9;
export const REFUSE_DEROGATORY_AT = 0.9;

export type WordingRefusal = "sexual" | "derogatory";

export type WordingDecision = { ok: true } | { ok: false; because: WordingRefusal };

export function decideWording(verdict: WordingVerdict): WordingDecision {
  if (verdict.sexual >= REFUSE_SEXUAL_AT) return { ok: false, because: "sexual" };
  if (verdict.derogatory >= REFUSE_DEROGATORY_AT) return { ok: false, because: "derogatory" };
  return { ok: true };
}

/**
 * Everything a reader will see written on a board, as one piece of text.
 *
 * One document rather than one per field: a classifier reads a sentence better
 * than it reads a word, and "Arrival" on its own tells it nothing. It is also
 * one call instead of a hundred.
 *
 * Newline-separated, so that two innocent card titles cannot run together into
 * something that reads as a third thing.
 */
export function wordsOf(list: {
  title: string;
  tiers: { label: string; caption: string | null }[];
  items: { title: string }[];
}): string {
  return [
    list.title,
    ...list.tiers.flatMap((tier) => [tier.label, tier.caption ?? ""]),
    ...list.items.map((item) => item.title),
  ]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Below this there is not enough to judge and the classifier says so by
 * refusing the request. A board called "Films" is not worth an API call.
 */
export const ENOUGH_TO_JUDGE = 20;

/**
 * What the classifier says about a board's words, or nothing.
 *
 * Injected so the deciding can be exercised without a network, and answering
 * null on any trouble at all is deliberate: the classifier being down must not
 * stop somebody publishing. Pictures are the other way round -- there a
 * failure is a picture nobody looked at -- but words reach the feed under a
 * report button, and the cost of the two failures is not the same.
 */
export type ReadWords = (text: string) => Promise<WordingVerdict | null>;

export async function realModeration(text: string): Promise<WordingVerdict | null> {
  try {
    // Imported here rather than at the top: a cold start that never publishes
    // anything should not pay to load the client.
    const { LanguageServiceClient } = await import("@google-cloud/language");
    const client = new LanguageServiceClient();
    const [response] = await client.moderateText({
      document: { content: text, type: "PLAIN_TEXT" },
    });

    const scoreOf = (...names: string[]): number =>
      (response.moderationCategories ?? [])
        .filter((category) => names.includes(category.name ?? ""))
        .reduce((highest, category) => Math.max(highest, category.confidence ?? 0), 0);

    return {
      sexual: scoreOf("Sexual"),
      derogatory: scoreOf("Derogatory", "Insult", "Toxic"),
      profanity: scoreOf("Profanity"),
    };
  } catch {
    return null;
  }
}
