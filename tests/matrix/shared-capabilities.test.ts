/**
 * Product acceptance matrix: can a blank Pilot project discover one shared
 * capability per function type and compile two unrelated sites against it?
 *
 * This spends model credits and touches live public services. It is therefore
 * excluded from `npm test` and `npm run test:live`; run only with:
 *
 *   npm run test:matrix
 *
 * Set PILOT_MATRIX_CATEGORY=books (or jobs/quotes) for one pair, and
 * PILOT_MATRIX_KEEP=1 to retain the temporary project and its generated code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JOBS_CAPABILITY, JOBS_SCHEMA } from "../../src/capability/jobs.js";
import { CapabilityRegistry } from "../../src/capability/registry.js";
import { parseArgs } from "../../src/cli/args.js";
import { runCreate } from "../../src/cli/create.js";
import { PilotStore } from "../../src/pilots/store.js";
import { withRegistry } from "../../src/registry/client.js";
import { pilot as createSdk } from "../../src/sdk/index.js";
import { loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { SITE_MATRIX, type MatrixGroup, type MatrixSite } from "../fixtures/site-matrix.js";

const requestedCategory = process.env.PILOT_MATRIX_CATEGORY?.trim().toLowerCase() || null;
const selectedGroups = requestedCategory
  ? SITE_MATRIX.filter((group) => group.category === requestedCategory)
  : SITE_MATRIX;

if (requestedCategory && selectedGroups.length === 0) {
  throw new Error(
    `Unknown PILOT_MATRIX_CATEGORY=${requestedCategory}; use jobs, books or quotes.`,
  );
}

interface GroupReport {
  category: string;
  capability: string;
  pilots: Array<{
    id: string;
    url: string;
    version: string;
    transport: "browser" | "http";
    records: number;
    fields: string[];
    probe: unknown;
  }>;
  registryReuse?: {
    installedWithoutAi: boolean;
    records: number;
  };
}

const runTag = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const publisher = `pilot-matrix-${runTag}`;
let root: string;
let env: PilotEnv;
let registryEnv: PilotEnv;
let reuseEnv: PilotEnv;
const reports: GroupReport[] = [];
const published: Array<{ id: string; version: string }> = [];

beforeAll(async () => {
  const configured = loadEnv();
  if (!configured.openaiApiKey || !configured.compilerModel) {
    throw new Error("OPENAI_API_KEY and PILOT_COMPILER_MODEL are required for test:matrix");
  }
  if (!configured.registryUri) {
    throw new Error(
      "PILOT_REGISTRY_URI is required for test:matrix so registry reuse can be verified",
    );
  }

  const parent = process.env.PILOT_MATRIX_ROOT
    ? path.resolve(process.env.PILOT_MATRIX_ROOT)
    : tmpdir();
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(path.join(parent, "pilot-site-matrix-"));
  env = projectEnv(configured, root, {
    // Compilation starts isolated from the registry. This proves the first
    // phase really creates the artifacts that the second phase will reuse.
    registryUri: null,
    publisher,
  });
  registryEnv = {
    ...env,
    registryUri: configured.registryUri,
  };
  reuseEnv = projectEnv(configured, path.join(root, "reuse"), {
    // A successful create in this project is direct evidence that the exact
    // published script was installed without creating a model client.
    openaiApiKey: null,
    compilerModel: null,
    compilerEffort: null,
    publisher,
  });

  if (selectedGroups.some((group) => group.seedCapability === JOBS_CAPABILITY)) {
    new CapabilityRegistry(env).ensure(JOBS_CAPABILITY, JOBS_SCHEMA);
  }

  process.stdout.write(`\nPilot site-matrix workspace: ${root}\n`);
  for (const group of selectedGroups) {
    for (const site of group.sites) await preflight(site);
  }
}, 120_000);

afterAll(async () => {
  let cleanupFailure: unknown = null;
  try {
    await cleanupPublishedPilots();
  } catch (cause) {
    cleanupFailure = cause;
  }
  if (!root) {
    if (cleanupFailure) throw cleanupFailure;
    return;
  }
  const reportFile = path.join(root, "matrix-report.json");
  writeFileSync(reportFile, `${JSON.stringify(reports, null, 2)}\n`);
  process.stdout.write(`\nSite-matrix report: ${reportFile}\n`);
  if (process.env.PILOT_MATRIX_KEEP === "1") {
    process.stdout.write("Kept generated Pilots because PILOT_MATRIX_KEEP=1.\n");
  } else {
    rmSync(root, { recursive: true, force: true });
    process.stdout.write("Removed temporary matrix workspace.\n");
  }
  if (cleanupFailure) throw cleanupFailure;
});

function projectEnv(
  base: PilotEnv,
  projectRoot: string,
  overrides: Partial<PilotEnv>,
): PilotEnv {
  return {
    ...base,
    ...overrides,
    projectRoot,
    pilotsDir: path.join(projectRoot, "pilots"),
    configFile: path.join(projectRoot, "config", "pilots.json"),
    lockFile: path.join(projectRoot, "pilot.lock.json"),
    capabilitiesDir: path.join(projectRoot, "config", "capabilities"),
  };
}

function pilotId(site: MatrixSite): string {
  return `matrix-${runTag}-${site.id}`;
}

describe("automatic shared capabilities across public sites", () => {
  for (const group of selectedGroups) {
    it(`${group.category}: compiles two sites into one capability`, async () => {
      for (const site of group.sites) {
        const argv = [site.url, "--id", pilotId(site)];
        if (site.query) argv.push("--query", site.query);
        expect(await runCreate(env, parseArgs(argv))).toBe(0);
      }

      const store = new PilotStore(env);
      const loaded = group.sites.map((site) => store.get(pilotId(site)));
      const capabilities = new Set(loaded.map((item) => item.pilot.capability));
      expect(capabilities.size, `${group.category} created competing interfaces`).toBe(1);
      const capability = loaded[0]!.pilot.capability;
      expect(capability).not.toBeNull();
      if (group.seedCapability) expect(capability).toBe(group.seedCapability);
      for (const item of loaded) {
        expect(item.pilot.evidence.recordCount).toBeGreaterThan(0);
        expect(item.pilot.capability).toBe(capability);
      }
      for (const site of group.sites) {
        if (site.expectedTransport === "http") {
          expect(
            store.get(pilotId(site)).pilot.artifact.needsBrowser,
            `${site.name} should use its API rather than launch a browser`,
          ).toBe(false);
        }
      }

      await expectUnifiedRun(env, group, capability!);
      reports.push({
        category: group.category,
        capability: capability!,
        pilots: loaded.map((item) => ({
          id: item.pilot.id,
          url: item.pilot.target.url,
          version: item.pilot.version,
          transport: item.pilot.artifact.needsBrowser ? "browser" : "http",
          records: item.pilot.evidence.recordCount,
          fields: item.pilot.schema.fields.map((field) => field.name),
          probe: item.pilot.evidence.probe,
        })),
      });
    }, 900_000);
  }

  it("keeps different function types on different capabilities", () => {
    expect(new Set(reports.map((report) => report.capability)).size).toBe(reports.length);
  });

  it("publishes once, then installs and runs with AI disabled", async () => {
    const compiled = new PilotStore(env);
    const reuseCapabilities = new CapabilityRegistry(reuseEnv);
    for (const definition of new CapabilityRegistry(env).all()) {
      reuseCapabilities.save(definition);
    }

    try {
      await withRegistry(registryEnv, async (registry) => {
        for (const group of selectedGroups) {
          for (const site of group.sites) {
            const id = pilotId(site);
            const loaded = compiled.get(id);
            const entry = await registry.publish({
              pilot: loaded.pilot,
              code: compiled.readScript(id),
              sample: compiled.readSample(id),
            });
            published.push({ id: entry.pilotId, version: entry.version });
          }
        }
      });

      const writes: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        for (const group of selectedGroups) {
          for (const site of group.sites) {
            expect(
              await runCreate(reuseEnv, parseArgs([site.url, "--id", pilotId(site)])),
            ).toBe(0);
          }
        }
      } finally {
        write.mockRestore();
      }

      expect(writes.filter((line) => /no model call/i.test(line))).toHaveLength(
        selectedGroups.length * 2,
      );
      const installed = new PilotStore(reuseEnv);
      for (const group of selectedGroups) {
        for (const site of group.sites) {
          const id = pilotId(site);
          expect(installed.readScript(id)).toBe(compiled.readScript(id));
        }
        const report = reports.find((item) => item.category === group.category)!;
        report.registryReuse = {
          installedWithoutAi: true,
          records: await expectUnifiedRun(reuseEnv, group, report.capability),
        };
      }
    } finally {
      await cleanupPublishedPilots();
    }
  }, 900_000);
});

async function cleanupPublishedPilots(): Promise<void> {
  if (!registryEnv || published.length === 0) return;
  const failures: string[] = [];
  await withRegistry(registryEnv, async (registry) => {
    for (let index = published.length - 1; index >= 0; index -= 1) {
      const item = published[index]!;
      if (await registry.unpublish(item.id, item.version)) {
        published.splice(index, 1);
      } else {
        failures.push(`${item.id}@${item.version}`);
      }
    }
  });
  if (failures.length > 0) {
    throw new Error(
      `Could not remove matrix registry entries owned by ${publisher}: ${failures.join(", ")}`,
    );
  }
  process.stdout.write(`Removed this run's published Pilot entries from ${registryEnv.registryDb}.\n`);
}

async function preflight(site: MatrixSite): Promise<void> {
  const response = await fetch(site.url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "Pilot capability-matrix/0.1 (low-volume acceptance test)" },
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${site.name} preflight returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const expected = site.contentType === "json" ? "json" : "html";
  if (!contentType.includes(expected)) {
    throw new Error(`${site.name} returned ${contentType || "no content type"}; expected ${expected}`);
  }
}

async function expectUnifiedRun(
  matrixEnv: PilotEnv,
  group: MatrixGroup,
  capability: string,
): Promise<number> {
  const ids = group.sites.map(pilotId);
  const sdk = createSdk(matrixEnv);
  if (capability === JOBS_CAPABILITY) {
    const result = await sdk.capability(JOBS_CAPABILITY).search(
      ...ids,
      { keywords: group.sites[0].query, limit: 3 },
    );
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.ok)).toBe(true);
    expect(result.jobs.length).toBeGreaterThan(0);
    return result.jobs.length;
  }

  const result = await sdk.capability(capability).search(...ids, { limit: 3 });
  expect(result.sources).toHaveLength(2);
  expect(result.sources.every((source) => source.ok)).toBe(true);
  expect(result.records.length).toBeGreaterThan(0);
  return result.records.length;
}
