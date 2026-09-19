import type { DataSchema } from "../shared/schema.js";
import type { Observation } from "./observe.js";

export const SYSTEM_PROMPT = `You compile websites into declarative extraction recipes.

You are given observations of one website and a target schema. You return ONE JSON
recipe that a deterministic interpreter will run — you will not be called again at
run time, so the recipe must work without you.

Two recipe kinds are available.

http-json — use this whenever the observations contain a JSON endpoint that carries
the records. It is faster, cheaper and far more stable than a browser recipe.
{
  "recipeFormatVersion": 1,
  "kind": "http-json",
  "request": { "urlTemplate": "https://…?q={keywords}&start={offset}", "method": "GET", "headers": {}, "bodyTemplate": null },
  "pagination": null | { "kind": "counter", "variable": "offset", "start": 0, "step": 10, "maxPages": 3 },
  "recordsPath": "data.results",
  "fields": { "<field>": { "sources": [{ "path": "title" }], "allowMissing": false } },
  "exclude": [{ "path": "isListed", "equals": false }]
}

browser — use this only when no JSON endpoint carries the records.
{
  "recipeFormatVersion": 1,
  "kind": "browser",
  "request": { "urlTemplate": "https://…?q={keywords}", "waitFor": { "kind": "css", "selector": ".job-card" }, "waitForTimeoutMs": 15000 },
  "pagination": null | { "kind": "nextLink", "locator": { "kind": "role", "role": "link", "name": "Next" }, "maxPages": 3 },
  "rows": { "kind": "css", "selector": ".job-card" },
  "fields": { "<field>": { "locator": { "kind": "css", "selector": "h2 a" }, "source": "text", "allowMissing": false } },
  "emptyState": { "kind": "text", "text": "No results" } | null
}

Rules:
- Extract exactly the schema's fields. No extras, no omissions.
- "allowMissing" must be false for required fields and true for optional ones.
- Paths are dotted: "location.name", "categories.allLocations[0]". "$" is the document root.
- "rows" must match one element per record. Prefer a stable structural selector over
  a generated class name that looks hashed.
- Field sources are tried in order — list a fallback when the observation shows the
  same value living in more than one place.
- Put the user's search terms in the template as {keywords} and {location} when the
  site supports them. Omit them if it does not; results are filtered afterwards anyway.
- Return only the JSON object.`;

export function buildUserPrompt(schema: DataSchema, observation: Observation): string {
  const fields = schema.fields
    .map((field) => `  ${field.name} (${field.type}, ${field.required ? "required" : "optional"}): ${field.description}`)
    .join("\n");

  const json =
    observation.json.length > 0
      ? observation.json
          .map((candidate) => `--- ${candidate.url} (HTTP ${candidate.status})\n${JSON.stringify(candidate.sample, null, 2)}`)
          .join("\n\n")
      : "(none — this site did not fetch any JSON carrying records)";

  return `TARGET: ${observation.url}

SCHEMA "${schema.name}":
${fields}

JSON ENDPOINTS OBSERVED:
${json}

RENDERED PAGE:
title: ${observation.dom?.title ?? "(none)"}

text:
${observation.dom?.text.slice(0, 4000) ?? "(none)"}

html:
${observation.dom?.html.slice(0, 30_000) ?? "(none)"}`;
}

export function buildRetryPrompt(previous: string, failure: string): string {
  return `Your previous recipe was rejected.

RECIPE:
${previous}

FAILURE:
${failure}

Return a corrected complete recipe as JSON. Do not return a patch or an explanation.`;
}

export function buildRepairPrompt(previousRecipe: string, failure: string): string {
  return `A recipe that used to work has stopped working — the site changed.

PREVIOUS RECIPE (now broken):
${previousRecipe}

OBSERVED FAILURE:
${failure}

Fresh observations of the changed site follow. Return a complete replacement recipe
as JSON, targeting the same schema.`;
}
