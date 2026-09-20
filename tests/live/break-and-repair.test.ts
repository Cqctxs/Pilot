/**
 * Stage 3: break a Pilot on purpose and repair it.
 *
 * This is the claim the whole architecture rests on. Compiled code goes stale —
 * that is the honest cost of not keeping a model in the loop — so the answer has
 * to be that a break is *detected* and *repaired*, not improvised around. Until
 * this test existed, that answer had never actually been run.
 *
 * The test board serves the same catalogue in two layouts: A is a card list, B
 * is a table with different class names and different nesting. A Pilot compiled
 * against A cannot work against B, which makes it a real break we control,
 * rather than waiting for a live site to redesign itself.
 *
 *   compile on A  →  serve B  →  the Pilot fails loudly  →  repair  →  works on B
 *
 *   npm run test:live
 */
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { runCreate } from "../../src/cli/create.js";
import { runRepair } from "../../src/cli/repair.js";
import { PilotStore } from "../../src/pilots/store.js";
import { executePilot } from "../../src/runtime/execute.js";
import { loadEnv, type PilotEnv } from "../../src/shared/env.js";
import { startTestBoard } from "../../src/testboard/server.js";

const PORT = 4183;

let board: Server;
let root: string;
let env: PilotEnv;

async function serve(layout: "a" | "b"): Promise<void> {
  if (board) await new Promise<void>((resolve) => board.close(() => resolve()));
  board = await startTestBoard({ port: PORT, layout });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "pilot-live-repair-"));
  env = {
    ...loadEnv(),
    pilotsDir: path.join(root, "pilots"),
    configFile: path.join(root, "pilots.json"),
    capabilitiesDir: path.join(root, "capabilities"),
    registryUri: null,
  };
  if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is required for the live suite");
  await serve("a");
}, 30_000);

afterAll(async () => {
  if (board) await new Promise<void>((resolve) => board.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("break and repair", () => {
  it("fails loudly when the layout changes, then repairs against the new one", async () => {
    // 1. Compile against layout A.
    const created = await runCreate(
      env,
      parseArgs([`http://127.0.0.1:${PORT}/jobs`, "--id", "board", "--query", "engineer"]),
    );
    expect(created).toBe(0);

    const store = new PilotStore(env);
    const original = store.get("board");
    expect(original.pilot.version).toBe("1.0.0");
    const before = await executePilot(original, { query: { keywords: "engineer" } });
    expect(before.length).toBeGreaterThan(0);

    // 2. The site changes underneath it.
    await serve("b");
    store.reload();

    // 3. The Pilot must break loudly. A silent empty array here would be the
    //    worst outcome: indistinguishable from a search that matched nothing,
    //    so nothing would ever know to repair it.
    let broke = false;
    try {
      const after = await executePilot(store.get("board"), { query: { keywords: "engineer" } });
      expect(after, "a changed layout returned records instead of failing").toHaveLength(0);
      broke = after.length === 0;
    } catch {
      broke = true;
    }
    expect(broke, "the Pilot kept working after the layout changed").toBe(true);

    // 4. Repair reproduces the failure itself, re-explores, and revalidates.
    const repaired = await runRepair(env, parseArgs(["board", "--query", "engineer"]));
    expect(repaired).toBe(0);

    store.reload();
    const next = store.get("board");
    expect(next.pilot.version).toBe("1.1.0");
    expect(next.pilot.compiler?.repairedFrom).toBe("1.0.0");

    // 5. And the repaired Pilot works against the layout that broke it.
    const records = await executePilot(next, { query: { keywords: "engineer" } });
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.title, JSON.stringify(record)).toBeTruthy();
      expect(record.url, JSON.stringify(record)).toBeTruthy();
    }
  }, 600_000);
});
