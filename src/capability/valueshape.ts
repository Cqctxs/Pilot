/**
 * What a field's values look like, independent of the site that produced them.
 *
 * Promotion has to answer a question a field name cannot: are two Pilots that
 * both extract `postedAt` really extracting the same thing? Name and type say
 * yes — it is a `string` on every job board — but "6 hours ago" and
 * "2026-09-14" are not the same field, and promoting them into one shared
 * column produces data no caller can parse. Comparing the shape of the values
 * each Pilot actually returned is the cheapest evidence that they agree.
 */
import { asText, type RawRecord } from "../shared/schema.js";

export type ValueShape =
  | "empty"
  | "url"
  | "isoDate"
  | "relativeTime"
  | "money"
  | "number"
  | "boolean"
  | "text";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const RELATIVE_TIME =
  /^(?:posted\s+)?(?:just\s+now|today|yesterday|(?:over\s+|about\s+|more\s+than\s+)?\d+\+?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|[smhdwy])\s*(?:ago)?)$/i;

const PLAIN_NUMBER = /^[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^[-+]?\d+(?:\.\d+)?$/;

const CURRENCY_MARKER = /[$€£¥₹]|\b(?:usd|eur|gbp|cad|aud|inr|jpy)\b/i;

/** Classify one extracted value. Extraction always yields strings or null. */
export function classifyValue(value: string | null): ValueShape {
  if (value === null) return "empty";
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  if (/^https?:\/\//i.test(trimmed)) return "url";
  if (/^(?:true|false|yes|no)$/i.test(trimmed)) return "boolean";
  if (ISO_DATE.test(trimmed)) return "isoDate";
  if (RELATIVE_TIME.test(trimmed)) return "relativeTime";
  // Money before number: "$120,000" is both digits and a currency.
  if (/\d/.test(trimmed) && CURRENCY_MARKER.test(trimmed)) return "money";
  if (PLAIN_NUMBER.test(trimmed)) return "number";
  return "text";
}

/**
 * The shape most of a Pilot's samples agree on, or `null` when there is nothing
 * to judge. Empty values are ignored rather than counted: a field the site
 * leaves blank half the time is still that field.
 */
export function dominantShape(values: readonly (string | null)[]): ValueShape | null {
  const counts = new Map<ValueShape, number>();
  for (const value of values) {
    const shape = classifyValue(value);
    if (shape === "empty") continue;
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]![0];
}

/** The dominant shape of one field across a Pilot's sample records. */
export function fieldShape(
  samples: readonly RawRecord[],
  field: string,
): ValueShape | null {
  return dominantShape(samples.map((record) => asText(record[field])));
}
