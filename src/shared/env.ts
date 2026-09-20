import { existsSync } from "node:fs";
import path from "node:path";

function nearestPackageRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project whose `pilots/`, `config/` and `.env` we should be using.
 *
 * This walks up from the working directory, not from this file. When Pilot is
 * installed as a dependency, its own location is `node_modules/pilot`, and
 * resolving against that sends a consumer's Pilots and capabilities into a
 * directory `npm install` deletes — so the SDK only worked from a clone, or
 * with PILOT_PILOTS_DIR and friends set by hand. The caller's project is the
 * right answer, and inside this repo the two are the same directory anyway.
 *
 * With nothing above the caller at all, the answer is the caller's own
 * directory. This used to fall back to the module's own root, which quietly
 * made an empty folder an alias for wherever Pilot happened to be installed:
 * `pilot init` in a new directory reported success having written `.mcp.json`
 * and `CLAUDE.md` into the Pilot clone, and `pilot install` put that folder's
 * Pilots there too. Nothing appeared where the person was standing and nothing
 * said why. A directory with no project markers is its own project — which is
 * wrong only in the harmless direction, since everything it creates is in
 * front of them.
 */
export function findProjectRoot(start = process.cwd()): string {
  return nearestPackageRoot(start) ?? path.resolve(start);
}

/** Whether a real project marker was found, as opposed to defaulting to `start`. */
export function hasProjectRoot(start = process.cwd()): boolean {
  return nearestPackageRoot(start) !== null;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be an integer port, received ${raw}`);
  }
  return parsed;
}

export interface PilotEnv {
  projectRoot: string;
  /** Where compiled Pilots live. */
  pilotsDir: string;
  /** Which Pilots are enabled, and their bound variables. */
  configFile: string;
  /** Exact registry versions required to reproduce this project's installed Pilots. */
  lockFile: string;
  /** Versioned shared schemas that Pilots of the same capability build on. */
  capabilitiesDir: string;
  /** Compiler only. Running a compiled Pilot never needs a key. */
  openaiApiKey: string | null;
  /** Model used to generate recipes. Required to compile, never to run. */
  compilerModel: string | null;
  /** Reasoning effort, passed through only when set. Not every model takes it. */
  compilerEffort: string | null;
  /** Local job board used for controlled end-to-end tests. */
  testBoardPort: number;
  testBoardUrl: string;
  /** Shared Pilot registry (MongoDB). Null when unset — everything else still works. */
  registryUri: string | null;
  registryDb: string;
  /** Recorded as the publisher of a Pilot and the reporter of health events. */
  publisher: string;
}

let envFileLoaded = false;

/** Load `.env` once, without overwriting anything already in the environment. */
function loadEnvFile(projectRoot: string): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const file = path.join(projectRoot, ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed .env should not stop a command that does not need it.
  }
}

export function loadEnv(): PilotEnv {
  const projectRoot = findProjectRoot();
  loadEnvFile(projectRoot);
  const testBoardPort = envPort("PILOT_TESTBOARD_PORT", 4100);
  return {
    projectRoot,
    pilotsDir: path.resolve(projectRoot, envString("PILOT_PILOTS_DIR", "pilots")),
    configFile: path.resolve(projectRoot, envString("PILOT_CONFIG", "config/pilots.json")),
    lockFile: path.resolve(projectRoot, envString("PILOT_LOCK_FILE", "pilot.lock.json")),
    capabilitiesDir: path.resolve(
      projectRoot,
      envString("PILOT_CAPABILITIES_DIR", "config/capabilities"),
    ),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    compilerModel: process.env.PILOT_COMPILER_MODEL?.trim() || null,
    compilerEffort: process.env.PILOT_COMPILER_EFFORT?.trim() || null,
    testBoardPort,
    testBoardUrl: envString("PILOT_TESTBOARD_URL", `http://127.0.0.1:${testBoardPort}`),
    registryUri: process.env.PILOT_REGISTRY_URI?.trim() || null,
    registryDb: envString("PILOT_REGISTRY_DB", "pilot"),
    publisher: envString("PILOT_PUBLISHER", "anonymous"),
  };
}
