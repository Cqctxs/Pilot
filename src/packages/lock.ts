import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PilotEnv } from "../shared/env.js";
import type { Pilot } from "../shared/pilot.js";
import { PILOT_ID_PATTERN, VERSION_PATTERN } from "../shared/pilot.js";

const lockEntrySchema = z.strictObject({
  id: z.string().regex(PILOT_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  capability: z.string().nullable(),
});

const lockFileSchema = z.strictObject({
  lockfileVersion: z.literal(1),
  pilots: z.array(lockEntrySchema),
});

export type PilotLockEntry = z.infer<typeof lockEntrySchema>;

/** Reproducible registry dependencies for one project. Safe to commit. */
export class PilotLock {
  constructor(private readonly env: PilotEnv) {}

  all(): PilotLockEntry[] {
    if (!existsSync(this.env.lockFile)) return [];
    return lockFileSchema.parse(JSON.parse(readFileSync(this.env.lockFile, "utf8"))).pilots;
  }

  set(pilot: Pilot): void {
    const entries = this.all().filter((entry) => entry.id !== pilot.id);
    entries.push({ id: pilot.id, version: pilot.version, capability: pilot.capability });
    this.write(entries);
  }

  remove(id: string): void {
    if (!existsSync(this.env.lockFile)) return;
    this.write(this.all().filter((entry) => entry.id !== id));
  }

  replace(pilots: readonly Pilot[]): void {
    this.write(
      pilots.map((pilot) => ({
        id: pilot.id,
        version: pilot.version,
        capability: pilot.capability,
      })),
    );
  }

  private write(entries: PilotLockEntry[]): void {
    const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
    mkdirSync(path.dirname(this.env.lockFile), { recursive: true });
    writeFileSync(
      this.env.lockFile,
      `${JSON.stringify({ lockfileVersion: 1, pilots: sorted }, null, 2)}\n`,
    );
  }
}
