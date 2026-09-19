/** Persistent shared schemas for capability/function types. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Pilot } from "../shared/pilot.js";
import { VERSION_PATTERN } from "../shared/pilot.js";
import { dataSchemaSchema, type DataSchema, type FieldSpec } from "../shared/schema.js";
import { pilotError } from "../shared/errors.js";
import type { PilotEnv } from "../shared/env.js";

export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9.-]*@[1-9]\d*$/;

const capabilityDefinitionSchema = z.strictObject({
  capabilityFormatVersion: z.literal(1),
  id: z.string().regex(CAPABILITY_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  schema: dataSchemaSchema,
  /** Fields present when this function type was first created. */
  coreFields: z.array(z.string()),
});

export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

export interface PromotionResult {
  definition: CapabilityDefinition;
  promoted: FieldSpec[];
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

  ensure(id: string, seed: DataSchema): CapabilityDefinition {
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

  /** Promote fields implemented compatibly by multiple Pilots into the shared schema. */
  promoteFromPilots(
    id: string,
    pilots: Pilot[],
    minimumPilots = 2,
  ): PromotionResult {
    const definition = this.get(id);
    const sharedNames = new Set(definition.schema.fields.map((field) => field.name));
    const candidates = new Map<string, { field: FieldSpec; pilots: Set<string>; conflict: boolean }>();

    for (const pilot of pilots) {
      if (pilot.capability !== id) continue;
      for (const field of pilot.schemaExtensions) {
        if (sharedNames.has(field.name)) continue;
        const current = candidates.get(field.name);
        if (!current) {
          candidates.set(field.name, { field, pilots: new Set([pilot.id]), conflict: false });
          continue;
        }
        current.pilots.add(pilot.id);
        if (current.field.type !== field.type) current.conflict = true;
      }
    }

    const promoted = [...candidates.values()]
      .filter((candidate) => !candidate.conflict && candidate.pilots.size >= minimumPilots)
      .map((candidate) => ({ ...candidate.field, required: false }));
    if (promoted.length === 0) return { definition, promoted: [] };

    const next: CapabilityDefinition = {
      ...definition,
      version: bumpMinor(definition.version),
      schema: {
        ...definition.schema,
        fields: [...definition.schema.fields, ...promoted],
      },
    };
    this.write(next);
    return { definition: next, promoted };
  }

  private fileFor(id: string): string {
    if (!CAPABILITY_ID_PATTERN.test(id)) {
      throw pilotError(
        "INVALID_ARGUMENT",
        `Invalid capability id "${id}". Use a name such as jobs.board@1 or hotels.search@1.`,
      );
    }
    return path.join(this.env.capabilitiesDir, `${id}.json`);
  }

  private readFile(file: string): CapabilityDefinition {
    return capabilityDefinitionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  private write(definition: CapabilityDefinition): void {
    mkdirSync(this.env.capabilitiesDir, { recursive: true });
    writeFileSync(this.fileFor(definition.id), `${JSON.stringify(definition, null, 2)}\n`);
  }
}

function bumpMinor(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `${major ?? 1}.${(minor ?? 0) + 1}.0`;
}
