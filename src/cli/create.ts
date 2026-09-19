import { compile } from "../compiler/index.js";
import { PilotStore } from "../pilots/store.js";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../capability/jobs.js";
import { parseFieldList, type DataSchema } from "../shared/schema.js";
import { PILOT_ID_PATTERN } from "../shared/pilot.js";
import type { PilotEnv } from "../shared/env.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";

/** `indeed.com` → `indeed`, `www.talent.com` → `talent`. */
function deriveId(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".").filter((part) => part !== "co" && part !== "com");
  const candidate = (parts.at(-1) === "io" || parts.length === 1 ? parts[0] : parts.at(-2) ?? parts[0])!;
  return candidate.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export async function runCreate(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const url = args.positional[0];
  if (!url) {
    process.stderr.write("Usage: pilot create <url> [--id <name>] [--fields <a,b,c>]\n");
    return 1;
  }

  const fields = flagString(args, "fields");
  const capabilityFlag = flagString(args, "capability");
  let capability: string | null;
  let schema: DataSchema;

  if (fields) {
    capability = null;
    schema = parseFieldList(fields);
  } else {
    capability = capabilityFlag ?? JOBS_CAPABILITY;
    if (capability !== JOBS_CAPABILITY) {
      process.stderr.write(`Unknown capability "${capability}". Known: ${JOBS_CAPABILITY}\n`);
      return 1;
    }
    schema = JOBS_SCHEMA;
  }

  const id = flagString(args, "id") ?? deriveId(url);
  if (!PILOT_ID_PATTERN.test(id)) {
    process.stderr.write(`Invalid Pilot id "${id}". Use lowercase letters, digits and dashes.\n`);
    return 1;
  }

  const result = await compile({
    url,
    id,
    name: flagString(args, "name"),
    capability,
    schema,
    query: {
      keywords: flagString(args, "query") ?? "",
      location: flagString(args, "location") ?? "",
    },
    maxAttempts: flagNumber(args, "attempts"),
    maxSteps: flagNumber(args, "steps"),
    // `--watch` shows the browser, which is the fastest way to see why a
    // compile is going wrong on a site that fights back.
    headless: !args.flags.watch,
    env,
    onProgress: (message) => process.stderr.write(`  ${message}\n`),
  });

  const store = new PilotStore(env);
  const dir = store.save(result.pilot, result.code, result.records.slice(0, 10));
  store.setEnabled(id, true);

  const transport = result.pilot.artifact.needsBrowser ? "browser" : "http";
  process.stdout.write(
    `\nCompiled ${id}@${result.pilot.version} (${transport}, ${result.steps} steps, ${result.attempts} attempt(s))\n` +
      `  ${result.records.length} records extracted\n` +
      `  ${dir}\n`,
  );
  if (result.pilot.discovered.length > 0) {
    process.stdout.write(`  also available here: ${result.pilot.discovered.join(", ")}\n`);
  }
  process.stdout.write(`\nTry it:  pilot search ${id}\n`);
  return 0;
}
