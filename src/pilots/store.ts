/**
 * Pilots are files on disk: `pilots/<id>/<version>/pilot.json`.
 *
 * There is no registry service and no database. Loading is a directory scan,
 * publishing is a commit, and inspecting a Pilot is `cat`.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parsePilot, pilotConfigFileSchema, type Pilot, type PilotConfig } from "../shared/pilot.js";
import { pilotError } from "../shared/errors.js";
import { loadEnv, type PilotEnv } from "../shared/env.js";
import type { RawRecord } from "../shared/schema.js";
import { compareVersions } from "../shared/version.js";

export interface LoadedPilot {
  pilot: Pilot;
  config: PilotConfig;
  dir: string;
  projectRoot: string;
}

export class PilotStore {
  private readonly env: PilotEnv;
  private pilots: Map<string, LoadedPilot> | null = null;

  constructor(env: PilotEnv = loadEnv()) {
    this.env = env;
  }

  /** Latest version of every Pilot on disk, with its config applied. */
  all(): LoadedPilot[] {
    if (this.pilots === null) this.pilots = this.scan();
    return [...this.pilots.values()].sort((a, b) => a.pilot.id.localeCompare(b.pilot.id));
  }

  enabled(): LoadedPilot[] {
    return this.all().filter((item) => item.config.enabled);
  }

  get(id: string): LoadedPilot {
    if (this.pilots === null) this.pilots = this.scan();
    const found = this.pilots.get(id);
    if (!found) {
      const known = [...this.pilots.keys()].join(", ") || "none installed";
      throw pilotError("UNKNOWN_PILOT", `No Pilot named "${id}". Available: ${known}`, { pilotId: id });
    }
    return found;
  }

  /**
   * The selection rule behind `search()`, `search("indeed")`, and
   * `search("indeed", "linkedin")`: no names means every enabled Pilot; naming
   * one runs exactly that one, enabled or not — an explicit request is the
   * caller's decision, not a default.
   */
  resolve(ids: readonly string[]): LoadedPilot[] {
    if (ids.length === 0) {
      const enabled = this.enabled();
      if (enabled.length === 0) {
        throw pilotError(
          "NO_PILOTS_ENABLED",
          "No Pilots are enabled. Compile one with `pilot create <url>`, or enable one with `pilot enable <id>`.",
        );
      }
      return enabled;
    }
    return [...new Set(ids)].map((id) => this.get(id));
  }

  reload(): void {
    this.pilots = null;
  }

  /** Write a compiled Pilot and its script to `pilots/<id>/<version>/`. */
  save(pilot: Pilot, code: string, sample?: unknown): string {
    const dir = path.join(this.env.pilotsDir, pilot.id, pilot.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, pilot.artifact.entry), code.endsWith("\n") ? code : `${code}\n`);
    writeFileSync(path.join(dir, "pilot.json"), `${JSON.stringify(pilot, null, 2)}\n`);
    if (sample !== undefined) {
      writeFileSync(path.join(dir, "sample.json"), `${JSON.stringify(sample, null, 2)}\n`);
    }
    this.reload();
    return dir;
  }

  /**
   * The records this Pilot returned when it was last validated. Evidence of
   * what its fields actually contain, which is what promotion compares.
   * Missing or unreadable samples are simply no evidence, never an error.
   */
  readSample(id: string): RawRecord[] {
    const loaded = this.get(id);
    const file = path.join(loaded.dir, loaded.pilot.evidence.sampleFile ?? "sample.json");
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? (parsed as RawRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** Sample records for every installed Pilot, keyed by id. */
  samples(): Map<string, RawRecord[]> {
    return new Map(this.all().map((item) => [item.pilot.id, this.readSample(item.pilot.id)]));
  }

  /** The script source of an installed Pilot, for repair and for reading. */
  readScript(id: string): string {
    const loaded = this.get(id);
    return readFileSync(path.join(loaded.dir, loaded.pilot.artifact.entry), "utf8");
  }

  setEnabled(id: string, enabled: boolean): void {
    const configs = this.readConfig();
    const existing = configs.find((item) => item.id === id);
    if (existing) {
      existing.enabled = enabled;
    } else {
      configs.push({ id, enabled, variables: {} });
    }
    this.writeConfig(configs);
    this.reload();
  }

  setVariables(id: string, variables: Record<string, string>): void {
    const configs = this.readConfig();
    const existing = configs.find((item) => item.id === id);
    if (existing) {
      existing.variables = { ...existing.variables, ...variables };
    } else {
      configs.push({ id, enabled: true, variables });
    }
    this.writeConfig(configs);
    this.reload();
  }

  /** Remove every installed version of one Pilot and its local configuration. */
  remove(id: string): string {
    const loaded = this.get(id);
    const root = path.resolve(this.env.pilotsDir);
    const target = path.resolve(root, loaded.pilot.id);
    if (path.dirname(target) !== root) {
      throw pilotError("INVALID_ARGUMENT", `Refusing to remove Pilot outside ${root}`);
    }

    rmSync(target, { recursive: true, force: false });
    this.writeConfig(this.readConfig().filter((item) => item.id !== loaded.pilot.id));
    this.reload();
    return target;
  }

  private readConfig(): PilotConfig[] {
    if (!existsSync(this.env.configFile)) return [];
    const parsed = pilotConfigFileSchema.parse(
      JSON.parse(readFileSync(this.env.configFile, "utf8")),
    );
    return parsed.pilots;
  }

  private writeConfig(pilots: PilotConfig[]): void {
    mkdirSync(path.dirname(this.env.configFile), { recursive: true });
    writeFileSync(this.env.configFile, `${JSON.stringify({ pilots }, null, 2)}\n`);
  }

  private scan(): Map<string, LoadedPilot> {
    const out = new Map<string, LoadedPilot>();
    if (!existsSync(this.env.pilotsDir)) return out;
    const configs = this.readConfig();

    for (const entry of readdirSync(this.env.pilotsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pilotDir = path.join(this.env.pilotsDir, entry.name);
      const versions = readdirSync(pilotDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
        .sort(compareVersions);
      const latest = versions.at(-1);
      if (!latest) continue;

      const dir = path.join(pilotDir, latest);
      const file = path.join(dir, "pilot.json");
      if (!existsSync(file)) continue;

      // One malformed Pilot must not take down every other Pilot.
      try {
        const pilot = parsePilot(JSON.parse(readFileSync(file, "utf8")));
        const config = configs.find((item) => item.id === pilot.id) ?? {
          id: pilot.id,
          enabled: true,
          variables: {},
        };
        out.set(pilot.id, { pilot, config, dir, projectRoot: this.env.projectRoot });
      } catch (cause) {
        process.stderr.write(`warning: skipping ${file}: ${(cause as Error).message}\n`);
      }
    }
    return out;
  }
}
