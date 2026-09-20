/**
 * What fields can I actually get?
 *
 * Once a capability's schema can grow (promotion) and individual Pilots can add
 * fields of their own (extensions), that question stops having one answer. A
 * field can be in any of three tiers, and the difference matters to whoever is
 * about to write code against the results:
 *
 *   core    every implementation of the capability guarantees it
 *   shared  in the capability's schema, but only some sites actually fill it
 *   local   one Pilot extracts it; the others will return null
 *
 * The number that makes this usable is coverage: when a search merges results
 * from several Pilots, a field only one of them provides is mostly nulls. This
 * module computes that, and nothing else — no filesystem, no printing, so the
 * CLI and the MCP server can render the same answer their own way.
 */
import type { Pilot } from "../shared/pilot.js";
import type { FieldSpec, RawRecord } from "../shared/schema.js";
import type { CapabilityDefinition } from "./registry.js";

export type FieldTier = "core" | "shared" | "local";

export interface FieldAvailability {
  name: string;
  type: FieldSpec["type"];
  required: boolean;
  description: string;
  tier: FieldTier;
  /** Pilot ids that extract this field, sorted. */
  providedBy: string[];
  /** How many of the Pilots in this group declare it. */
  available: number;
  total: number;
  /**
   * Declaring a field is not the same as filling it: a Pilot can carry
   * `postedAt` in its schema and return null for it on every record. These
   * count the Pilots whose saved samples actually contain a value, out of the
   * Pilots that have samples at all. `measured` of 0 means no evidence either
   * way, which is different from a field that is measurably always empty.
   */
  populated: number;
  measured: number;
}

export interface CapabilityFields {
  /** `null` for ad-hoc Pilots compiled with `--fields`. */
  capability: string | null;
  schemaVersion: string | null;
  pilots: string[];
  fields: FieldAvailability[];
}

/**
 * Group Pilots by capability and describe the fields each group can produce.
 * Pilots that implement no capability are grouped together as ad-hoc, where
 * every field is by definition local to its own Pilot.
 */
export function describeFields(
  pilots: readonly Pilot[],
  definitions: ReadonlyMap<string, CapabilityDefinition>,
  samples: ReadonlyMap<string, readonly RawRecord[]> = new Map(),
): CapabilityFields[] {
  const groups = new Map<string | null, Pilot[]>();
  for (const pilot of pilots) {
    const key = pilot.capability;
    const existing = groups.get(key);
    if (existing) existing.push(pilot);
    else groups.set(key, [pilot]);
  }

  return [...groups.entries()]
    .sort((a, b) => (a[0] ?? "\uffff").localeCompare(b[0] ?? "\uffff"))
    .map(([capability, members]) => describeGroup(capability, members, definitions, samples));
}

function describeGroup(
  capability: string | null,
  members: Pilot[],
  definitions: ReadonlyMap<string, CapabilityDefinition>,
  samples: ReadonlyMap<string, readonly RawRecord[]>,
): CapabilityFields {
  const definition = capability ? definitions.get(capability) ?? null : null;
  const coreNames = new Set(definition?.coreFields ?? []);
  const sharedOrder = new Map(
    (definition?.schema.fields ?? []).map((field, index) => [field.name, index] as const),
  );

  // A field's canonical spec comes from the capability when it has one, so the
  // shared description wins over whatever one site called it.
  const specs = new Map<string, FieldSpec>();
  for (const field of definition?.schema.fields ?? []) specs.set(field.name, field);

  const providers = new Map<string, Set<string>>();
  for (const pilot of members) {
    for (const field of pilot.schema.fields) {
      if (!specs.has(field.name)) specs.set(field.name, field);
      const set = providers.get(field.name);
      if (set) set.add(pilot.id);
      else providers.set(field.name, new Set([pilot.id]));
    }
  }

  const total = members.length;

  const fields: FieldAvailability[] = [...specs.entries()]
    .map(([name, spec]) => {
      const providedBy = [...(providers.get(name) ?? [])].sort();
      // Only a Pilot that declares the field can be evidence about it: the
      // runtime drops undeclared keys, so its samples say nothing either way.
      const measurable = members.filter(
        (pilot) => providedBy.includes(pilot.id) && (samples.get(pilot.id) ?? []).length > 0,
      );
      const populated = measurable.filter((pilot) =>
        (samples.get(pilot.id) ?? []).some((record) => {
          const value = record[name];
          return value !== undefined && value !== null && String(value).trim() !== "";
        }),
      ).length;
      const tier: FieldTier = coreNames.has(name)
        ? "core"
        : sharedOrder.has(name)
          ? "shared"
          : "local";
      return {
        name,
        type: spec.type,
        required: spec.required,
        description: spec.description,
        tier,
        providedBy,
        available: providedBy.length,
        total,
        populated,
        measured: measurable.length,
      };
    })
    .sort(compareFields(sharedOrder));

  return {
    capability,
    schemaVersion: definition?.version ?? null,
    pilots: members.map((pilot) => pilot.id).sort(),
    fields,
  };
}

const TIER_RANK: Record<FieldTier, number> = { core: 0, shared: 1, local: 2 };

/**
 * Core and shared fields keep the capability's own order, which reads the way
 * the schema was written. Site-local fields have no canonical order, so the
 * ones more sources agree on come first.
 */
function compareFields(sharedOrder: ReadonlyMap<string, number>) {
  return (a: FieldAvailability, b: FieldAvailability): number => {
    const tier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tier !== 0) return tier;
    const left = sharedOrder.get(a.name);
    const right = sharedOrder.get(b.name);
    if (left !== undefined && right !== undefined) return left - right;
    if (a.available !== b.available) return b.available - a.available;
    return a.name.localeCompare(b.name);
  };
}
