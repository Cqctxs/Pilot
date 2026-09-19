import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findProjectRoot(
  start = fileURLToPath(new URL(".", import.meta.url)),
): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not find project root (package.json)");
    dir = parent;
  }
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
  /** Compiler only. Running a compiled Pilot never needs a key. */
  openaiApiKey: string | null;
  /** Model used to generate recipes. Required to compile, never to run. */
  compilerModel: string | null;
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
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    compilerModel: process.env.PILOT_COMPILER_MODEL?.trim() || null,
    testBoardPort,
    testBoardUrl: envString("PILOT_TESTBOARD_URL", `http://127.0.0.1:${testBoardPort}`),
    registryUri: process.env.PILOT_REGISTRY_URI?.trim() || null,
    registryDb: envString("PILOT_REGISTRY_DB", "pilot"),
    publisher: envString("PILOT_PUBLISHER", "anonymous"),
  };
}
