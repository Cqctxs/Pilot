/**
 * Reference notes about a site, used as a prior when compiling it.
 *
 * browse.sh publishes an open catalogue of "browser skills": a SKILL.md per
 * site holding the measured facts someone already paid to discover — which
 * query parameters work, which selectors are stable, where the JSON endpoint
 * is, which anti-bot wall you hit and what clears it. That is precisely what
 * our explorer spends thirty steps rediscovering, and the catalogue is open.
 *
 * The difference is what comes out. browse.sh ships the notes and an agent
 * reads them at runtime, every run, forever. We read them once at compile time
 * and emit a typed function. Their artifact is the best possible input to ours.
 *
 * Two things this module is careful about:
 *
 * 1. A skill is *reference*, not instruction. It was written for a different
 *    tool surface (`browse open`, `browse eval`) that this compiler does not
 *    have, against a site that may have changed since. The prompt says so, and
 *    the model is told to verify before trusting.
 * 2. A skill is third-party text fetched over the network. It is untrusted
 *    input, delimited as data and capped in size, never spliced into the
 *    instructions as though we wrote it.
 */
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pilotError } from "../shared/errors.js";

const CATALOG = "https://browse.sh";

/** Skills run to tens of KB; well past that is not a skill. */
const MAX_BYTES = 60_000;

const FETCH_TIMEOUT_MS = 15_000;
const AUTO_FETCH_TIMEOUT_MS = 8_000;

export interface SkillNotes {
  /** `<domain>/<task>`, a local path, or whatever the user asked for. */
  ref: string;
  /** Where it came from, recorded on the Pilot for provenance. */
  source: string;
  markdown: string;
}

interface CatalogSkill {
  slug: string;
  hostname?: string;
  task?: string;
  name?: string;
  title: string;
  description: string;
  category?: string;
  tags?: string[];
  verified?: boolean;
  status?: string;
  recommendedMethod: string;
}

async function getJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw pilotError("SKILL_UNAVAILABLE", `Could not reach ${CATALOG}: ${(cause as Error).message}`);
  }
  if (!response.ok) {
    throw pilotError("SKILL_UNAVAILABLE", `${url} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^www\./, "");
}

function publicHostname(url: string): string | null {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    hostname = normalizedHostname(parsed.hostname);
  } catch {
    return null;
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    !hostname.includes(".") ||
    isIP(hostname) !== 0
  ) {
    return null;
  }
  return hostname;
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 2),
  );
}

function automaticChoice(
  candidates: CatalogSkill[],
  url: string,
  capability: string | null,
): CatalogSkill | null {
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) return null;

  const parsed = new URL(url);
  const hints = words(`${parsed.pathname} ${parsed.search} ${capability ?? ""}`);
  const scored = candidates
    .map((skill) => {
      const text = words(
        [skill.task, skill.name, skill.title, skill.description, skill.category, ...(skill.tags ?? [])]
          .filter(Boolean)
          .join(" "),
      );
      let score = [...hints].filter((word) => text.has(word)).length;
      const capabilityCategory = capability?.split(/[.@]/)[0];
      if (capabilityCategory && skill.category === capabilityCategory) score += 3;
      return { skill, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]!.score > 0 && scored[0]!.score > scored[1]!.score
    ? scored[0]!.skill
    : null;
}

async function downloadSkill(
  slug: string,
  ref: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<SkillNotes> {
  const files = (await getJson(`${CATALOG}/api/skills/${slug}/files`, timeoutMs)) as {
    files?: Array<{ path: string; url: string }>;
  };
  const main = (files.files ?? []).find((file) => file.path === "SKILL.md");
  if (!main) {
    throw pilotError("SKILL_NOT_FOUND", `browse.sh has no SKILL.md for ${slug}.`);
  }

  let response: Response;
  try {
    response = await fetch(main.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw pilotError("SKILL_UNAVAILABLE", `Could not download ${slug}: ${(cause as Error).message}`);
  }
  if (!response.ok) {
    throw pilotError("SKILL_UNAVAILABLE", `Could not download ${slug}: ${response.status}`);
  }

  const markdown = await response.text();
  if (markdown.length > MAX_BYTES) {
    throw pilotError("SKILL_UNAVAILABLE", `${slug} is ${markdown.length} bytes; the cap is ${MAX_BYTES}.`);
  }
  return { ref, source: `browse.sh:${slug}`, markdown };
}

/**
 * Best-effort lookup used for an otherwise-new compile. It deliberately
 * returns null for local hosts, no matches and ambiguous matches: an automatic
 * optimization may save exploration, but it must never guess the wrong task.
 */
export async function findSkillNotesForUrl(
  url: string,
  capability: string | null = null,
): Promise<SkillNotes | null> {
  const hostname = publicHostname(url);
  if (!hostname) return null;
  const payload = (await getJson(
    `${CATALOG}/api/skills?q=${encodeURIComponent(hostname)}`,
    AUTO_FETCH_TIMEOUT_MS,
  )) as { skills?: CatalogSkill[] };
  const matches = (payload.skills ?? []).filter((skill) => {
    const skillHost = normalizedHostname(skill.hostname ?? skill.slug.split("/")[0] ?? "");
    const usable = skill.verified !== false && (!skill.status || skill.status === "ready");
    return usable && skillHost === hostname;
  });
  const chosen = automaticChoice(matches, url, capability);
  return chosen ? downloadSkill(chosen.slug, chosen.slug, AUTO_FETCH_TIMEOUT_MS) : null;
}

/**
 * `alltrails.com` names a site, not a skill — the catalogue keys on
 * `<domain>/<task>`. One match is unambiguous; several is a question for the
 * caller, because picking for them would silently compile against the wrong
 * task.
 */
async function resolveSlug(ref: string): Promise<string> {
  if (ref.includes("/")) return ref;

  const payload = (await getJson(`${CATALOG}/api/skills?q=${encodeURIComponent(ref)}`)) as {
    skills?: CatalogSkill[];
  };
  const matches = (payload.skills ?? []).filter((skill) => skill.slug.startsWith(`${ref}/`));

  if (matches.length === 0) {
    throw pilotError(
      "SKILL_NOT_FOUND",
      `No browse.sh skill for "${ref}". Search the catalogue at ${CATALOG} and pass <domain>/<task>.`,
    );
  }
  if (matches.length > 1) {
    const options = matches
      .map((skill) => `  ${skill.slug}  (${skill.recommendedMethod})  ${skill.title}`)
      .join("\n");
    throw pilotError(
      "SKILL_AMBIGUOUS",
      `"${ref}" matches ${matches.length} skills. Pass one:\n${options}`,
    );
  }
  return matches[0]!.slug;
}

/**
 * Fetch reference notes for a site. A path that exists on disk is read as a
 * local file, so notes you wrote yourself work the same way as the catalogue's.
 */
export async function fetchSkillNotes(ref: string): Promise<SkillNotes> {
  if (existsSync(ref)) {
    const markdown = readFileSync(ref, "utf8");
    if (markdown.length > MAX_BYTES) {
      throw pilotError("SKILL_UNAVAILABLE", `${ref} is ${markdown.length} bytes; the cap is ${MAX_BYTES}.`);
    }
    return { ref, source: `file:${ref}`, markdown };
  }

  const slug = await resolveSlug(ref);
  return downloadSkill(slug, ref);
}
