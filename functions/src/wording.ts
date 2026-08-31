/**
 * What the classifier makes of the words on a board.
 *
 * It does not decide whether they may be published, because it measurably
 * cannot. Asked about real board text in three languages, it answered 0.64 for
 * "Best sex scenes in cinema" -- a perfectly good film list -- and 0.69 for a
 * list of pornographic actresses. Five hundredths apart, because the two are
 * about the same subject and a classifier reading twelve words has no way to
 * tell an appreciation from an advertisement.
 *
 * Its `derogatory` score was worse still: "Shit I have to do this week" scored
 * 0.92, above an actual list of people somebody wanted dead at 0.91. A rule
 * that refuses a to-do list for swearing while letting hatred through is not a
 * rule worth having, so nothing refuses on derogatory at all.
 *
 * So this feeds the queue instead. A noisy signal belongs in front of a person,
 * not in front of a gate: a wrong guess costs a look rather than telling
 * somebody their list is unacceptable with no way to learn why.
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
 * Both numbers come from asking the real classifier about real board text.
 *
 * Ordinary boards -- films, albums, war films, horror, "my beach photos" --
 * scored between 0.00 and 0.14 in English, Russian and Ukrainian. The two
 * awkward ones were "Best diss tracks" at 0.32 and "Best sex scenes in
 * cinema" at 0.64. Lists of pornographic actresses scored 0.69 in English,
 * 0.85 in Ukrainian and 0.91 in Russian.
 *
 * So [WORTH_A_LOOK] sits below the film list as well as the porn list: both
 * reach the queue, and a person spends five seconds telling them apart. And
 * [HIDE_UNTIL_LOOKED_AT] sits above anything an ordinary board scored by a
 * wide margin, so hiding on it costs an innocent board nothing.
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
