/**
 * Designing a capability from a sentence.
 *
 * `pilot capabilities add` already takes `--fields` and `--from`, both of which
 * need you to know the shape before you start. The shape is the hard part: a
 * capability is an interface many sites will implement, so its fields have to
 * be the ones every site can supply rather than the ones the first site
 * happens to show. That is a modelling judgement, and it is exactly the
 * judgement the compiler already makes when it designs a schema for an
 * undeclared capability — just without a page in front of it.
 *
 * This lives in `compiler/` rather than `capability/` because it talks to a
 * model, and `capability/` must never import `compiler/`.
 */
import { createModelClient, toolResult, type ChatStyleTool, type TranscriptItem } from "./model.js";
import { fieldSpecSchema, type FieldSpec } from "../shared/schema.js";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

const MAX_FIELDS = 12;

const PROPOSE_TOOL: ChatStyleTool = {
  type: "function",
  function: {
    name: "propose_capability",
    description:
      "Propose the field list for a capability. Call this exactly once, with the " +
      "fields every implementing site could realistically supply.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          description: `Between 3 and ${MAX_FIELDS} fields, most important first.`,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "camelCase identifier, e.g. pricePerNight",
              },
              type: {
                type: "string",
                enum: ["string", "number", "boolean", "url"],
                description:
                  "Extraction always yields strings; this says how to coerce. Use " +
                  "url for links, number for amounts and ratings.",
              },
              required: {
                type: "boolean",
                description:
                  "True only if a record is meaningless without it, and every site " +
                  "is certain to have it. Identity and link fields usually qualify; " +
                  "prices and ratings usually do not.",
              },
              description: {
                type: "string",
                description:
                  "One sentence, written for whoever implements this against a site. " +
                  "Say what the value is and what unit or format it is in.",
              },
            },
            required: ["name", "type", "required", "description"],
            additionalProperties: false,
          },
        },
        rationale: {
          type: "string",
          description:
            "One or two sentences on what you deliberately left out and why. Shown to " +
            "the user so they can disagree.",
        },
      },
      required: ["fields", "rationale"],
      additionalProperties: false,
    },
  },
};

const SYSTEM = `You design capabilities for Pilot.

A capability is an interface, not a scrape of one website. Many different sites
will implement it, and each one compiles a script that must fill your fields
from that site's own markup. Fields that only one site could supply make the
interface useless to the others.

Rules that matter:

- Pick the intersection, not the union. If only some sites would have it, either
  leave it out or mark it optional. Site-specific extras are added later by
  promotion, once several Pilots independently prove they agree.
- Required means "a record without this is meaningless" AND "every site has it".
  Usually that is an identity field and a link, and little else. Prices, ratings
  and dates are optional: a listing missing its price is still a listing.
- Values are not fields. A capability for hotels takes a location as a query
  parameter; it does not bake one city into its name or its schema.
- Name fields in camelCase, and say the unit in the description when there is
  one: pricePerNight is meaningless without a currency field beside it.
- Descriptions are written into every future compiler prompt for this
  capability. A vague one produces a vague extraction.

When a page is shown to you, it is one implementation, not the specification.
Use it to ground names and units in what these sites actually publish, and to
notice fields you would otherwise have missed. Do not add a field merely
because this page has it — ask first whether a competing site would have it
too, and if the answer is no, leave it out and say so in your rationale. The
compiler will pick up site-specific extras later, from evidence.

Call propose_capability exactly once.`;

export interface DesignedCapability {
  fields: FieldSpec[];
  rationale: string | null;
  model: string;
}

/** One page, already read, offered to the design as an example implementation. */
export interface PageEvidence {
  url: string;
  /** What `Explorer.goto` saw: status, title and visible text, already clipped. */
  text: string;
}

/**
 * Read one page so a design can be grounded in a real implementation.
 *
 * Deliberately a single navigation and nothing else. This is not the compiler's
 * exploration loop — no clicking, no searching, no selector testing — because
 * the question being asked is "what does this kind of page publish", and the
 * first screen answers it. Anything more is a compile, and a compile needs a
 * capability to compile against.
 */
export async function capturePage(url: string): Promise<PageEvidence> {
  const { openExplorer } = await import("./explorer.js");
  const explorer = await openExplorer({ headless: true });
  try {
    const seen = await explorer.goto(url);
    if (seen.startsWith("navigation failed")) {
      throw pilotError("SOURCE_UNAVAILABLE", `Could not read ${url}: ${seen.slice(20)}`);
    }
    return { url: explorer.currentUrl(), text: seen };
  } finally {
    await explorer.close();
  }
}

/** Turn a plain-language description into a proposed field list. */
export async function designCapability(options: {
  id: string;
  description: string;
  evidence?: PageEvidence | null;
  env: PilotEnv;
}): Promise<DesignedCapability> {
  const description = options.description.trim();
  if (!description && !options.evidence) {
    throw pilotError("INVALID_ARGUMENT", "--describe needs a sentence describing the capability.");
  }

  const client = createModelClient(options.env);
  const transcript: TranscriptItem[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `Capability id: ${options.id}\n\n` +
        (description
          ? `What it should return:\n${description}\n\n`
          : `No description was given — read the intent off the page below.\n\n`) +
        (options.evidence
          ? `One site that would implement this, ${options.evidence.url}:\n\n` +
            `${options.evidence.text}\n\n` +
            `Remember this is one of many implementations.\n\n`
          : "") +
        `Propose the field list.`,
    },
  ];

  // One turn, one tool. If the model answers with prose instead of calling the
  // tool, that is a failure worth reporting rather than something to parse out
  // of free text.
  let turn = await client.turn(transcript, [PROPOSE_TOOL]);
  let call = turn.toolCalls.find((item) => item.name === PROPOSE_TOOL.function.name);
  if (!call) {
    transcript.push(...turn.raw);
    transcript.push({
      role: "user",
      content: "Call propose_capability with the field list. Do not reply in prose.",
    });
    turn = await client.turn(transcript, [PROPOSE_TOOL]);
    call = turn.toolCalls.find((item) => item.name === PROPOSE_TOOL.function.name);
  }
  if (!call) {
    throw pilotError(
      "AI_REQUEST_FAILED",
      "The model did not propose a capability. Try --fields, or rephrase the description.",
    );
  }

  const raw = call.args as { fields?: unknown; rationale?: unknown };
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw pilotError("AI_REQUEST_FAILED", "The model proposed no fields.");
  }

  const seen = new Set<string>();
  const fields: FieldSpec[] = [];
  const problems: string[] = [];
  for (const item of raw.fields.slice(0, MAX_FIELDS)) {
    const parsed = fieldSpecSchema.safeParse(item);
    if (!parsed.success) {
      problems.push(
        `${JSON.stringify((item as { name?: unknown })?.name ?? item)}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
      continue;
    }
    if (seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    fields.push(parsed.data);
  }

  if (fields.length === 0) {
    throw pilotError(
      "AI_REQUEST_FAILED",
      `Every proposed field was malformed: ${problems.join("; ")}`,
    );
  }

  return {
    fields,
    rationale: typeof raw.rationale === "string" ? raw.rationale.trim() || null : null,
    model: client.model,
  };
}

/** Exported for the tests; keeps the tool contract in one place. */
export const CAPABILITY_DESIGN_TOOL = PROPOSE_TOOL;
export { toolResult };
