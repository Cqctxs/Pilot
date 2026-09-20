import path from "node:path";
import type { SkillNotes } from "../compiler/skills.js";
import type { PilotEnv } from "../shared/env.js";
import { pilotError } from "../shared/errors.js";
import type { CredentialRequirement } from "../shared/pilot.js";

export interface ApiIntegration {
  id: string;
  name: string;
  hosts: readonly string[];
  apiBaseUrl: string;
  docsUrl: string;
  signupUrl: string | null;
  description: string;
  credentials: readonly CredentialRequirement[];
}

/**
 * Small, reviewed catalogue of official APIs. This is deliberately not an
 * arbitrary "API directory": each entry gives the compiler enough concrete
 * information to prefer the supported API over brittle browser scraping.
 */
export const API_INTEGRATIONS: readonly ApiIntegration[] = [
  {
    id: "geoapify",
    name: "Geoapify APIs",
    hosts: ["geoapify.com", "api.geoapify.com"],
    apiBaseUrl: "https://api.geoapify.com",
    docsUrl: "https://apidocs.geoapify.com/",
    signupUrl: "https://myprojects.geoapify.com/register",
    description: "Official places, geocoding, routing and location APIs.",
    credentials: [
      {
        env: "GEOAPIFY_API_KEY",
        description: "Geoapify project API key",
        signupUrl: "https://myprojects.geoapify.com/register",
      },
    ],
  },
  {
    id: "open-library",
    name: "Open Library API",
    hosts: ["openlibrary.org"],
    apiBaseUrl: "https://openlibrary.org",
    docsUrl: "https://openlibrary.org/developers/api",
    signupUrl: null,
    description: "Public book, author, subject and search APIs; no API key required.",
    credentials: [],
  },
  {
    id: "arbeitnow",
    name: "Arbeitnow Job Board API",
    hosts: ["arbeitnow.com"],
    apiBaseUrl: "https://www.arbeitnow.com/api/job-board-api",
    docsUrl: "https://documenter.getpostman.com/view/18545278/UVJbJdKh",
    signupUrl: null,
    description: "Public job-board JSON API; no API key required.",
    credentials: [],
  },
  {
    id: "dummyjson",
    name: "DummyJSON API",
    hosts: ["dummyjson.com"],
    apiBaseUrl: "https://dummyjson.com",
    docsUrl: "https://dummyjson.com/docs",
    signupUrl: null,
    description: "Public fake REST API intended for testing and prototyping.",
    credentials: [],
  },
] as const;

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function apiIntegrationFor(url: string): ApiIntegration | null {
  let host: string;
  try {
    host = normalizedHost(new URL(url).hostname);
  } catch {
    return null;
  }
  return API_INTEGRATIONS.find((integration) =>
    integration.hosts.some((candidate) => {
      const expected = normalizedHost(candidate);
      return host === expected || host.endsWith(`.${expected}`);
    })) ?? null;
}

export function credentialValues(
  requirements: readonly CredentialRequirement[],
  env: Pick<PilotEnv, "projectRoot">,
): Record<string, string> {
  const missing = requirements.filter((requirement) => !process.env[requirement.env]?.trim());
  if (missing.length > 0) {
    const envFile = path.join(env.projectRoot, ".env");
    const lines = missing.map((requirement) => `${requirement.env}=`).join("\n");
    const signup = [...new Set(missing.map((item) => item.signupUrl).filter(Boolean))];
    throw pilotError(
      "API_CREDENTIAL_REQUIRED",
      `This integration uses an official API and needs ${missing.map((item) => item.env).join(", ")}.\n` +
        (signup.length > 0 ? `Create credentials at: ${signup.join(", ")}\n` : "") +
        `Add ${missing.length === 1 ? "this entry" : "these entries"} to ${envFile}:\n${lines}\n` +
        "Then rerun the command. Secret values are passed to the generated script at runtime and are never stored in the Pilot.",
    );
  }
  return Object.fromEntries(
    requirements.map((requirement) => [requirement.env, process.env[requirement.env]!.trim()]),
  );
}

export function apiReferenceNotes(integration: ApiIntegration): SkillNotes {
  const credentialText = integration.credentials.length > 0
    ? `Credentials are available to the generated search function only as ${integration.credentials
        .map((item) => `query.${item.env}`)
        .join(" and ")}. Never hardcode, print, return, or send them anywhere except this official API.`
    : "This API does not require an API key.";
  return {
    ref: integration.id,
    source: `official-api:${integration.id}`,
    markdown: `# Official API available: ${integration.name}

Prefer this supported API over scraping the website when it provides the target records.

- API base: ${integration.apiBaseUrl}
- Documentation: ${integration.docsUrl}
- Purpose: ${integration.description}
- ${credentialText}

The final script should call the API directly with fetch and set needsBrowser to false. Verify the response during validation.`,
  };
}

export function combineReferenceNotes(
  first: SkillNotes | null,
  second: SkillNotes | null,
): SkillNotes | null {
  if (!first) return second;
  if (!second) return first;
  return {
    ref: `${first.ref}+${second.ref}`,
    source: `${first.source}+${second.source}`,
    markdown: `${first.markdown.trim()}\n\n---\n\n${second.markdown.trim()}`,
  };
}
