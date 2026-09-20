/**
 * `pilot publish`, `pilot install`, and the `pilot registry` subcommands.
 *
 * Installing writes exactly the same files `pilot create` would have written,
 * so an installed Pilot and a locally compiled one are indistinguishable to
 * everything downstream. The registry moves artifacts; it is not a second way
 * to run them.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PilotStore } from "../pilots/store.js";
import { withRegistry } from "../registry/client.js";
import type { RegistryEntry } from "../registry/types.js";
import type { PilotEnv } from "../shared/env.js";
import { pilotError } from "../shared/errors.js";
import { flagNumber, flagString, type ParsedArgs } from "./args.js";

/** `name`, or `name@1.2.0`. */
function splitRef(ref: string): { id: string; version?: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { id: ref };
  return { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

export function printRegistryTable(entries: RegistryEntry[]): void {
  if (entries.length === 0) {
    process.stdout.write("Nothing found.\n");
    return;
  }
  const width = Math.max(...entries.map((item) => item.pilotId.length), 2);
  process.stdout.write(`${"ID".padEnd(width)}  VERSION  PUBLISHER      DESCRIPTION\n`);
  for (const entry of entries) {
    process.stdout.write(
      `${entry.pilotId.padEnd(width)}  ${entry.version.padEnd(7)}  ` +
        `${entry.publisher.slice(0, 13).padEnd(13)}  ${entry.summary}\n`,
    );
  }
}

export async function runPublish(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write("Usage: pilot publish <id>\n");
    return 1;
  }

  const store = new PilotStore(env);
  const loaded = store.get(id);
  const code = store.readScript(id);
  const sampleFile = path.join(loaded.dir, loaded.pilot.evidence.sampleFile ?? "sample.json");
  const sample = existsSync(sampleFile) ? JSON.parse(readFileSync(sampleFile, "utf8")) : null;

  const entry = await withRegistry(env, (registry) =>
    registry.publish({ pilot: loaded.pilot, code, sample }),
  );

  process.stdout.write(
    `Published ${entry._id} to ${env.registryDb} as ${entry.publisher}.\n` +
      `  ${entry.summary}\n` +
      `  Install it anywhere with: pilot install ${entry.pilotId}\n`,
  );
  return 0;
}

export async function runInstall(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const ref = args.positional[0];
  if (!ref) {
    process.stderr.write("Usage: pilot install <id>[@version]\n");
    return 1;
  }
  const { id, version } = splitRef(ref);

  const entry = await withRegistry(env, (registry) => registry.fetch(id, version));
  const store = new PilotStore(env);
  const dir = store.save(entry.pilot, entry.code, entry.sample ?? undefined);

  process.stdout.write(
    `Installed ${entry._id} from ${entry.publisher} into ${path.relative(env.projectRoot, dir)}\n` +
      `  ${entry.summary}\n` +
      `  This is generated code that runs unsandboxed. Read ${entry.pilot.artifact.entry} before trusting it.\n`,
  );
  return 0;
}

export async function runRegistry(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const sub = args.positional[0] ?? "list";
  const rest = args.positional.slice(1);
  const capability = flagString(args, "capability") ?? null;
  const limit = flagNumber(args, "limit");
  const json = Boolean(args.flags.json);

  switch (sub) {
    case "list": {
      const entries = await withRegistry(env, (registry) => registry.list(capability));
      if (json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return 0;
      }
      printRegistryTable(entries);
      return 0;
    }

    case "search": {
      const query = rest.join(" ").trim();
      if (!query) {
        process.stderr.write("Usage: pilot registry search <text>\n");
        return 1;
      }
      const entries = await withRegistry(env, (registry) =>
        registry.search(query, { capability, limit }),
      );
      if (json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return 0;
      }
      printRegistryTable(entries);
      return 0;
    }

    case "versions": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("Usage: pilot registry versions <id>\n");
        return 1;
      }
      const versions = await withRegistry(env, (registry) => registry.versions(id));
      if (versions.length === 0) {
        process.stdout.write(`The registry has no Pilot named "${id}".\n`);
        return 1;
      }
      process.stdout.write(`${versions.join("\n")}\n`);
      return 0;
    }

    case "health": {
      const rows = await withRegistry(env, (registry) => registry.healthReport(rest[0]));
      if (json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write("No runs recorded yet. Run `pilot search` to start reporting.\n");
        return 0;
      }
      const width = Math.max(...rows.map((row) => row.pilotId.length), 2);
      process.stdout.write(`${"ID".padEnd(width)}  VERSION  RUNS  OK%   AVG RECS  LAST ERROR\n`);
      for (const row of rows) {
        const rate = `${Math.round(row.successRate * 100)}%`;
        process.stdout.write(
          `${row.pilotId.padEnd(width)}  ${row.version.padEnd(7)}  ` +
            `${String(row.runs).padStart(4)}  ${rate.padStart(4)}  ` +
            `${String(row.avgRecords).padStart(8)}  ${row.lastError ?? "—"}\n`,
        );
      }
      // Worst first, so the top line is the next thing to repair.
      const broken = rows.filter((row) => row.successRate < 0.5);
      if (broken.length > 0) {
        process.stdout.write(
          `\n${broken.length} Pilot(s) failing more than half the time. Try: pilot repair ${broken[0]!.pilotId}\n`,
        );
      }
      return 0;
    }

    default:
      throw pilotError(
        "INVALID_ARGUMENT",
        `Unknown registry subcommand "${sub}". Try list, search, versions, or health.`,
      );
  }
}
