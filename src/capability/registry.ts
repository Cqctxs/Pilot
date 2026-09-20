/** Persistent shared schemas for capability/function types. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Pilot } from "../shared/pilot.js";
import { VERSION_PATTERN } from "../shared/pilot.js";
import { dataSchemaSchema, type DataSchema, type FieldSpec, type RawRecord } from "../shared/schema.js";
import { fieldShape, type ValueShape } from "./valueshape.js";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9.-]*@[1-9]\d*$/;

/** `jobs.search` — the same id with the major version left off. */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9.-]*$/;

/**
 * Ids that were renamed, and the ids they became.
 *
 * A capability id is written into every Pilot compiled against it and into
 * every registry document, so a rename cannot be a find-and-replace — artifacts
 * published before it, and Pilots on machines that have not updated, still say
 * the old name. They keep resolving. The entry is cheap and permanent; the
 * alternative is a Pilot that cannot find its own interface.
 */
const RENAMED: Readonly<Record<string, string>> = {
  "jobs.board@1": "jobs.search@1",
  "jobs.board": "jobs.search@1",
  jobs: "jobs.search@1",
};

/**
 * The current name for an id, without touching the disk.
 *
 * Use this on every comparison between a capability someone asked for and the
 * one recorded in a Pilot: the Pilot may have been compiled, published or
 * installed before a rename, and two spellings of one interface must not read
 * as two interfaces. It deliberately does not expand a bare name — `@1` and
 * `@2` really are different contracts, and guessing between them is the kind
 * of silent mismatch this function exists to prevent.
 */
export function canonicalCapability(id: string | null | undefined): string | null {
  if (!id) return null;
  return RENAMED[id] ?? id;
}

/**
 * Every id that means this capability, current name first.
 *
 * A registry document is written once and read forever, so a Pilot published
 * as `jobs.board@1` still says so long after the interface was renamed. Queries
 * ask for all of them; only new writes use the current name. This is also why
 * renames are cheap here but not free — the list only ever grows.
 */
export function capabilityAliases(id: string): string[] {
  const old = Object.entries(RENAMED)
    .filter(([from, to]) => to === id && from !== id)
    .map(([from]) => from);
  return [id, ...old];
}

export const capabilityDefinitionSchema = z.strictObject({
  capabilityFormatVersion: z.literal(1),
  id: z.string().regex(CAPABILITY_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  schema: dataSchemaSchema,
  /** Fields present when this function type was first created. */
  coreFields: z.array(z.string()),
});

export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

export interface PromotionOptions {
  /** How many Pilots must implement a field before it joins the shared schema. */
  minimumPilots?: number;
  /**
   * Sample records per Pilot id. Supplying them turns on the value-shape check,
   * which is the difference between "two sites use this name" and "two sites
   * mean the same thing by it".
   */
  samples?: ReadonlyMap<string, readonly RawRecord[]>;
}

/** A field that had the votes but failed a compatibility check. */
export interface BlockedPromotion {
  field: string;
  reason: string;
}

export interface PromotionResult {
  definition: CapabilityDefinition;
  promoted: FieldSpec[];
  blocked: BlockedPromotion[];
}

export class CapabilityRegistry {
  constructor(private readonly env: Pick<PilotEnv, "capabilitiesDir">) {}

  all(): CapabilityDefinition[] {
    if (!existsSync(this.env.capabilitiesDir)) return [];
    return readdirSync(this.env.capabilitiesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readFile(path.join(this.env.capabilitiesDir, entry.name)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): CapabilityDefinition {
    const file = this.fileFor(id);
    if (!existsSync(file)) {
      throw pilotError(
        "UNSUPPORTED_CAPABILITY",
        `Unknown capability: ${id}. Create it with --capability ${id} --fields fieldA,fieldB.`,
      );
    }
    return this.readFile(file);
  }

  find(id: string): CapabilityDefinition | null {
    const file = this.fileFor(id);
    return existsSync(file) ? this.readFile(file) : null;
  }

  /**
   * Turn what someone typed into the id actually stored on disk.
   *
   * The `@1` is a *major* version — the marker that says an interface changed
   * shape incompatibly. That matters enormously to a stored artifact and almost
   * never to the person at the keyboard, who has exactly one major installed
   * and should be able to type `jobs.search`. So the suffix stays in every
   * definition, every Pilot manifest and every registry document, and becomes
   * optional in everything a human types. It is required again only when two
   * majors are installed at once, which is precisely when leaving it off would
   * be a guess.
   */
  resolve(id: string): string {
    const renamed = RENAMED[id];
    if (renamed) return renamed;
    if (CAPABILITY_ID_PATTERN.test(id)) return id;
    if (!CAPABILITY_NAME_PATTERN.test(id)) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `Invalid capability id "${id}". Use a name such as jobs.search, or jobs.search@2 ` +
          `to pin a major version.`,
      );
    }
    const installed = this.all().filter((definition) => definition.id.split("@")[0] === id);
    if (installed.length > 1) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `${id} is installed at ${installed.length} major versions ` +
          `(${installed.map((definition) => definition.id).join(", ")}). ` +
          `They are different interfaces, so name the one you mean.`,
      );
    }
    // Nothing installed resolves to @1 rather than failing: declaring a brand
    // new capability is the main reason to type a name that is not there yet.
    return installed[0]?.id ?? `${id}@1`;
  }

  /**
   * Declare a capability up front, before any Pilot implements it.
   *
   * This is the order the rest of the system assumes and the one `ensure`
   * cannot express: an interface exists first, and implementations are sought
   * against it. `ensure` exists for the other direction — a Pilot compiled
   * against an id nobody had declared yet — and quietly returns whatever is
   * already there. Declaring is not quiet: redefining a capability that Pilots
   * have already compiled against would change what their recorded
   * `capabilitySchemaVersion` refers to, so it is refused.
   */
  define(rawId: string, schema: DataSchema): CapabilityDefinition {
    const id = this.resolve(rawId);
    if (existsSync(this.fileFor(id))) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `Capability ${id} already exists. Its shape is a contract Pilots have compiled ` +
          `against — add optional fields by letting promotion find them, or declare a new ` +
          `major version such as ${id.replace(/@(\d+)$/, (_, major) => `@${Number(major) + 1}`)}.`,
      );
    }
    if (schema.fields.length === 0) {
      throw pilotError("INVALID_ARGUMENT", `Capability ${id} needs at least one field.`);
    }
    const definition: CapabilityDefinition = {
      capabilityFormatVersion: 1,
      id,
      version: "1.0.0",
      schema: { ...schema, name: id },
      coreFields: schema.fields.map((field) => field.name),
    };
    this.write(definition);
    return definition;
  }

  /**
   * Store a definition that came from somewhere else — an install pulling the
   * interface down with its implementation. Unlike `define`, this accepts a
   * revision beyond 1.0.0, because the point is to reproduce what the publisher
   * had rather than to start something new.
   */
  save(definition: CapabilityDefinition): CapabilityDefinition {
    const parsed = capabilityDefinitionSchema.parse(definition);
    this.write(parsed);
    return parsed;
  }

  /** Forget a local definition. Returns false if there was nothing to forget. */
  remove(rawId: string): boolean {
    const file = this.fileFor(rawId);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  ensure(rawId: string, seed: DataSchema): CapabilityDefinition {
    const id = this.resolve(rawId);
    const file = this.fileFor(id);
    if (existsSync(file)) return this.readFile(file);
    const definition: CapabilityDefinition = {
      capabilityFormatVersion: 1,
      id,
      version: "1.0.0",
      schema: { ...seed, name: id },
      coreFields: seed.fields.map((field) => field.name),
    };
    this.write(definition);
    return definition;
  }

  /**
   * Promote fields implemented compatibly by multiple Pilots into the shared
   * schema — the mechanism that lets a capability grow from evidence instead of
   * from a committee.
   *
   * Agreement has to be demonstrated on two axes, because a shared column is
   * only worth having if every source fills it with comparable data. Two Pilots
   * must declare the field with the same type, AND the values they actually
   * returned must have the same shape. The second check is the one that earns
   * its keep: `postedAt` is a string everywhere, but a site that reports
   * "6 hours ago" and a site that reports "2026-09-14" do not belong in one
   * column, and nothing about the name or the type says so.
   *
   * A field that fails either check is not lost — it stays on the Pilot that
   * extracts it, and is reported in `blocked` so the disagreement is visible
   * rather than silent.
   */
  promoteFromPilots(
    id: string,
    pilots: Pilot[],
    options: PromotionOptions = {},
  ): PromotionResult {
    const minimumPilots = options.minimumPilots ?? 2;
    const samples = options.samples;
    const definition = this.get(id);
    const sharedNames = new Set(definition.schema.fields.map((field) => field.name));
    const candidates = new Map<
      string,
      { field: FieldSpec; pilots: Set<string>; types: Set<string>; shapes: Map<string, ValueShape> }
    >();

    for (const pilot of pilots) {
      if (canonicalCapability(pilot.capability) !== canonicalCapability(id)) continue;
      for (const field of pilot.schemaExtensions) {
        if (sharedNames.has(field.name)) continue;
        let current = candidates.get(field.name);
        if (!current) {
          current = { field, pilots: new Set(), types: new Set(), shapes: new Map() };
          candidates.set(field.name, current);
        }
        current.pilots.add(pilot.id);
        current.types.add(field.type);
        const shape = samples ? fieldShape(samples.get(pilot.id) ?? [], field.name) : null;
        if (shape !== null) current.shapes.set(pilot.id, shape);
      }
    }

    const promoted: FieldSpec[] = [];
    const blocked: BlockedPromotion[] = [];

    for (const [name, candidate] of candidates) {
      if (candidate.pilots.size < minimumPilots) continue;
      if (candidate.types.size > 1) {
        blocked.push({
          field: name,
          reason: `declared as ${[...candidate.types].sort().join(" and ")} by different Pilots`,
        });
        continue;
      }
      const shapes = new Set(candidate.shapes.values());
      if (shapes.size > 1) {
        const detail = [...candidate.shapes.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([pilotId, shape]) => `${pilotId}=${shape}`)
          .join(", ");
        blocked.push({ field: name, reason: `values look different (${detail})` });
        continue;
      }
      promoted.push({ ...candidate.field, required: false });
    }

    if (promoted.length === 0) return { definition, promoted: [], blocked };

    const next: CapabilityDefinition = {
      ...definition,
      version: bumpMinor(definition.version),
      schema: {
        ...definition.schema,
        fields: [...definition.schema.fields, ...promoted],
      },
    };
    this.write(next);
    return { definition: next, promoted, blocked };
  }

  /**
   * Where this capability lives, current name first.
   *
   * A rename has to work on machines that installed the definition under its
   * old name — they have `jobs.board@1.json` on disk and nothing else, and
   * resolving only forwards would tell them their own interface is missing. So
   * reads accept whichever alias is actually present, and writes always land on
   * the current name, which migrates a machine the first time it saves.
   */
  private fileFor(id: string): string {
    const canonical = this.resolve(id);
    const current = path.join(this.env.capabilitiesDir, `${canonical}.json`);
    if (existsSync(current)) return current;
    for (const alias of capabilityAliases(canonical).slice(1)) {
      const older = path.join(this.env.capabilitiesDir, `${alias}.json`);
      if (existsSync(older)) return older;
    }
    return current;
  }

  private readFile(file: string): CapabilityDefinition {
    return capabilityDefinitionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  private write(definition: CapabilityDefinition): void {
    // coreFields is the promise a capability makes to everyone who calls it:
    // these are the fields every implementation has. Promoted fields are
    // optional and may be sparse, but a core field disappearing would silently
    // break every caller, so it is an error rather than a judgement call.
    const present = new Set(definition.schema.fields.map((field) => field.name));
    const missing = definition.coreFields.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `Capability ${definition.id} cannot drop core field(s): ${missing.join(", ")}.`,
      );
    }
    mkdirSync(this.env.capabilitiesDir, { recursive: true });
    writeFileSync(this.fileFor(definition.id), `${JSON.stringify(definition, null, 2)}\n`);
  }
}

function bumpMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major ?? 1}.${(minor ?? 0) + 1}.0`;
}
