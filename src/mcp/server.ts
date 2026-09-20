/**
 * Pilot as an MCP server.
 *
 * This is the point of the whole project, stated in one place: an agent that
 * needs data from a site with no API can compile one, on the spot, and the tool
 * it just built outlives the conversation. Every later call is deterministic
 * code — no browser agent, no tokens, no drift.
 *
 * Transport is stdio, which means **stdout belongs to JSON-RPC**. Nothing here
 * may print. That is why these handlers call `compile()` and `executePilot()`
 * directly instead of reusing the `cli/` functions, which write to stdout: one
 * stray `process.stdout.write` corrupts the protocol stream and the client
 * disconnects with a parse error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JOBS_CAPABILITY, JOBS_SCHEMA, type EmploymentType, type JobQuery } from "../capability/jobs.js";
import { describeFields } from "../capability/fields.js";
import { CapabilityRegistry, type CapabilityDefinition } from "../capability/registry.js";
import { PilotStore } from "../pilots/store.js";
import { Registry, withRegistry } from "../registry/client.js";
import { executePilot } from "../runtime/execute.js";
import { pilot as createSdk } from "../sdk/index.js";
import type { PilotEnv } from "../shared/env.js";
import { toPilotError } from "../shared/errors.js";
import { PILOT_ID_PATTERN } from "../shared/pilot.js";
import { parseFieldList, type DataSchema } from "../shared/schema.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function text(body: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: body }] };
  if (structured) result.structuredContent = structured;
  return result;
}

/**
 * Tool errors are returned, not thrown. A thrown error reaches the agent as a
 * protocol failure it cannot reason about; `isError` with the real message
 * lets it read what went wrong and try something else.
 */
function failure(cause: unknown): ToolResult {
  const error = toPilotError(cause);
  return {
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    isError: true,
  };
}

/** `indeed.com` → `indeed`, `www.talent.com` → `talent`. */
function deriveId(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".").filter((part) => part !== "co" && part !== "com");
  const candidate = (parts.at(-1) === "io" || parts.length === 1 ? parts[0] : parts.at(-2) ?? parts[0])!;
  return candidate.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function buildServer(env: PilotEnv): McpServer {
  const server = new McpServer(
    { name: "pilot", version: "0.1.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Pilot compiles websites into reusable data APIs. Use pilot_search for job " +
        "boards and pilot_run for any other compiled Pilot. If the data you need is " +
        "on a site with no Pilot yet, use pilot_create once — it writes an extraction " +
        "script that then runs forever without a model. Check pilot_registry_search " +
        "before compiling: someone may already have done it.",
    },
  );

  // --- Using what already exists ------------------------------------------

  server.registerTool(
    "pilot_list",
    {
      title: "List installed Pilots",
      description:
        "Show the compiled Pilots available on this machine, what site each targets, " +
        "and which fields it extracts. Call this first to find out what you can already do.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const pilots = new PilotStore(env).all().map((item) => ({
          id: item.pilot.id,
          version: item.pilot.version,
          target: item.pilot.target.name,
          url: item.pilot.target.url,
          capability: item.pilot.capability,
          fields: item.pilot.schema.fields.map((field) => field.name),
          enabled: item.config.enabled,
          needsBrowser: item.pilot.artifact.needsBrowser,
        }));
        if (pilots.length === 0) {
          return text("No Pilots installed. Compile one with pilot_create, or look for one with pilot_registry_search.");
        }
        const lines = pilots.map(
          (item) =>
            `${item.id}@${item.version} — ${item.target} (${item.capability ?? "ad-hoc"}) ` +
            `fields: ${item.fields.join(", ")}${item.enabled ? "" : " [disabled]"}`,
        );
        return text(lines.join("\n"), { pilots });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_fields",
    {
      title: "Show which fields the Pilots return",
      description:
        "List the fields available from a set of Pilots, and how many of them provide each one. " +
        "Call this before pilot_search when you plan to read or filter a field beyond the basics: " +
        "the schema of a capability grows as Pilots are compiled, so what is available depends on " +
        "which Pilots are installed. Fields are tiered - core is guaranteed by every source, shared " +
        "is in the capability schema but not every site fills it, and local comes from one source " +
        "only. Declared counts Pilots carrying the field; filled counts those whose samples " +
        "actually had a value, so a field declared everywhere but filled nowhere is not usable.",
      inputSchema: {
        targets: z
          .array(z.string().regex(PILOT_ID_PATTERN))
          .optional()
          .describe("Pilot ids. Omit for every enabled Pilot, matching what pilot_search would use."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ targets }) => {
      try {
        const store = new PilotStore(env);
        const registry = new CapabilityRegistry(env);
        const pilots = store.resolve(targets ?? []).map((item) => item.pilot);

        const definitions = new Map<string, CapabilityDefinition>();
        for (const pilot of pilots) {
          if (!pilot.capability || definitions.has(pilot.capability)) continue;
          const found = registry.find(pilot.capability);
          if (found) definitions.set(pilot.capability, found);
        }

        const groups = describeFields(pilots, definitions, store.samples());
        const lines = groups.flatMap((group) => [
          `${group.capability ?? "ad-hoc"} (schema ${group.schemaVersion ?? "unregistered"}) — ` +
            `${group.pilots.length} Pilot(s): ${group.pilots.join(", ")}`,
          ...group.fields.map(
            (field) =>
              `  ${field.name}: ${field.type}${field.required ? " required" : ""} ` +
              `[${field.tier}] declared ${field.available}/${field.total}` +
              `${field.measured > 0 ? `, filled ${field.populated}/${field.measured}` : ""} — ` +
              `${field.available === field.total ? "all sources" : field.providedBy.join(", ")}`,
          ),
        ]);
        return text(lines.join("\n"), { capabilities: groups });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_search",
    {
      title: "Search job boards",
      description:
        "Search across every Pilot implementing jobs.board@1, merged and deduplicated. " +
        "Name specific Pilots in `targets` to limit the search, or leave it empty to use " +
        "every enabled one. This runs compiled code against the live sites — no model, " +
        "typically a few seconds.",
      inputSchema: {
        targets: z
          .array(z.string())
          .optional()
          .describe("Pilot ids to search, e.g. ['linkedin','talent']. Empty means all enabled."),
        keywords: z.string().optional().describe("Free-text keywords, e.g. 'software intern'"),
        location: z.string().optional().describe("Location to search, e.g. 'Boston'"),
        type: z
          .enum(["internship", "full-time", "part-time", "contract", "temporary"])
          .optional()
          .describe("Employment type. Applied locally after fetching."),
        limit: z.number().int().positive().optional().describe("Max results per Pilot"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ targets, keywords, location, type, limit }) => {
      try {
        const query: JobQuery = {
          keywords,
          location,
          type: type as EmploymentType | undefined,
          limit,
        };
        const jobs = createSdk(env).capability(JOBS_CAPABILITY);
        const result = await jobs.search(...(targets ?? []), query);

        const lines = result.jobs.map(
          (job) =>
            `${job.title} — ${job.company}${job.location ? ` · ${job.location}` : ""}` +
            `${job.type === "unknown" ? "" : ` · ${job.type}`}\n  ${job.url}`,
        );
        const failed = result.sources.filter((source) => !source.ok);
        const header =
          `${result.jobs.length} job(s) from ${result.sources.length - failed.length}/${result.sources.length} source(s)` +
          failed.map((source) => `\n  ${source.pilotId} FAILED: ${source.error?.code}`).join("");

        // A broken Pilot is actionable, so say so rather than silently returning less.
        const hint = failed.some((source) => source.error?.code === "PILOT_BROKEN")
          ? "\n\nA Pilot reported PILOT_BROKEN — the site changed. pilot_repair can recompile it."
          : "";

        return text(`${header}\n\n${lines.join("\n\n")}${hint}`, {
          jobs: result.jobs,
          sources: result.sources,
        });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_run",
    {
      title: "Run any Pilot",
      description:
        "Execute one Pilot and return its raw extracted records. Use this for Pilots that " +
        "are not job boards — anything compiled with custom fields. For job boards prefer " +
        "pilot_search, which normalizes and merges across sources.",
      inputSchema: {
        id: z.string().describe("Pilot id, as shown by pilot_list"),
        keywords: z.string().optional().describe("Passed into the site's own search, if it has one"),
        location: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, keywords, location, limit }) => {
      try {
        const loaded = new PilotStore(env).get(id);
        const records = await executePilot(loaded, {
          query: { keywords: keywords ?? "", location: location ?? "", limit: limit ?? null },
        });
        return text(
          `${records.length} record(s) from ${id}\n\n${JSON.stringify(records, null, 2)}`,
          { records, fields: loaded.pilot.schema.fields.map((field) => field.name) },
        );
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  // --- Building something new ---------------------------------------------

  server.registerTool(
    "pilot_create",
    {
      title: "Compile a website into a Pilot",
      description:
        "Point this at a URL and it compiles a reusable extraction script for that site. " +
        "A model explores the page with a real browser, tests extraction until it works, " +
        "and saves a script that from then on runs with no model at all.\n\n" +
        "Use it when you need data a site has but exposes no API for, especially data you " +
        "will want more than once — the cost is paid once here, not on every later call.\n\n" +
        "Give `fields` for arbitrary data (e.g. ['title','price','url']), or `capability` " +
        "for a standard schema so results merge with other sources.\n\n" +
        "SLOW: typically 1-4 minutes, since it drives a real browser. It may exceed a " +
        "default client tool timeout. It also needs a compiler API key configured.",
      inputSchema: {
        url: z.string().url().describe("The page to compile, ideally a search-results or listing page"),
        id: z.string().optional().describe("Short Pilot id. Defaults to the site name."),
        name: z.string().optional().describe("Human-readable target name"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Field names to extract, for an ad-hoc schema. Omit to use a capability."),
        capability: z
          .string()
          .optional()
          .describe(`Capability schema to target. Currently only ${JOBS_CAPABILITY}.`),
        query: z.string().optional().describe("Sample search text the script is validated against"),
        location: z.string().optional().describe("Sample location the script is validated against"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, id, name, fields, capability, query, location }, extra) => {
      try {
        let schema: DataSchema;
        let resolvedCapability: string | null;
        if (fields && fields.length > 0) {
          resolvedCapability = null;
          schema = parseFieldList(fields.join(","));
        } else {
          resolvedCapability = capability ?? JOBS_CAPABILITY;
          if (resolvedCapability !== JOBS_CAPABILITY) {
            return text(
              `Unknown capability "${resolvedCapability}". Known: ${JOBS_CAPABILITY}. ` +
                `For anything else, pass \`fields\` instead.`,
              undefined,
            );
          }
          schema = JOBS_SCHEMA;
        }

        const pilotId = id ?? deriveId(url);
        if (!PILOT_ID_PATTERN.test(pilotId)) {
          return text(`Invalid Pilot id "${pilotId}". Use lowercase letters, digits and dashes.`);
        }

        // Compiles run for minutes. Stream what the explorer is doing so the
        // client can show progress instead of looking hung.
        const { compile } = await import("../compiler/index.js");
        const result = await compile({
          url,
          id: pilotId,
          name,
          capability: resolvedCapability,
          schema,
          query: { keywords: query ?? "", location: location ?? "" },
          headless: true,
          env,
          onProgress: (message) => {
            void extra.sendNotification({
              method: "notifications/message",
              params: { level: "info", logger: "pilot_create", data: message },
            }).catch(() => {});
          },
        });

        const store = new PilotStore(env);
        const dir = store.save(result.pilot, result.code, result.records.slice(0, 10));
        store.setEnabled(pilotId, true);

        const transport = result.pilot.artifact.needsBrowser ? "browser" : "http";
        const extras =
          result.pilot.discovered.length > 0
            ? `\nAlso available on this site (not extracted): ${result.pilot.discovered.join(", ")}`
            : "";

        return text(
          `Compiled ${pilotId}@${result.pilot.version} (${transport}, ${result.steps} steps, ` +
            `${result.attempts} attempt(s)).\n` +
            `${result.records.length} records extracted and validated against the live site.\n` +
            `Saved to ${dir}${extras}\n\n` +
            `Run it with pilot_${resolvedCapability ? "search" : "run"}. ` +
            `Share it with pilot_publish.`,
          {
            id: pilotId,
            version: result.pilot.version,
            needsBrowser: result.pilot.artifact.needsBrowser,
            recordCount: result.records.length,
            fields: schema.fields.map((field) => field.name),
            discovered: result.pilot.discovered,
            sample: result.records.slice(0, 3),
          },
        );
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_repair",
    {
      title: "Repair a Pilot whose site changed",
      description:
        "Recompile a Pilot that has stopped working. It reproduces the failure first and " +
        "leaves the Pilot alone if it still works, so this is safe to call on suspicion. " +
        "SLOW, like pilot_create.",
      inputSchema: {
        id: z.string().describe("Pilot id to repair"),
        query: z.string().optional().describe("Sample search text to validate the replacement against"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, query }, extra) => {
      try {
        const store = new PilotStore(env);
        const loaded = store.get(id);
        const previousCode = store.readScript(id);

        // Never replace a known-good script with an unproven one.
        let observed: string;
        try {
          const records = await executePilot(loaded);
          return text(`${id} still works (${records.length} records). Nothing to repair.`, {
            repaired: false,
            recordCount: records.length,
          });
        } catch (cause) {
          const error = toPilotError(cause);
          observed = `${error.code}: ${error.message}`;
        }

        const { repair } = await import("../compiler/index.js");
        const result = await repair({
          pilot: loaded.pilot,
          previousCode,
          failure: observed,
          query: { keywords: query ?? "" },
          env,
          onProgress: (message) => {
            void extra.sendNotification({
              method: "notifications/message",
              params: { level: "info", logger: "pilot_repair", data: message },
            }).catch(() => {});
          },
        });

        store.save(result.pilot, result.code, result.records.slice(0, 10));
        return text(
          `Repaired ${id}: ${loaded.pilot.version} → ${result.pilot.version} ` +
            `(${result.steps} steps, ${result.attempts} attempt(s)).\n` +
            `Reproduced failure was: ${observed}\n` +
            `${result.records.length} records extracted by the replacement.`,
          {
            repaired: true,
            from: loaded.pilot.version,
            to: result.pilot.version,
            recordCount: result.records.length,
          },
        );
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  // --- Sharing ------------------------------------------------------------

  server.registerTool(
    "pilot_registry_search",
    {
      title: "Find a Pilot someone already compiled",
      description:
        "Search the shared registry by site name, capability, or field. Check here before " +
        "pilot_create: compiling is the expensive step and someone may already have paid it. " +
        "Matches the fields a Pilot extracts and the ones its explorer merely saw, so " +
        "searching 'salary' finds sites that expose salaries.",
      inputSchema: {
        query: z.string().optional().describe("Free text. Omit to list everything published."),
        capability: z.string().optional().describe("Restrict to Pilots implementing this capability"),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, capability, limit }) => {
      try {
        if (!Registry.isConfigured(env)) {
          return text("No registry configured. Set PILOT_REGISTRY_URI to share Pilots between machines.");
        }
        const entries = await withRegistry(env, (registry) =>
          query ? registry.search(query, { capability, limit }) : registry.list(capability ?? null),
        );
        if (entries.length === 0) return text("Nothing published matches that.");

        const lines = entries.map(
          (entry) => `${entry.pilotId}@${entry.version} — ${entry.summary} (by ${entry.publisher})`,
        );
        return text(`${lines.join("\n")}\n\nInstall one with pilot_install.`, {
          results: entries.map((entry) => ({
            id: entry.pilotId,
            version: entry.version,
            capability: entry.capability,
            host: entry.host,
            publisher: entry.publisher,
            summary: entry.summary,
            fields: entry.pilot.schema.fields.map((field) => field.name),
            discovered: entry.pilot.discovered,
          })),
        });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_install",
    {
      title: "Install a Pilot from the registry",
      description:
        "Download a published Pilot onto this machine so it can be run. Note that a Pilot " +
        "is generated code that runs unsandboxed — read it before trusting one you did not compile.",
      inputSchema: {
        id: z.string().describe("Pilot id to install"),
        version: z.string().optional().describe("Specific version. Defaults to the newest."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, version }) => {
      try {
        const entry = await withRegistry(env, (registry) => registry.fetch(id, version));
        const dir = new PilotStore(env).save(entry.pilot, entry.code, entry.sample ?? undefined);
        return text(
          `Installed ${entry.pilotId}@${entry.version} from ${entry.publisher} into ${dir}.\n` +
            `${entry.summary}\n\n` +
            `This is generated code and it runs unsandboxed. Read ${entry.pilot.artifact.entry} before trusting it.`,
          { id: entry.pilotId, version: entry.version, dir, entry: entry.pilot.artifact.entry },
        );
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_publish",
    {
      title: "Publish a Pilot to the registry",
      description:
        "Share a locally compiled Pilot so other people and other agents can install it. " +
        "This uploads the extraction script and makes it visible to everyone using the same registry.",
      inputSchema: { id: z.string().describe("Pilot id to publish") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id }) => {
      try {
        const store = new PilotStore(env);
        const loaded = store.get(id);
        const code = store.readScript(id);
        const entry = await withRegistry(env, (registry) =>
          registry.publish({ pilot: loaded.pilot, code }),
        );
        return text(`Published ${entry._id} as ${entry.publisher}.\n${entry.summary}`, {
          id: entry.pilotId,
          version: entry.version,
        });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "pilot_health",
    {
      title: "Which Pilots are failing",
      description:
        "Rolling success rate per published Pilot from real runs, worst first. Use it to find " +
        "what needs repairing before anyone reports a bug — a Pilot below 50% has almost " +
        "certainly had its site change under it.",
      inputSchema: { id: z.string().optional().describe("Restrict to one Pilot") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        if (!Registry.isConfigured(env)) {
          return text("No registry configured, so no run history is being recorded.");
        }
        const rows = await withRegistry(env, (registry) => registry.healthReport(id));
        if (rows.length === 0) return text("No runs recorded yet.");

        const lines = rows.map(
          (row) =>
            `${row.pilotId}@${row.version} — ${Math.round(row.successRate * 100)}% of ${row.runs} run(s), ` +
            `avg ${row.avgRecords} records${row.lastError ? `, last error ${row.lastError}` : ""}`,
        );
        const broken = rows.filter((row) => row.successRate < 0.5);
        const hint =
          broken.length > 0
            ? `\n\n${broken.length} Pilot(s) failing more than half the time. pilot_repair ${broken[0]!.pilotId} is the next thing to do.`
            : "";
        return text(`${lines.join("\n")}${hint}`, { health: rows });
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  return server;
}

export async function startMcpServer(env: PilotEnv): Promise<void> {
  const server = buildServer(env);
  await server.connect(new StdioServerTransport());
}
