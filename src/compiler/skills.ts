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
import { pilotError } from "../shared/errors.js";

const CATALOG = "https://browse.sh";

/** Skills run to tens of KB; well past that is not a skill. */
const MAX_BYTES = 60_000;

const FETCH_TIMEOUT_MS = 15_000;

export interface SkillNotes {
  /** `<domain>/<task>`, a local path, or whatever the user asked for. */
  ref: string;
  /** Where it came from, recorded on the Pilot for provenance. */
  source: string;
  markdown: string;
}

interface CatalogSkill {
  slug: string;
  title: string;
  description: string;
  recommendedMethod: string;
}

async function getJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw pilotError("SKILL_UNAVAILABLE", `Could not reach ${CATALOG}: ${(cause as Error).message}`);
  }
  if (!response.ok) {
    throw pilotError("SKILL_UNAVAILABLE", `${url} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
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
  const files = (await getJson(`${CATALOG}/api/skills/${slug}/files`)) as {
    files?: Array<{ path: string; url: string }>;
  };
  const main = (files.files ?? []).find((file) => file.path === "SKILL.md");
  if (!main) {
    throw pilotError("SKILL_NOT_FOUND", `browse.sh has no SKILL.md for ${slug}.`);
  }

  let response: Response;
  try {
    response = await fetch(main.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
