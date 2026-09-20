/**
 * Does the compiler actually invent a usable capability schema?
 *
 * This is the one path in the project that had never run. `pilot create --
 * capability <new id>` with no `--fields` hands the model an empty draft and
 * asks it to propose the whole shape from what it finds on the site. Everything
 * downstream — promotion, `pilot fields`, the registry — assumes that produces
 * a real schema rather than a plausible-looking one, and nothing was checking.
 *
 * It costs a model call, so it lives here and not in the default suite:
 *
 *   npm run test:live
 *
 * The target is the local board, so the only thing being paid for is the model.
 */
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/capability/registry.js";
import { parseArgs } from "../../src/cli/args.js";
import { runCreate } from "../../src/cli/create.js";
import { PilotStore } from "../../src/pilots/store.js";
import { executePilot } from "../../src/runtime/execute.js";
import { loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { startTestBoard } from "../../src/testboard/server.js";

const CAPABILITY = "postings.board@1";

let board: Server;
let root: string;
let env: PilotEnv;
let base: string;

beforeAll(async () => {
  board = await startTestBoard({ port: 0, layout: "a" });
  const address = board.address();
  if (!address || typeof address === "string") throw new Error("Test board did not bind a port");
  base = `http://127.0.0.1:${address.port}`;

  root = mkdtempSync(path.join(tmpdir(), "pilot-live-capability-"));
  env = {
    ...loadEnv(),
    pilotsDir: path.join(root, "pilots"),
    configFile: path.join(root, "pilots.json"),
    capabilitiesDir: path.join(root, "capabilities"),
    registryUri: null,
  };
  if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is required for the live suite");
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => board?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("compiling against an undeclared capability", () => {
  it("proposes a schema, persists it, and extracts data that matches it", async () => {
    const code = await runCreate(
      env,
      parseArgs([`${base}/jobs`, "--capability", CAPABILITY, "--id", "board", "--query", "engineer"]),
    );
    expect(code).toBe(0);

    // 1. The capability now exists, seeded from what the model proposed.
    const definition = new CapabilityRegistry(env).get(CAPABILITY);
    expect(definition.version).toBe("1.0.0");
    expect(definition.schema.fields.length).toBeGreaterThanOrEqual(3);
    expect(definition.coreFields).toEqual(definition.schema.fields.map((field) => field.name));

    // 2. The fields are described, not just named. Descriptions are written into
    //    every future compile against this capability, so an echo of the field
    //    name is a silent quality loss rather than an error.
    for (const field of definition.schema.fields) {
      expect(field.description.trim().length).toBeGreaterThan(field.name.length);
    }

    // 3. At least one field is required. A schema of all-optional fields
    //    validates trivially and tells a caller nothing.
    expect(definition.schema.fields.some((field) => field.required)).toBe(true);

    // 4. The Pilot records which revision it compiled against.
    const loaded = new PilotStore(env).get("board");
    expect(loaded.pilot.capability).toBe(CAPABILITY);
    expect(loaded.pilot.capabilitySchemaVersion).toBe("1.0.0");

    // 5. The proposed schema describes data the site really has. This is the
    //    assertion that matters: a generated schema is only correct if running
    //    the Pilot fills it.
    const records = await executePilot(loaded, { query: { keywords: "engineer" } });
    expect(records.length).toBeGreaterThan(0);

    for (const field of definition.schema.fields.filter((item) => item.required)) {
      const filled = records.filter((record) => {
        const value = record[field.name];
        return value !== undefined && value !== null && String(value).trim() !== "";
      });
      expect(
        filled.length,
        `required field "${field.name}" was empty on every record`,
      ).toBe(records.length);
    }
  }, 300_000);
});
