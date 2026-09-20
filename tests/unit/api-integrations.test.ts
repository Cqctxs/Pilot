import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiIntegrationFor,
  apiReferenceNotes,
  credentialValues,
} from "../../src/integrations/apis.js";
import { PilotStore } from "../../src/pilots/store.js";
import { executePilot } from "../../src/runtime/execute.js";
import { loadEnv } from "../../src/shared/env.js";
import type { Pilot } from "../../src/shared/pilot.js";
import { runCreate } from "../../src/cli/create.js";
import { parseArgs } from "../../src/cli/args.js";

const changedEnvironment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string | undefined): void {
  if (!changedEnvironment.has(name)) changedEnvironment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of changedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  changedEnvironment.clear();
});

describe("official API integrations", () => {
  it("recognizes reviewed APIs and leaves unrelated sites alone", () => {
    expect(apiIntegrationFor("https://api.geoapify.com/v2/places")?.id).toBe("geoapify");
    expect(apiIntegrationFor("https://openlibrary.org/search.json?q=dune")?.credentials).toEqual([]);
    expect(apiIntegrationFor("https://books.toscrape.com/")).toBeNull();
  });

  it("names missing keys, signup location and the exact project .env path", () => {
    const integration = apiIntegrationFor("https://api.geoapify.com/v2/places")!;
    setEnvironment("GEOAPIFY_API_KEY", "");
    const projectRoot = mkdtempSync(path.join(tmpdir(), "pilot-api-prompt-"));
    try {
      expect(() => credentialValues(integration.credentials, { projectRoot })).toThrow(
        new RegExp(
          `GEOAPIFY_API_KEY[\\s\\S]*myprojects\\.geoapify\\.com[\\s\\S]*${escapeRegex(path.join(projectRoot, ".env"))}`,
        ),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("stops create with setup instructions before a compiler model is needed", async () => {
    setEnvironment("GEOAPIFY_API_KEY", "");
    const projectRoot = mkdtempSync(path.join(tmpdir(), "pilot-api-create-"));
    const env = {
      ...loadEnv(),
      projectRoot,
      pilotsDir: path.join(projectRoot, "pilots"),
      configFile: path.join(projectRoot, "config", "pilots.json"),
      lockFile: path.join(projectRoot, "pilot.lock.json"),
      capabilitiesDir: path.join(projectRoot, "config", "capabilities"),
      registryUri: null,
      openaiApiKey: null,
      compilerModel: null,
    };
    try {
      await expect(
        runCreate(
          env,
          parseArgs(["https://api.geoapify.com/v2/places", "--id", "geoapify-test"]),
        ),
      ).rejects.toThrow(
        new RegExp(`GEOAPIFY_API_KEY[\\s\\S]*${escapeRegex(path.join(projectRoot, ".env"))}`),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("passes configured values without putting the secret in compiler notes", () => {
    const integration = apiIntegrationFor("https://api.geoapify.com/v2/places")!;
    setEnvironment("GEOAPIFY_API_KEY", "super-secret-value");

    expect(credentialValues(integration.credentials, { projectRoot: "C:\\project" })).toEqual({
      GEOAPIFY_API_KEY: "super-secret-value",
    });
    const notes = apiReferenceNotes(integration);
    expect(notes.markdown).toContain("query.GEOAPIFY_API_KEY");
    expect(notes.markdown).not.toContain("super-secret-value");
  });

  it("injects required environment values at runtime without storing them", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "pilot-api-runtime-"));
    const env = {
      ...loadEnv(),
      projectRoot,
      pilotsDir: path.join(projectRoot, "pilots"),
      configFile: path.join(projectRoot, "config", "pilots.json"),
      lockFile: path.join(projectRoot, "pilot.lock.json"),
      capabilitiesDir: path.join(projectRoot, "config", "capabilities"),
    };
    const pilot: Pilot = {
      pilotFormatVersion: 2,
      id: "credential-test",
      version: "1.0.0",
      target: { name: "Credential Test", url: "https://api.example.test/items" },
      capability: null,
      capabilitySchemaVersion: null,
      schema: {
        name: "credential-test",
        fields: [{ name: "title", type: "string", required: true, description: "Title" }],
      },
      schemaExtensions: [],
      artifact: { kind: "script", entry: "extract.mjs", needsBrowser: false },
      credentials: [{
        env: "PILOT_TEST_SERVICE_KEY",
        description: "Test credential",
        signupUrl: "https://example.test/signup",
      }],
      discovered: [],
      origin: "handwritten",
      createdAt: new Date().toISOString(),
      compiler: null,
      evidence: {
        recordCount: 1,
        checkedAt: new Date().toISOString(),
        sampleFile: "sample.json",
        probe: { ran: false, readKeys: [], unreadKeys: [] },
      },
    };
    const code = `export async function search(_page, query) {
      if (typeof query.PILOT_TEST_SERVICE_KEY !== "string" || query.PILOT_TEST_SERVICE_KEY.length !== 14) {
        throw new Error("credential missing");
      }
      if (query.keywords === "fail") throw new Error("leaked=" + query.PILOT_TEST_SERVICE_KEY);
      return [{ title: "credential=" + query.PILOT_TEST_SERVICE_KEY }];
    }`;
    try {
      const store = new PilotStore(env);
      store.save(pilot, code);
      setEnvironment("PILOT_TEST_SERVICE_KEY", "runtime-secret");
      await expect(executePilot(store.get(pilot.id))).resolves.toEqual([
        { title: "credential=[REDACTED]" },
      ]);
      await expect(
        executePilot(store.get(pilot.id), { query: { keywords: "fail" } }),
      ).rejects.toThrow("leaked=[REDACTED]");

      setEnvironment("PILOT_TEST_SERVICE_KEY", undefined);
      await expect(executePilot(store.get(pilot.id))).rejects.toThrow(
        new RegExp(`PILOT_TEST_SERVICE_KEY[\\s\\S]*${escapeRegex(path.join(projectRoot, ".env"))}`),
      );
      expect(store.readScript(pilot.id)).not.toContain("runtime-secret");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
