import path from "node:path";
import { CapabilityRegistry } from "../capability/registry.js";
import { PilotStore } from "../pilots/store.js";
import { Registry, withRegistry } from "../registry/client.js";
import type { CapabilityEntry, RegistryEntry } from "../registry/types.js";
import type { PilotEnv } from "../shared/env.js";
import { compareVersions } from "../shared/version.js";
import type { ParsedArgs } from "./args.js";
import { PilotLock } from "../packages/lock.js";

export interface InstalledPackage {
  entry: RegistryEntry;
  capability: CapabilityEntry | null;
  dir: string;
}

async function capabilityNeededBy(
  registry: Registry,
  capabilities: CapabilityRegistry,
  entry: RegistryEntry,
): Promise<CapabilityEntry | null> {
  const id = entry.pilot.capability;
  if (!id) return null;

  const required = entry.pilot.capabilitySchemaVersion;
  const local = capabilities.find(id);
  if (local && (!required || compareVersions(local.version, required) >= 0)) return null;

  const remote = await registry.fetchCapability(id, required ?? undefined).catch(() => null);
  if (remote) capabilities.save(remote.definition);
  return remote;
}

async function installEntry(
  env: PilotEnv,
  registry: Registry,
  store: PilotStore,
  capabilities: CapabilityRegistry,
  entry: RegistryEntry,
): Promise<InstalledPackage> {
  const capability = await capabilityNeededBy(registry, capabilities, entry);
  const dir = store.save(entry.pilot, entry.code, entry.sample ?? undefined);
  new PilotLock(env).set(entry.pilot);
  return { entry, capability, dir };
}

export async function installPilotPackage(
  env: PilotEnv,
  id: string,
  version?: string,
): Promise<InstalledPackage> {
  const store = new PilotStore(env);
  const capabilities = new CapabilityRegistry(env);
  return withRegistry(env, async (registry) =>
    installEntry(env, registry, store, capabilities, await registry.fetch(id, version)),
  );
}

interface VersionStatus {
  id: string;
  current: string;
  latest: string | null;
  status: "outdated" | "up-to-date" | "local-newer" | "unpublished";
}

async function versionStatuses(
  registry: Registry,
  installed: ReturnType<PilotStore["all"]>,
): Promise<VersionStatus[]> {
  return Promise.all(
    installed.map(async ({ pilot }) => {
      const latest = (await registry.versions(pilot.id))[0] ?? null;
      if (!latest) return { id: pilot.id, current: pilot.version, latest, status: "unpublished" };
      const comparison = compareVersions(pilot.version, latest);
      return {
        id: pilot.id,
        current: pilot.version,
        latest,
        status: comparison < 0 ? "outdated" : comparison > 0 ? "local-newer" : "up-to-date",
      };
    }),
  );
}

export async function runOutdated(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const store = new PilotStore(env);
  const installed = args.positional.length > 0
    ? [...new Set(args.positional)].map((id) => store.get(id))
    : store.all();
  const rows = await withRegistry(env, (registry) => versionStatuses(registry, installed));

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("No Pilots installed.\n");
    return 0;
  }
  const width = Math.max(2, ...rows.map((row) => row.id.length));
  process.stdout.write(`${"ID".padEnd(width)}  CURRENT  LATEST   STATUS\n`);
  for (const row of rows) {
    process.stdout.write(
      `${row.id.padEnd(width)}  ${row.current.padEnd(7)}  ` +
        `${(row.latest ?? "—").padEnd(7)}  ${row.status}\n`,
    );
  }
  return 0;
}

export async function runUpdate(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const store = new PilotStore(env);
  const installed = args.positional.length > 0
    ? [...new Set(args.positional)].map((id) => store.get(id))
    : store.all();
  const capabilities = new CapabilityRegistry(env);

  const results = await withRegistry(env, async (registry) => {
    const statuses = await versionStatuses(registry, installed);
    const out: Array<VersionStatus & { updated: boolean }> = [];
    for (const status of statuses) {
      if (status.status !== "outdated" || !status.latest) {
        out.push({ ...status, updated: false });
        continue;
      }
      const entry = await registry.fetch(status.id, status.latest);
      await installEntry(env, registry, store, capabilities, entry);
      out.push({ ...status, current: status.latest, status: "up-to-date", updated: true });
    }
    return out;
  });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  for (const result of results) {
    if (result.updated) {
      process.stdout.write(`Updated ${result.id} to ${result.latest}\n`);
    } else if (result.status === "unpublished") {
      process.stdout.write(`${result.id}: not published; kept ${result.current}\n`);
    } else if (result.status === "local-newer") {
      process.stdout.write(`${result.id}: local ${result.current} is newer than registry ${result.latest}\n`);
    } else {
      process.stdout.write(`${result.id}: already at ${result.current}\n`);
    }
  }
  return 0;
}

export async function runUninstall(env: PilotEnv, args: ParsedArgs): Promise<number> {
  const ids = [...new Set(args.positional)];
  if (ids.length === 0) {
    process.stderr.write("Usage: pilot uninstall <id...>\n");
    return 1;
  }
  const store = new PilotStore(env);
  const lock = new PilotLock(env);
  const removed = ids.map((id) => {
    const removedPath = store.remove(id);
    lock.remove(id);
    return { id, path: removedPath };
  });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(removed, null, 2)}\n`);
  } else {
    for (const item of removed) {
      process.stdout.write(`Uninstalled ${item.id} from ${path.relative(env.projectRoot, item.path)}\n`);
    }
  }
  return 0;
}

export async function runLock(env: PilotEnv, args: ParsedArgs): Promise<number> {
  if (args.positional.length > 0) {
    process.stderr.write("Usage: pilot lock [--json]\n");
    return 1;
  }
  const pilots = new PilotStore(env).all().map((item) => item.pilot);
  const lock = new PilotLock(env);
  lock.replace(pilots);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(lock.all(), null, 2)}\n`);
  } else {
    process.stdout.write(
      `Locked ${pilots.length} Pilot${pilots.length === 1 ? "" : "s"} in ` +
        `${path.relative(env.projectRoot, env.lockFile)}\n`,
    );
  }
  return 0;
}
