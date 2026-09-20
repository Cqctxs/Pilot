/**
 * The Pilot registry, backed by MongoDB.
 *
 * Pilots stay plain files on disk; this is how they travel between machines.
 * `publish` uploads one compiled version, `install` brings it down, `search`
 * finds one you did not know existed, and `report` records what happened when
 * it ran — which is how the registry learns that a site changed before a human
 * does.
 *
 * The driver is imported lazily. `runtime/` and `sdk/` must be able to run a
 * compiled Pilot with no database and no network beyond the target site, so
 * nothing on that path may pull in a Mongo connection by accident.
 */
import type { Collection, Db, MongoClient } from "mongodb";
import type { PilotEnv } from "../shared/env.js";
import { pilotError } from "../shared/errors.js";
import type { Pilot } from "../shared/pilot.js";
import {
  capabilityEntrySchema,
  healthEventSchema,
  registryEntrySchema,
  type CapabilityEntry,
  type HealthEvent,
  type HealthSummary,
  type RegistryEntry,
} from "./types.js";
import type { CapabilityDefinition } from "../capability/registry.js";
import { compareVersions } from "../shared/version.js";

const ENTRIES = "pilots";
const HEALTH = "health";
const CAPABILITIES = "capabilities";

export interface PublishInput {
  pilot: Pilot;
  code: string;
  sample?: unknown;
}

export interface SearchOptions {
  capability?: string | null;
  limit?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function normalizedTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${pathname}`;
  } catch {
    return url;
  }
}

/**
 * The text blob a search runs against. Deliberately includes `discovered` —
 * the fields the explorer saw but did not extract — because that is often what
 * someone is actually looking for ("does anything give me salary?").
 */
function keywordsFor(pilot: Pilot): string[] {
  const words = [
    pilot.id,
    pilot.target.name,
    hostOf(pilot.target.url),
    pilot.capability ?? "",
    ...pilot.schema.fields.map((field) => field.name),
    ...pilot.discovered,
  ];
  const parts = words.flatMap((word) => word.toLowerCase().split(/[^a-z0-9.@+-]+/i));
  return [...new Set(parts)].filter((word) => word.length > 1);
}

function summaryFor(pilot: Pilot): string {
  const transport = pilot.artifact.needsBrowser ? "browser" : "http";
  const fields = pilot.schema.fields.map((field) => field.name).join(", ");
  const capability = pilot.capability ?? `ad-hoc (${fields})`;
  return `${pilot.target.name} — ${capability}, ${transport}, ${pilot.evidence.recordCount} records at compile time`;
}

export class Registry {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly env: PilotEnv,
  ) {}

  static isConfigured(env: PilotEnv): boolean {
    return env.registryUri !== null;
  }

  static async connect(env: PilotEnv): Promise<Registry> {
    if (!env.registryUri) {
      throw pilotError(
        "REGISTRY_NOT_CONFIGURED",
        "No registry configured. Set PILOT_REGISTRY_URI to a MongoDB connection string in .env.",
      );
    }
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(env.registryUri, {
      serverSelectionTimeoutMS: 10_000,
      appName: "pilot-cli",
    });
    try {
      await client.connect();
    } catch (cause) {
      await client.close().catch(() => {});
      throw pilotError(
        "REGISTRY_UNAVAILABLE",
        `Could not reach the registry: ${(cause as Error).message}`,
      );
    }
    const registry = new Registry(client, client.db(env.registryDb), env);
    await registry.ensureIndexes();
    return registry;
  }

  private entries(): Collection<RegistryEntry> {
    return this.db.collection<RegistryEntry>(ENTRIES);
  }

  private healthEvents(): Collection<HealthEvent> {
    return this.db.collection<HealthEvent>(HEALTH);
  }

  private capabilities(): Collection<CapabilityEntry> {
    return this.db.collection<CapabilityEntry>(CAPABILITIES);
  }

  /**
   * Created on connect rather than in a setup script: the registry has to work
   * against a database nobody prepared, or the first thing a new teammate does
   * is fail.
   */
  private async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.entries().createIndex({ pilotId: 1, version: -1 }),
      this.entries().createIndex({ capability: 1 }),
      this.entries().createIndex({ host: 1 }),
      this.entries().createIndex(
        { pilotId: "text", keywords: "text", summary: "text" },
        { name: "pilot_text", weights: { pilotId: 10, keywords: 5, summary: 1 } },
      ),
      this.healthEvents().createIndex({ pilotId: 1, at: -1 }),
      this.capabilities().createIndex({ capabilityId: 1, version: -1 }),
    ]);
  }

  /** Idempotent: publishing the same version twice replaces it in place. */
  async publish(input: PublishInput): Promise<RegistryEntry> {
    const { pilot, code, sample } = input;
    const entry = registryEntrySchema.parse({
      _id: `${pilot.id}@${pilot.version}`,
      pilotId: pilot.id,
      version: pilot.version,
      capability: pilot.capability,
      host: hostOf(pilot.target.url),
      pilot,
      code,
      sample: sample ?? null,
      publisher: this.env.publisher,
      publishedAt: new Date().toISOString(),
      keywords: keywordsFor(pilot),
      summary: summaryFor(pilot),
    });
    await this.entries().replaceOne({ _id: entry._id }, entry, { upsert: true });
    return entry;
  }

  /**
   * Publish a capability definition. Idempotent per schema revision, so the
   * same definition can be pushed alongside every Pilot that implements it
   * without accumulating duplicates.
   */
  async publishCapability(definition: CapabilityDefinition): Promise<CapabilityEntry> {
    const entry = capabilityEntrySchema.parse({
      _id: `${definition.id}/${definition.version}`,
      capabilityId: definition.id,
      version: definition.version,
      definition,
      fieldNames: definition.schema.fields.map((field) => field.name),
      publisher: this.env.publisher,
      publishedAt: new Date().toISOString(),
    });
    await this.capabilities().replaceOne({ _id: entry._id }, entry, { upsert: true });
    return entry;
  }

  /** One capability revision, or the newest if no version is given. */
  async fetchCapability(id: string, version?: string): Promise<CapabilityEntry> {
    const found = version
      ? await this.capabilities().findOne({ _id: `${id}/${version}` })
      : (await this.capabilities().find({ capabilityId: id }).toArray())
          .map((item) => capabilityEntrySchema.parse(item))
          .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!found) {
      throw pilotError(
        "UNSUPPORTED_CAPABILITY",
        version
          ? `The registry has no ${id} at schema ${version}.`
          : `The registry has no capability named "${id}".`,
      );
    }
    return capabilityEntrySchema.parse(found);
  }

  /** Newest revision of every published capability. */
  async listCapabilities(): Promise<CapabilityEntry[]> {
    const found = (await this.capabilities().find().toArray()).map((item) =>
      capabilityEntrySchema.parse(item),
    );
    const latest = new Map<string, CapabilityEntry>();
    for (const entry of found) {
      const current = latest.get(entry.capabilityId);
      if (!current || compareVersions(entry.version, current.version) > 0) {
        latest.set(entry.capabilityId, entry);
      }
    }
    return [...latest.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  }

  /** One published version, or the newest if no version is given. */
  async fetch(pilotId: string, version?: string): Promise<RegistryEntry> {
    const found = version
      ? await this.entries().findOne({ _id: `${pilotId}@${version}` })
      : (await this.entries().find({ pilotId }).toArray())
          .map((item) => registryEntrySchema.parse(item))
          .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!found) {
      throw pilotError(
        "UNKNOWN_PILOT",
        version
          ? `The registry has no ${pilotId}@${version}.`
          : `The registry has no Pilot named "${pilotId}".`,
        { pilotId },
      );
    }
    return registryEntrySchema.parse(found);
  }

  async versions(pilotId: string): Promise<string[]> {
    const found = await this.entries()
      .find({ pilotId }, { projection: { version: 1 } })
      .toArray();
    return found.map((item) => item.version).sort((a, b) => compareVersions(b, a));
  }

  /** Newest version of every published Pilot. */
  async list(capability?: string | null): Promise<RegistryEntry[]> {
    const match = capability ? { capability } : {};
    const found = (await this.entries().find(match).toArray()).map((item) =>
      registryEntrySchema.parse(item),
    );
    const latest = new Map<string, RegistryEntry>();
    for (const entry of found) {
      const current = latest.get(entry.pilotId);
      if (!current || compareVersions(entry.version, current.version) > 0) {
        latest.set(entry.pilotId, entry);
      }
    }
    return [...latest.values()].sort((a, b) => a.pilotId.localeCompare(b.pilotId));
  }

  /**
   * Previously compiled implementations for the same website and capability.
   * The newest semantic version of each Pilot id is returned, with an exact
   * target URL preferred over another page on the same host.
   */
  async compatible(url: string, capability: string): Promise<RegistryEntry[]> {
    const host = hostOf(url);
    const found = (await this.entries().find({ host, capability }).toArray()).map((item) =>
      registryEntrySchema.parse(item),
    );
    const latest = new Map<string, RegistryEntry>();
    for (const entry of found) {
      const current = latest.get(entry.pilotId);
      if (!current || compareVersions(entry.version, current.version) > 0) {
        latest.set(entry.pilotId, entry);
      }
    }
    const requested = normalizedTarget(url);
    return [...latest.values()].sort((a, b) => {
      const aExact = normalizedTarget(a.pilot.target.url) === requested ? 1 : 0;
      const bExact = normalizedTarget(b.pilot.target.url) === requested ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return b.publishedAt.localeCompare(a.publishedAt);
    });
  }

  /**
   * Free-text search over the registry. Falls back to a substring match when
   * the text index is missing, so a half-configured database degrades instead
   * of erroring.
   */
  async search(query: string, options: SearchOptions = {}): Promise<RegistryEntry[]> {
    const limit = options.limit ?? 20;
    const capability = options.capability ? { capability: options.capability } : {};

    try {
      const found = await this.entries()
        .find(
          { $text: { $search: query }, ...capability },
          { projection: { score: { $meta: "textScore" } } },
        )
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .toArray();
      if (found.length > 0) return found.map((item) => registryEntrySchema.parse(item));
    } catch {
      // No text index on this deployment — fall through to the regex path.
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = await this.entries()
      .find({
        ...capability,
        $or: [
          { pilotId: { $regex: escaped, $options: "i" } },
          { host: { $regex: escaped, $options: "i" } },
          { summary: { $regex: escaped, $options: "i" } },
          { keywords: { $regex: escaped, $options: "i" } },
        ],
      })
      .limit(limit)
      .toArray();
    return found.map((item) => registryEntrySchema.parse(item));
  }

  /** Record one run. Never throws: telemetry must not break a search. */
  async report(event: Omit<HealthEvent, "at" | "reporter">): Promise<void> {
    try {
      const parsed = healthEventSchema.parse({
        ...event,
        at: new Date().toISOString(),
        reporter: this.env.publisher,
      });
      await this.healthEvents().insertOne(parsed);
    } catch {
      // Ignored by design.
    }
  }

  /**
   * Rolling success rate per published version, worst first — the queue of
   * Pilots that need recompiling.
   */
  async healthReport(pilotId?: string, sinceDays = 14): Promise<HealthSummary[]> {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const match: Record<string, unknown> = { at: { $gte: since } };
    if (pilotId) match.pilotId = pilotId;

    const rows = await this.healthEvents()
      .aggregate([
        { $match: match },
        { $sort: { at: 1 } },
        {
          $group: {
            _id: { pilotId: "$pilotId", version: "$version" },
            runs: { $sum: 1 },
            successes: { $sum: { $cond: ["$ok", 1, 0] } },
            avgRecords: { $avg: "$recordCount" },
            lastRunAt: { $max: "$at" },
            // The most recent *error*, not the most recent run's error code.
            // Taking the latter hides a Pilot that fails half the time, because
            // whenever the newest run happens to succeed it reads as null.
            errors: {
              $push: {
                $cond: [{ $ifNull: ["$errorCode", false] }, "$errorCode", "$$REMOVE"],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            pilotId: "$_id.pilotId",
            version: "$_id.version",
            runs: 1,
            successes: 1,
            avgRecords: { $round: ["$avgRecords", 1] },
            successRate: { $divide: ["$successes", "$runs"] },
            lastRunAt: 1,
            lastError: { $ifNull: [{ $last: "$errors" }, null] },
          },
        },
        { $sort: { successRate: 1, lastRunAt: -1 } },
      ])
      .toArray();
    return rows as HealthSummary[];
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Run something against the registry and always hang up afterwards. */
export async function withRegistry<T>(
  env: PilotEnv,
  fn: (registry: Registry) => Promise<T>,
): Promise<T> {
  const registry = await Registry.connect(env);
  try {
    return await fn(registry);
  } finally {
    await registry.close();
  }
}
