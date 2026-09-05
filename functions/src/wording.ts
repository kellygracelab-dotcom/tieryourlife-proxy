/**
 * What the classifier makes of the words on a board. It does not decide
 * whether they may be published, because it measurably cannot: on real board
 * text "Best sex scenes in cinema" scored 0.64 and a list of pornographic
 * actresses 0.69, and `derogatory` put "Shit I have to do this week" (0.92)
 * above a list of people somebody wanted dead (0.91). So nothing refuses on
 * it; a noisy signal belongs in front of a person, and this feeds the queue.
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
 * Both from asking the real classifier about real board text. Ordinary boards
 * scored 0.00-0.14 in English, Russian and Ukrainian; "Best diss tracks" 0.32;
 * "Best sex scenes in cinema" 0.64; lists of pornographic actresses 0.69
 * (English), 0.85 (Ukrainian) and 0.91 (Russian). [WORTH_A_LOOK] sits below
 * the film list so both reach the queue; [HIDE_UNTIL_LOOKED_AT] sits far
 * above anything an ordinary board scored.
 */
export const WORTH_A_LOOK = 0.6;
export const HIDE_UNTIL_LOOKED_AT = 0.85;

export type WordingConcern = "none" | "queue" | "hide";

/**
 * What to do about a board's words: nothing, put it in front of somebody, or
 * take it out of the feed until somebody has looked.
 *
 * Never "refuse". Publishing is not blocked on this at any confidence.
 */
export function decideWordingConcern(verdict: WordingVerdict): WordingConcern {
  if (verdict.sexual >= HIDE_UNTIL_LOOKED_AT) return "hide";
  if (verdict.sexual >= WORTH_A_LOOK) return "queue";
  return "none";
}

/**
 * Everything a reader will see on a board, as one document: a classifier
 * reads a sentence better than a word, and it is one call instead of a
 * hundred. Newline-separated so two innocent titles cannot run together.
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
 * Injected so the deciding can be exercised without a network. Null on any
 * trouble is deliberate: the classifier being down must not stop somebody
 * publishing -- words reach the feed under a report button, pictures do not.
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
