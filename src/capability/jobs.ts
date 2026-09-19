/**
 * jobs.board@1 — the first capability.
 *
 * A capability is two things: a schema the compiler targets, and the
 * deterministic normalization that turns extracted strings into typed records.
 * Adding a second capability means adding a file like this one; nothing in
 * `compiler/` or `runtime/` needs to know it exists.
 */
import type { DataSchema, RawRecord } from "../shared/schema.js";

export const JOBS_CAPABILITY = "jobs.board@1" as const;

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
}

export interface JobQuery {
  keywords?: string;
  location?: string;
  type?: EmploymentType;
  /** Cap per Pilot, not across the fan-out. */
  limit?: number;
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

/**
 * Prefer what the site says; fall back to the title. `typeBasis` records which,
 * so a caller can tell a real signal from a guess.
 */
export function classifyEmploymentType(
  title: string,
  rawType: string | null,
): { type: EmploymentType; typeBasis: Job["typeBasis"] } {
  if (rawType) {
    const normalized = normalizeForMatch(rawType);
    for (const [type, pattern] of TYPE_PATTERNS) {
      if (pattern.test(normalized)) return { type, typeBasis: "source" };
    }
  }
  const normalizedTitle = normalizeForMatch(title);
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
export function toJob(source: string, record: RawRecord): Job | null {
  const title = record.title?.trim();
  const url = record.url?.trim();
  if (!title || !url) return null;
  const { type, typeBasis } = classifyEmploymentType(title, record.employmentType ?? null);
  return {
    id: stableId(source, url),
    source,
    title: normalizeDisplay(title),
    company: normalizeDisplay(record.company ?? source),
    location: record.location ? normalizeDisplay(record.location) : null,
    url,
    type,
    typeBasis,
    postedAt: record.postedAt ? normalizeDisplay(record.postedAt) : null,
  };
}

// --- Filtering and merging -------------------------------------------------

/**
 * Applied to every Pilot's output regardless of whether the site honoured the
 * query. Sites disagree about what a keyword search means; this is what makes
 * results from different sources comparable.
 */
export function filterJobs(jobs: Job[], query: JobQuery): Job[] {
  const keywords = query.keywords ? normalizeForMatch(query.keywords).split(" ").filter(Boolean) : [];
  const location = query.location ? normalizeForMatch(query.location) : null;

  return jobs.filter((job) => {
    if (keywords.length > 0) {
      const haystack = normalizeForMatch(`${job.title} ${job.company}`);
      if (!keywords.every((word) => haystack.includes(word))) return false;
    }
    if (location) {
      const haystack = normalizeForMatch(job.location ?? "");
      const remote = normalizeForMatch(job.title).includes("remote");
      if (!haystack.includes(location) && !(location === "remote" && remote)) return false;
    }
    if (query.type && job.type !== query.type) return false;
    return true;
  });
}

/** Same posting cross-listed on two boards collapses to one entry. */
export function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const job of jobs) {
    const key = `${normalizeForMatch(job.title)}|${normalizeForMatch(job.company)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}
