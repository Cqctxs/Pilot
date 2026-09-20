/**
 * jobs.search@1 — the first capability.
 *
 * A capability is two things: a schema the compiler targets, and the
 * deterministic normalization that turns extracted strings into typed records.
 * Adding a second capability means adding a file like this one; nothing in
 * `compiler/` or `runtime/` needs to know it exists.
 */
import { asText, type DataSchema, type FieldSpec, type RawRecord } from "../shared/schema.js";

export const JOBS_CAPABILITY = "jobs.search@1" as const;

export const JOBS_SCHEMA: DataSchema = {
  name: JOBS_CAPABILITY,
  fields: [
    { name: "title", type: "string", required: true, description: "The job title as posted" },
    { name: "company", type: "string", required: true, description: "Hiring company name" },
    { name: "location", type: "string", required: false, description: "Work location, or 'Remote'" },
    { name: "url", type: "url", required: true, description: "Link to the full posting" },
    {
      name: "employmentType",
      type: "string",
      required: false,
      description: "Raw employment type as the site labels it, e.g. 'Internship', 'Full-time'",
    },
    { name: "postedAt", type: "string", required: false, description: "When the job was posted, as shown" },
  ],
};

export type EmploymentType =
  | "internship"
  | "full-time"
  | "part-time"
  | "contract"
  | "temporary"
  | "unknown";

export type JobAttributeValue = string | number | boolean | null;
export type JobFilterValue = Exclude<JobAttributeValue, null>;

export interface Job {
  /** Stable within a run: `<pilotId>:<hash of url>`. */
  id: string;
  source: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  type: EmploymentType;
  /** Whether `type` came from the site or was inferred from the title. */
  typeBasis: "source" | "title" | "unknown";
  postedAt: string | null;
  /** Optional fields that this Pilot's compiler added to its validated schema. */
  attributes: Record<string, JobAttributeValue>;
}

export interface JobQuery {
  keywords?: string;
  location?: string;
  type?: EmploymentType;
  /** Local exact-match filters over generated fields. Arrays mean "match any". */
  filters?: Record<string, JobFilterValue | JobFilterValue[]>;
  /** Cap per Pilot, not across the fan-out. */
  limit?: number;
  /**
   * Re-check location locally after the source returns. Off by default: the
   * board already ran a geographic search and is better at it than we are.
   */
  strictLocation?: boolean;
}

// --- Normalization ---------------------------------------------------------

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeDisplay(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

const TYPE_PATTERNS: ReadonlyArray<[EmploymentType, RegExp]> = [
  ["internship", /\b(intern|internship|co op|coop|placement)\b/],
  ["part-time", /\bpart time\b/],
  ["contract", /\b(contract|contractor|freelance)\b/],
  ["temporary", /\b(temporary|temp|seasonal)\b/],
  ["full-time", /\b(full time|permanent|regular)\b/],
];

const INTERNSHIP_PATTERN = TYPE_PATTERNS[0]![1];

/**
 * Prefer what the site says; fall back to the title. `typeBasis` records which,
 * so a caller can tell a real signal from a guess.
 *
 * With one exception, learned from the real boards: an internship named in the
 * title beats the site's own employment type. Both LinkedIn and Talent.com
 * report "Software Engineering Intern (Summer)" as `Full-time`, because their
 * field means hours per week, not level. The title is the more specific signal
 * and it is the one a caller filtering for internships actually means.
 */
export function classifyEmploymentType(
  title: string,
  rawType: string | null,
): { type: EmploymentType; typeBasis: Job["typeBasis"] } {
  const normalizedTitle = normalizeForMatch(title);
  if (INTERNSHIP_PATTERN.test(normalizedTitle)) {
    return { type: "internship", typeBasis: "title" };
  }

  if (rawType) {
    const normalized = normalizeForMatch(rawType);
    for (const [type, pattern] of TYPE_PATTERNS) {
      if (pattern.test(normalized)) return { type, typeBasis: "source" };
    }
  }

  for (const [type, pattern] of TYPE_PATTERNS) {
    if (pattern.test(normalizedTitle)) return { type, typeBasis: "title" };
  }
  return { type: "unknown", typeBasis: "unknown" };
}

function stableId(source: string, url: string): string {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${source}:${(hash >>> 0).toString(36)}`;
}

/** Turn one extracted record into a Job, or `null` if it lacks required fields. */
const CORE_FIELDS = new Set([
  "title",
  "company",
  "location",
  "url",
  "employmentType",
  "postedAt",
]);

export function toJob(
  source: string,
  record: RawRecord,
  schema: DataSchema = JOBS_SCHEMA,
): Job | null {
  const title = asText(record.title)?.trim();
  const url = asText(record.url)?.trim();
  if (!title || !url) return null;
  const { type, typeBasis } = classifyEmploymentType(title, asText(record.employmentType));
  return {
    id: stableId(source, url),
    source,
    title: normalizeDisplay(title),
    company: normalizeDisplay(asText(record.company) ?? source),
    location: record.location ? normalizeDisplay(String(record.location)) : null,
    url,
    type,
    typeBasis,
    postedAt: record.postedAt ? normalizeDisplay(String(record.postedAt)) : null,
    attributes: collectAttributes(record, schema),
  };
}

function collectAttributes(
  record: RawRecord,
  schema: DataSchema,
): Record<string, JobAttributeValue> {
  const attributes: Record<string, JobAttributeValue> = {};
  for (const field of schema.fields) {
    if (CORE_FIELDS.has(field.name)) continue;
    attributes[field.name] = coerceAttribute(asText(record[field.name]), field);
  }
  return attributes;
}

function coerceAttribute(value: string | null, field: FieldSpec): JobAttributeValue {
  if (value === null) return null;
  if (field.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (field.type === "boolean") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
    return null;
  }
  return normalizeDisplay(value);
}

// --- Filtering and merging -------------------------------------------------

/**
 * Applied to every Pilot's output regardless of whether the site honoured the
 * query. Sites disagree about what a keyword search means; this is what makes
 * results from different sources comparable.
 *
 * Location is deliberately NOT filtered here by default. The query is passed to
 * the board, which runs a real geographic search; re-checking it as a substring
 * afterwards throws away correct results — a search for "Boston" against
 * LinkedIn legitimately returns Cambridge and Waltham, and substring matching
 * discards every one of them. A board knows its own geography better than we
 * do. Pass `strictLocation` to filter anyway, for a source that ignores it.
 */
export function filterJobs(jobs: Job[], query: JobQuery): Job[] {
  const keywords = query.keywords ? normalizeForMatch(query.keywords).split(" ").filter(Boolean) : [];
  const location = query.strictLocation && query.location ? normalizeForMatch(query.location) : null;

  return jobs.filter((job) => {
    if (keywords.length > 0) {
      const haystack = normalizeForMatch(`${job.title} ${job.company}`);
      if (!keywords.every((word) => haystack.includes(word))) return false;
    }
    if (location) {
      const haystack = normalizeForMatch(job.location ?? "");
      const remote = normalizeForMatch(`${job.title} ${job.location ?? ""}`).includes("remote");
      if (!haystack.includes(location) && !(location === "remote" && remote)) return false;
    }
    if (query.type && job.type !== query.type) return false;
    if (query.filters) {
      for (const [field, requested] of Object.entries(query.filters)) {
        const actual = jobField(job, field);
        const expected = Array.isArray(requested) ? requested : [requested];
        if (!expected.some((value) => fieldValuesEqual(actual, value))) return false;
      }
    }
    return true;
  });
}

function jobField(job: Job, field: string): JobAttributeValue {
  switch (field) {
    case "employmentType":
    case "type":
      return job.type;
    case "title":
      return job.title;
    case "company":
      return job.company;
    case "location":
      return job.location;
    case "url":
      return job.url;
    case "postedAt":
      return job.postedAt;
    default:
      return job.attributes[field] ?? null;
  }
}

function fieldValuesEqual(actual: JobAttributeValue, expected: JobFilterValue): boolean {
  if (actual === null) return false;
  if (typeof actual === "number" || typeof expected === "number") {
    return Number(actual) === Number(expected);
  }
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    const normalized = (value: JobFilterValue): boolean | null => {
      if (typeof value === "boolean") return value;
      if (/^(true|yes|1)$/i.test(String(value))) return true;
      if (/^(false|no|0)$/i.test(String(value))) return false;
      return null;
    };
    return normalized(actual) === normalized(expected);
  }
  return normalizeForMatch(actual) === normalizeForMatch(expected);
}

/** Same posting cross-listed on two boards collapses to one entry. */
export function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Map<string, Job>();
  const out: Job[] = [];
  for (const job of jobs) {
    const key = `${normalizeForMatch(job.title)}|${normalizeForMatch(job.company)}`;
    const existing = seen.get(key);
    if (existing) {
      for (const [name, value] of Object.entries(job.attributes)) {
        if (existing.attributes[name] === undefined || existing.attributes[name] === null) {
          existing.attributes[name] = value;
        }
      }
      continue;
    }
    seen.set(key, job);
    out.push(job);
  }
  return out;
}
