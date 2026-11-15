/**
 * Where a house list comes from, shown on its page as "Source: …" (Content's
 * request of 15.11.2026: a ranking made on a stream had nowhere to link the
 * stream). A label and the https page it names; only the house's lists carry
 * one, and a list without one reads as every list did before.
 */
import { pageLink } from "./pictureAttribution";

export interface ListSource {
  /** What the reader sees after "Source:", one line. */
  label: string;
  /** The page, https, without a login or a port. */
  url: string;
}

export const MAX_LIST_SOURCE_LABEL = 120;
export const LIST_SOURCE_RULE = "A source is {label, url}: a label of 1 to 120 characters and an https page of at most 500";

/**
 * [raw] as a source: null for none (absent or null), "invalid" for anything
 * but a label of 1 to 120 characters on one line and an https page `pageLink`
 * keeps. Other keys are left out.
 */
export function readListSource(raw: unknown): ListSource | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const { label, url } = raw as Record<string, unknown>;
  if (typeof label !== "string") return "invalid";
  // eslint-disable-next-line no-control-regex
  const line = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (line.length === 0 || line.length > MAX_LIST_SOURCE_LABEL) return "invalid";
  const page = pageLink(url);
  return page === null ? "invalid" : { label: line, url: page };
}
